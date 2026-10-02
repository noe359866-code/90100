/**
 * Tests del limitador de tasa adaptativo (penalty box ante 429/503)
 * y de la reacción de los clientes de API a los rate limits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, withRetry } from '../src/utils/async.js';
import { fetchJson } from '../src/utils/http.js';
import { createAniListClient } from '../src/apis/anilist.js';

test('fetchJson: un 429/503 agotado se marca como ERR_RATE_LIMITED', async () => {
  const stub = async () => ({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    headers: { get: () => null },
    text: async () => '{}',
  });
  await assert.rejects(
    () => withFetch(stub, () => fetchJson('https://example.com/api', { retries: 0 })),
    (err) => err.code === 'ERR_RATE_LIMITED' && err.status === 429,
    'el llamador debe poder distinguirlo de un error normal (sin quemar ids_attempts)',
  );
});

test('withRetry: minWaitMs fija la espera mínima entre reintentos', async () => {
  const t0 = Date.now();
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 2) throw new Error('transitorio');
      return 'ok';
    },
    { retries: 2, baseMs: 1, shouldRetry: () => true, minWaitMs: 150 },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.ok(Date.now() - t0 >= 150, `el reintento debe esperar al menos minWaitMs (tardó ${Date.now() - t0}ms)`);
});

test('withRetry: minWaitMs acepta una función (cooldown evaluado en el momento)', async () => {
  let cooldown = 120;
  const t0 = Date.now();
  await withRetry(
    async () => {
      if (cooldown > 0) throw new Error('transitorio');
      return 'ok';
    },
    {
      retries: 3,
      baseMs: 1,
      shouldRetry: () => true,
      minWaitMs: () => {
        const ms = cooldown;
        cooldown = 0; // el penalty box expira durante la espera
        return ms;
      },
    },
  );
  assert.ok(Date.now() - t0 >= 113, `debe respetar el cooldown del penalty box (tardó ${Date.now() - t0}ms)`);
});

test('withRetry: vuelve a validar el circuit breaker tras el backoff', async () => {
  let allowed = true;
  let calls = 0;
  const task = withRetry(
    async () => {
      calls += 1;
      throw new Error('transitorio');
    },
    {
      retries: 3,
      baseMs: 20,
      maxMs: 20,
      shouldRetry: () => allowed,
    },
  );
  setTimeout(() => { allowed = false; }, 5);

  await assert.rejects(task, /transitorio/);
  assert.equal(calls, 1, 'no se debe intentar otra vez si el interruptor abrió durante la espera');
});

test('rateLimiter: respeta el máximo por ventana', async () => {
  const limiter = createRateLimiter({ maxRequests: 2, perMs: 300 });
  const t0 = Date.now();
  await Promise.all([limiter(() => {}), limiter(() => {}), limiter(() => {})]);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 250, `tres peticiones con máx 2/300ms deberían tardar ~300ms (tardaron ${elapsed}ms)`);
  assert.equal(limiter.stats().rate, 2);
  assert.equal(limiter.stats().throttles, 0);
  assert.equal(limiter.stats().cooldownMs, 0);
});

test('rateLimiter: reportThrottle congela y degrada la tasa', async () => {
  const limiter = createRateLimiter({ maxRequests: 10, perMs: 60_000, minRequests: 2, baseCooldownMs: 400, name: 'Test' });

  limiter.reportThrottle(0); // 429 sin Retry-After → pausa base
  assert.equal(limiter.stats().rate, 5, 'la tasa debe bajar a la mitad');
  assert.ok(limiter.stats().cooldownMs > 0, 'debe haber cooldown activo');

  const t0 = Date.now();
  await limiter(() => {});
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 300, `la petición debe esperar el cooldown (esperó ${elapsed}ms)`);
  assert.equal(limiter.stats().throttles, 1);
});

test('rateLimiter: la penalización crece con 429 consecutivos', async () => {
  const limiter = createRateLimiter({ maxRequests: 8, perMs: 60_000, minRequests: 1, baseCooldownMs: 50, maxCooldownMs: 400 });

  limiter.reportThrottle(0);
  const first = limiter.stats().cooldownMs;
  limiter.reportThrottle(0);
  limiter.reportThrottle(0);
  const third = limiter.stats().cooldownMs;

  assert.ok(third > first, `el cooldown debe crecer (${first} → ${third})`);
  assert.equal(limiter.stats().rate, 1, 'con 3 penalizaciones debe tocar el suelo configurado');
});

test('rateLimiter: respeta el Retry-After del servidor', async () => {
  const limiter = createRateLimiter({ maxRequests: 4, perMs: 60_000, baseCooldownMs: 10 });
  limiter.reportThrottle(60_000);
  const stats = limiter.stats();
  assert.ok(stats.cooldownMs > 50_000 && stats.cooldownMs <= 60_000, `debe usar el Retry-After (${stats.cooldownMs}ms)`);
});

test('rateLimiter: la tasa se recupera tras una ventana sin 429', async () => {
  const limiter = createRateLimiter({ maxRequests: 8, perMs: 120, minRequests: 1, baseCooldownMs: 10 });
  limiter.reportThrottle(0);
  assert.equal(limiter.stats().rate, 4);

  await new Promise((r) => setTimeout(r, 150)); // una ventana completa en calma
  await limiter(() => {});
  assert.equal(limiter.stats().rate, 6, 'la tasa se recupera de forma gradual (+25% por ventana)');

  await new Promise((r) => setTimeout(r, 150)); // otra ventana en calma
  await limiter(() => {});
  assert.equal(limiter.stats().rate, 8, 'la tasa debe volver al máximo');
  assert.equal(limiter.stats().throttles, 1, 'el contador histórico se mantiene');
});

test('rateLimiter: interruptor tras N 429 consecutivos (falla rápido y se recupera solo)', async () => {
  const limiter = createRateLimiter({
    maxRequests: 4,
    perMs: 60_000,
    baseCooldownMs: 10,
    maxConsecutiveThrottles: 3,
    disableMs: 250,
    name: 'Test',
  });

  for (let i = 0; i < 3; i += 1) limiter.reportThrottle(0);
  assert.equal(limiter.stats().disabled, true);

  await assert.rejects(() => limiter(() => {}), (err) => err.code === 'ERR_RATE_LIMITED');

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(limiter.stats().disabled, false, 'el interruptor se rearma solo');
  await limiter(() => {});
});

test('rateLimiter: el interruptor también detiene peticiones que ya estaban en cola', async () => {
  const limiter = createRateLimiter({
    maxRequests: 1,
    perMs: 80,
    baseCooldownMs: 10,
    maxConsecutiveThrottles: 1,
    disableMs: 250,
    name: 'Test',
  });
  let ran = false;
  await limiter(() => 'primera'); // consume el único cupo de la ventana
  const queued = limiter(() => { ran = true; });
  // Da tiempo a la segunda llamada para entrar en acquire() y esperar la ventana.
  await new Promise((r) => setTimeout(r, 10));
  limiter.reportThrottle(0); // abre el interruptor mientras estaba en espera

  await assert.rejects(queued, (err) => err.code === 'ERR_RATE_LIMITED');
  assert.equal(ran, false, 'la petición encolada no debe salir después del cooldown');
});

const withFetch = async (stub, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

const jsonResponse = (payload) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  headers: { get: () => null },
  text: async () => JSON.stringify(payload),
});

const errorResponse = (status, retryAfter = null) => ({
  ok: false,
  status,
  statusText: status === 429 ? 'Too Many Requests' : 'Bad Request',
  headers: { get: (h) => (h === 'retry-after' && retryAfter !== null ? String(retryAfter) : null) },
  text: async () => JSON.stringify({ errors: [{ message: 'rate limited' }] }),
});

test('anilist: un 429 dispara el penalty box y el reintento acaba funcionando', async () => {
  let calls = 0;
  const client = createAniListClient({ requestsPerMinute: 60, cooldownMs: 30 });

  const media = await withFetch(async () => {
    calls += 1;
    return calls === 1 ? errorResponse(429, 0) : jsonResponse({ data: { Page: { media: [{ id: 7, idMal: 7, seasonYear: 2023, title: { romaji: 'Test' } }] } } });
  }, () => client.findBest(['Test'], { minSimilarity: 0.6 }));

  assert.equal(media.anilist_id, 7);
  assert.ok(calls >= 2, 'debe reintentar tras el 429');
  assert.equal(client.stats().throttles, 1, 'el 429 debe quedar registrado');
});

test('anilist: una petición fallida no se cachea (se puede reintentar después)', async () => {
  let calls = 0;
  const client = createAniListClient({ requestsPerMinute: 60, cooldownMs: 30 });

  // 400 no es transitorio: falla sin reintentos
  await assert.rejects(() => withFetch(async () => {
    calls += 1;
    return calls === 1 ? errorResponse(400) : jsonResponse({ data: { Page: { media: [{ id: 9, idMal: 9, title: { romaji: 'Test' } }] } } });
  }, () => client.search('Test')), /HTTP 400/);

  // La caché no debe conservar el fallo: la segunda búsqueda sí funciona
  const media = await withFetch(async () => {
    calls += 1;
    return jsonResponse({ data: { Page: { media: [{ id: 9, idMal: 9, title: { romaji: 'Test' } }] } } });
  }, () => client.search('Test'));
  assert.equal(media[0].id, 9);
  assert.equal(calls, 2);
});

test('anilist: las búsquedas repetidas se sirven de caché', async () => {
  let calls = 0;
  const client = createAniListClient({ requestsPerMinute: 60 });
  const stub = async () => {
    calls += 1;
    return jsonResponse({ data: { Page: { media: [] } } });
  };

  await withFetch(stub, async () => {
    await client.search('Frieren');
    await client.search('Frieren');
    await client.search('frieren'); // normalizado a minúsculas
  });
  assert.equal(calls, 1);
});

test('anilist: el interruptor abierto impide reintentos HTTP y variantes posteriores', async () => {
  let calls = 0;
  const client = createAniListClient({
    requestsPerMinute: 60,
    cooldownMs: 10,
    maxConsecutiveThrottles: 1,
    disableMs: 5_000,
  });

  // El primer 429 abre el interruptor; ni el reintento interno ni las variantes
  // siguientes deben emitir nuevas peticiones durante la pausa.
  await assert.rejects(
    () => withFetch(async () => {
      calls += 1;
      return errorResponse(429, 0);
    }, () => client.search('A')),
    (err) => err.code === 'ERR_RATE_LIMITED',
  );
  assert.equal(calls, 1, 'no debe reintentar HTTP con el interruptor abierto');
  assert.equal(client.stats().disabled, true);

  await assert.rejects(
    () => withFetch(async () => jsonResponse({ data: { Page: { media: [] } } }), () => client.findBest(['B1', 'B2'])),
    (err) => err.code === 'ERR_RATE_LIMITED',
  );
  assert.equal(calls, 1, 'no debe lanzar peticiones adicionales con el interruptor abierto');
});
