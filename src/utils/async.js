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
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Limitador de tasa tipo "ventana deslizante": como máximo `maxRequests`
 * dentro de cualquier intervalo de `perMs` milisegundos. Las adquisiciones se
 * serializan para que múltiples llamadores concurrentes no lo desborden.
 */
export function createRateLimiter({ maxRequests, perMs }) {
  const timestamps = [];
  let queue = Promise.resolve();

  const acquire = () => {
    const p = queue.then(async () => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const now = Date.now();
        while (timestamps.length && now - timestamps[0] >= perMs) timestamps.shift();
        if (timestamps.length < maxRequests) {
          timestamps.push(Date.now());
          return;
        }
        await sleep(perMs - (now - timestamps[0]) + 10);
      }
    });
    queue = p.catch(() => {});
    return p;
  };

  return async function schedule(fn) {
    await acquire();
    return fn();
  };
}

/**
 * Reintentos con backoff exponencial + jitter.
 * `shouldRetry(err)` decide si un error es transitorio.
 */
export async function withRetry(fn, { retries = 4, baseMs = 500, maxMs = 15000, shouldRetry = () => true, onRetry } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;
      const retryAfter = err?.retryAfterMs;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt) * (0.7 + Math.random() * 0.6);
      const wait = Math.max(retryAfter || 0, backoff);
      onRetry?.(err, attempt + 1, wait);
      await sleep(wait);
      attempt += 1;
    }
  }
}
