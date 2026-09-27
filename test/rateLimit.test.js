/**
 * Tests del limitador de tasa adaptativo (penalty box ante 429/503)
 * y de la reacción de los clientes de API a los rate limits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/utils/async.js';
import { createAniListClient } from '../src/apis/anilist.js';

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

test('anilist: con el interruptor abierto falla rápido y no prueba más variantes', async () => {
  let calls = 0;
  const client = createAniListClient({
    requestsPerMinute: 60,
    cooldownMs: 10,
    maxConsecutiveThrottles: 1,
    disableMs: 5_000,
  });

  // 1ª búsqueda: un 429 y después OK → esto abre el interruptor
  await withFetch(async () => {
    calls += 1;
    return calls === 1 ? errorResponse(429, 0) : jsonResponse({ data: { Page: { media: [] } } });
  }, () => client.search('A'));

  assert.equal(client.stats().disabled, true);

  // 2ª búsqueda con dos variantes: debe fallar rápido, sin gastar más peticiones
  await assert.rejects(
    () => withFetch(async () => jsonResponse({ data: { Page: { media: [] } } }), () => client.findBest(['B1', 'B2'])),
    (err) => err.code === 'ERR_RATE_LIMITED',
  );
  assert.equal(calls, 2, 'no debe lanzar más peticiones con el interruptor abierto');
});
