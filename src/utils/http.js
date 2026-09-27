/**
 * `fetch` con timeout, reintentos y respeto de `Retry-After` (429/503).
 * Usa el `fetch` nativo de Node ≥ 18.
 */
import { withRetry } from './async.js';

export class HttpError extends Error {
  constructor(message, { status, url, body, retryAfterMs } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

const isTransientHttp = (err) => {
  // El interruptor del limitador no se reintenta: reintentar sólo alarga el bloqueo.
  if (err?.code === 'ERR_RATE_LIMITED') return false;
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500 || err.status === 408;
  // Errores de red / abort (timeout)
  return true;
};

/** Quita credenciales de una URL antes de loguearla (api_key de TMDB v3, etc.). */
export function redactUrl(url) {
  return String(url).replace(/([?&](?:api_key|apikey|token|access_token)=)[^&\s]+/gi, '$1***');
}

const parseRetryAfter = (headerValue) => {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(headerValue);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
};

/**
 * Realiza una petición y devuelve el JSON parseado.
 * @param {string} url
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.headers]
 * @param {any}    [options.body]   Se serializa a JSON si es objeto.
 * @param {number} [options.timeoutMs]
 * @param {number} [options.retries]
 * @param {(err: Error, attempt: number, waitMs: number) => void} [options.onRetry]
 * @param {(err: HttpError) => void} [options.onThrottle] se llama en cada 429/503, antes de reintentar
 */
export async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 15000, retries = 3, onRetry, onThrottle } = {}) {
  // Un mismo 429 reintentado no debe contar como varios incidentes: si no, los
  // reintentos de UNA petición disparan el interruptor (4 rechazos seguidos).
  let reportedThrottle = false;
  return withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers: {
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
          body: body !== undefined && typeof body !== 'string' ? JSON.stringify(body) : body,
          signal: controller.signal,
        });

        const text = await res.text();
        let json = null;
        if (text) {
          try { json = JSON.parse(text); } catch { json = null; }
        }

        if (!res.ok) {
          const err = new HttpError(`HTTP ${res.status} ${res.statusText} → ${redactUrl(url)}`, {
            status: res.status,
            url: redactUrl(url),
            body: json ?? text?.slice(0, 300),
            retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
          });
          // Avisamos al limitador de tasa para que congela el cliente y baje el ritmo
          if ((res.status === 429 || res.status === 503) && onThrottle && !reportedThrottle) {
            reportedThrottle = true;
            onThrottle(err);
          }
          throw err;
        }
        return json;
      } finally {
        clearTimeout(timer);
      }
    },
    { retries, shouldRetry: isTransientHttp, onRetry },
  );
}
