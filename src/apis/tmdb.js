/**
 * Cliente TMDB (requiere `TMDB_API_KEY`).
 * Acepta tanto la API key v3 (query `api_key`) como el token de lectura v4 (Bearer).
 */
import { fetchJson } from '../utils/http.js';
import { createRateLimiter } from '../utils/async.js';
import { bestSimilarity } from '../utils/text.js';

const BASE = 'https://api.themoviedb.org/3';

/**
 * Clasifica una credencial de TMDB.
 * @returns {'v3'|'v4'|null} `v3` = API key clásica, `v4` = token de lectura (JWT), `null` = vacía.
 */
export function tmdbKeyKind(apiKey) {
  const key = String(apiKey ?? '').trim();
  if (!key) return null;
  if (key.startsWith('eyJ') || key.length > 40) return 'v4';
  return 'v3';
}

/**
 * Comprueba la credencial contra TMDB con una llamada barata (`/authentication`).
 * Nunca lanza: devuelve un diagnóstico listo para loguear.
 * @returns {Promise<{ok:boolean, status:number|null, kind:'v3'|'v4'|null, message:string}>}
 */
export async function validateTmdbKey(apiKey, { timeoutMs = 10000 } = {}) {
  const kind = tmdbKeyKind(apiKey);
  const key = String(apiKey ?? '').trim();
  if (!kind) return { ok: false, status: null, kind: null, message: 'TMDB_API_KEY está vacía' };

  const url = new URL(`${BASE}/authentication`);
  if (kind === 'v3') url.searchParams.set('api_key', key);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...(kind === 'v4' ? { Authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true, status: res.status, kind, message: 'credencial aceptada por TMDB' };
    const body = await res.text().catch(() => '');
    const hint = res.status === 401 ? ' — key inválida, revocada o mal copiada' : '';
    return { ok: false, status: res.status, kind, message: `HTTP ${res.status} ${res.statusText}${hint}${body ? ` (${body.slice(0, 200)})` : ''}` };
  } catch (err) {
    return { ok: false, status: null, kind, message: `error de red comprobando la key: ${err.message}` };
  }
}

export function createTmdbClient({ apiKey, requestsPerSecond = 20, log } = {}) {
  const key = String(apiKey ?? '').trim();
  if (!key) return null;
  const isBearer = tmdbKeyKind(key) === 'v4';
  const limiter = createRateLimiter({ maxRequests: requestsPerSecond, perMs: 1000 });
  const cache = new Map();

  const get = (path, params = {}) => {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    if (!isBearer) url.searchParams.set('api_key', key);
    const cacheKey = url.toString();
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const p = limiter(() =>
      fetchJson(cacheKey, {
        headers: isBearer ? { Authorization: `Bearer ${key}` } : {},
        timeoutMs: 15000,
        retries: 3,
        onRetry: (err, attempt, wait) => log?.warn(`TMDB: reintento ${attempt} (${Math.round(wait)}ms) → ${err.message}`),
      }),
    );
    cache.set(key, p);
    return p;
  };

  /**
   * Busca una película o serie.
   * @param {'movie'|'tv'} kind
   * @param {string[]} variants
   * @param {{ year?: number|null, minSimilarity?: number, language?: string }} opts
   * @returns {Promise<{ tmdb_id:number, kind:'movie'|'tv', title:string, year:number|null, score:number }|null>}
   */
  async function findBest(kind, variants, { year = null, minSimilarity = 0.6 } = {}) {
    const path = kind === 'movie' ? '/search/movie' : '/search/tv';
    const yearParam = kind === 'movie' ? 'primary_release_year' : 'first_air_date_year';

    // Con año: primero búsqueda acotada; si no hay resultados, sin año.
    const attempts = [];
    for (const v of variants) {
      if (year) attempts.push({ query: v, year });
      attempts.push({ query: v, year: null });
    }

    for (const attempt of attempts) {
      let json;
      try {
        json = await get(path, { query: attempt.query, include_adult: 'false', [yearParam]: attempt.year ?? undefined });
      } catch (err) {
        log?.warn(`TMDB: fallo buscando "${attempt.query}": ${err.message}`);
        continue;
      }
      let best = null;
      for (const r of json?.results || []) {
        const titles = kind === 'movie' ? [r.title, r.original_title] : [r.name, r.original_name];
        const dateStr = kind === 'movie' ? r.release_date : r.first_air_date;
        const rYear = dateStr ? Number(dateStr.slice(0, 4)) : null;
        let score = bestSimilarity(attempt.query, titles);
        if (year && rYear) {
          if (Math.abs(rYear - year) <= 1) score += 0.1;
          else if (Math.abs(rYear - year) > 2) score -= 0.2;
        }
        // Ligero bonus por popularidad para desempatar remakes/homónimos
        score += Math.min(0.05, (r.popularity || 0) / 2000);
        if (!best || score > best.score) best = { r, score, title: titles[0], year: rYear };
      }
      if (best && best.score >= minSimilarity) {
        return { tmdb_id: best.r.id, kind, title: best.title, year: best.year, score: Math.min(1, best.score) };
      }
    }
    return null;
  }

  /** Devuelve `{ imdb_id, tvdb_id }` de una obra TMDB. */
  async function externalIds(kind, tmdbId) {
    try {
      const json = await get(`/${kind === 'movie' ? 'movie' : 'tv'}/${tmdbId}/external_ids`);
      return { imdb_id: json?.imdb_id || null, tvdb_id: json?.tvdb_id || null };
    } catch (err) {
      log?.warn(`TMDB: fallo en external_ids ${kind}/${tmdbId}: ${err.message}`);
      return { imdb_id: null, tvdb_id: null };
    }
  }

  return { findBest, externalIds };
}
