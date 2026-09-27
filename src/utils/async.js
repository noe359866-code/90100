/**
 * Utilidades asíncronas y de colecciones sin dependencias externas.
 */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Parte un array en trozos de tamaño `size`. */
export function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

/**
 * Ejecuta `fn(item, index)` sobre `items` con un máximo de `limit` promesas
 * simultáneas. Devuelve los resultados en el mismo orden que la entrada.
 * Los errores se propagan (rechaza la primera que falle).
 */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  if (!items.length) return results;
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit || 1, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const unitLabel = (ms) => (ms % 60_000 === 0 ? `${ms / 60_000}min` : `${ms / 1000}s`);

/**
 * Limitador de tasa adaptativo con "penalty box" para HTTP 429/503.
 *
 * Dos mecanismos:
 *  1. Ventana deslizante: como máximo `maxRequests` en cualquier intervalo de
 *     `perMs`. Las adquisiciones se serializan, así que varios llamadores
 *     concurrentes no desbordan el límite.
 *  2. Penalización por 429: cuando el servidor se satura, `reportThrottle()`
 *     congela TODAS las peticiones del cliente durante el `Retry-After` (o un
 *     backoff exponencial creciente) y reduce la tasa a la mitad. Si pasa un
 *     periodo completo sin 429, la tasa se recupera poco a poco.
 *  3. Interruptor: si los 429 son consecutivos (`maxConsecutiveThrottles`), el
 *     cliente se apaga `disableMs` y falla rápido en vez de esperar reintentos
 *     que sólo empeoran el bloqueo (típico de AniList contra IPs de GitHub Actions).
 *
 * Esto es imprescindible con AniList desde GitHub Actions: las IPs de los
 * runners están muy usadas y AniList responde 429 con `Retry-After: 60` en
 * cuanto te pasas de ritmo. Sin penalty box, cada worker reintenta por su
 * cuenta y la ráfaga de reintentos empeora el bloqueo.
 *
 * @param {object} opts
 * @param {number} opts.maxRequests   peticiones permitidas por ventana
 * @param {number} [opts.perMs]       tamaño de la ventana (60000 = por minuto)
 * @param {number} [opts.minRequests] tasa mínima a la que se puede degradar
 * @param {number} [opts.baseCooldownMs] pausa mínima tras el primer 429
 * @param {number} [opts.maxCooldownMs]  pausa máxima (penalización exponencial)
 * @param {string} [opts.name]        etiqueta para los logs
 * @returns {function(Function): Promise<any> & { reportThrottle:Function, reportSuccess:Function, stats:Function }}
 */
export function createRateLimiter({
  maxRequests,
  perMs = 60_000,
  minRequests = 1,
  baseCooldownMs = 5_000,
  maxCooldownMs = 300_000,
  maxConsecutiveThrottles = 4,
  disableMs = 600_000,
  name = 'API',
  log,
} = {}) {
  const timestamps = [];
  let queue = Promise.resolve();
  let blockedUntil = 0;
  let currentMax = Math.max(1, maxRequests);
  const floor = Math.max(1, Math.min(minRequests, maxRequests));
  let consecutiveThrottles = 0;
  let lastThrottleAt = 0;
  let throttleCount = 0;
  let disabledUntil = 0;

  const acquire = () => {
    const p = queue.then(async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const now = Date.now();

        // Si ha pasado una ventana completa sin 429, recuperamos tasa poco a poco
        if (lastThrottleAt > 0 && currentMax < maxRequests && now - lastThrottleAt >= perMs) {
          consecutiveThrottles = 0;
          lastThrottleAt = now;
          currentMax = Math.min(maxRequests, currentMax + Math.max(1, Math.ceil(maxRequests * 0.25)));
          log?.debug(`${name}: ventana sin 429 → tasa recuperada a ${currentMax} req/${unitLabel(perMs)}`);
        }

        while (timestamps.length && now - timestamps[0] >= perMs) timestamps.shift();

        const windowWait = timestamps.length >= currentMax ? perMs - (now - timestamps[0]) + 10 : 0;
        const cooldownWait = Math.max(0, blockedUntil - now);
        const wait = Math.max(windowWait, cooldownWait);
        if (wait <= 0) {
          timestamps.push(Date.now());
          return;
        }
        await sleep(wait);
      }
    });
    queue = p.catch(() => {});
    return p;
  };

  const schedule = async (fn) => {
    if (Date.now() < disabledUntil) {
      const err = new Error(`${name}: en pausa por rate limit hasta las ${new Date(disabledUntil).toISOString()}`);
      err.code = 'ERR_RATE_LIMITED';
      throw err;
    }
    await acquire();
    return fn();
  };

  /**
   * Registra un 429/503: congela el cliente y degrada la tasa.
   * @param {number} [retryAfterMs] lo que el servidor pide en `Retry-After`
   */
  schedule.reportThrottle = (retryAfterMs = 0) => {
    const now = Date.now();
    lastThrottleAt = now;
    consecutiveThrottles += 1;
    throttleCount += 1;
    const cooldown = Math.min(maxCooldownMs, Math.max(retryAfterMs || 0, baseCooldownMs * 2 ** (consecutiveThrottles - 1)));
    blockedUntil = Math.max(blockedUntil, now + cooldown);
    const before = currentMax;
    currentMax = Math.max(floor, Math.floor(currentMax / 2));
    const detail = before !== currentMax ? ` y tasa reducida a ${currentMax} req/${unitLabel(perMs)}` : '';
    log?.warn(`${name}: servidor saturado (429) → pausa de ${Math.ceil(cooldown / 1000)}s${detail}`);
    if (consecutiveThrottles >= maxConsecutiveThrottles) {
      disabledUntil = Math.max(disabledUntil, now + disableMs);
      log?.warn(`${name}: ${consecutiveThrottles} rechazos seguidos → se detienen las consultas ${Math.round(disableMs / 60000)}min para no empeorar el bloqueo`);
    }
  };

  /** Una petición ha ido bien: reinicia el contador de penalizaciones. */
  schedule.reportSuccess = () => {
    consecutiveThrottles = 0;
  };

  schedule.stats = () => ({
    rate: currentMax,
    maxRate: maxRequests,
    throttles: throttleCount,
    cooldownMs: Math.max(0, blockedUntil - Date.now()),
    disabled: Date.now() < disabledUntil,
    windowUsed: timestamps.length,
  });

  return schedule;
}

/**
 * Reintentos con backoff exponencial + jitter.
 * `shouldRetry(err)` decide si un error es transitorio.
 * `minWaitMs` (número o función) fija una espera mínima adicional — p. ej. el
 * cooldown del penalty box del limitador, para que un reintento no salga antes
 * de que el servidor se haya "enfriado" (reintentar pronto sólo empeora el 429).
 */
export async function withRetry(fn, { retries = 4, baseMs = 500, maxMs = 15000, shouldRetry = () => true, onRetry, minWaitMs } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;
      const retryAfter = err?.retryAfterMs;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt) * (0.7 + Math.random() * 0.6);
      const floor = typeof minWaitMs === 'function' ? minWaitMs() : minWaitMs;
      const wait = Math.max(retryAfter || 0, backoff, floor || 0);
      onRetry?.(err, attempt + 1, wait);
      await sleep(wait);
      attempt += 1;
    }
  }
}
