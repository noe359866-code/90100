/**
 * Cliente TMDB (requiere `TMDB_API_KEY`).
 * Acepta tanto la API key v3 (query `api_key`) como el token de lectura v4 (Bearer).
 */
import { fetchJson } from '../utils/http.js';
import { createRateLimiter } from '../utils/async.js';
import { adjustTitleScore, bestSimilarity } from '../utils/text.js';

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

export function createTmdbClient({ apiKey, requestsPerSecond = 20, cooldownMs, maxConsecutiveThrottles, disableMs, log } = {}) {
  const key = String(apiKey ?? '').trim();
  if (!key) return null;
  const isBearer = tmdbKeyKind(key) === 'v4';
  const limiter = createRateLimiter({ maxRequests: requestsPerSecond, perMs: 1000, name: 'TMDB', baseCooldownMs: cooldownMs, maxConsecutiveThrottles, disableMs, log });
  const cache = new Map();

  const get = (path, params = {}) => {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    if (!isBearer) url.searchParams.set('api_key', key);
    const cacheKey = url.toString();
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const promise = limiter(() =>
      fetchJson(cacheKey, {
        headers: isBearer ? { Authorization: `Bearer ${key}` } : {},
        timeoutMs: 15000,
        retries: 3,
        onThrottle: (err) => limiter.reportThrottle?.(err.retryAfterMs),
        minWaitMs: () => limiter.stats().cooldownMs,
        onRetry: (err, attempt, wait) => log?.warn(`TMDB: reintento ${attempt} (${Math.round(wait)}ms) → ${err.message}`),
      }),
    ).then(
      (json) => {
        limiter.reportSuccess?.();
        return json;
      },
      // Un fallo NO se cachea (mismo razonamiento que en AniList/Kitsu).
      (err) => {
        cache.delete(cacheKey);
        throw err;
      },
    );
    cache.set(cacheKey, promise);
    promise.catch(() => {});
    return promise;
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

    // Primero todas las variantes CON año (la más específica antes). Si no, sin año.
    // Antes se intercalaba la búsqueda libre de la variante 1 y podía aceptar un
    // homónimo antes de probar "Título 2nd Season" acotado por año.
    const attempts = [];
    if (year) for (const v of variants) attempts.push({ query: v, year });
    for (const v of variants) attempts.push({ query: v, year: null });

    for (const attempt of attempts) {
      let json;
      try {
        json = await get(path, { query: attempt.query, include_adult: 'false', [yearParam]: attempt.year ?? undefined });
      } catch (err) {
        if (err?.code === 'ERR_RATE_LIMITED') throw err;
        log?.warn(`TMDB: fallo buscando "${attempt.query}": ${err.message}`);
        continue;
      }
      let best = null;
      for (const r of json?.results || []) {
        const titles = kind === 'movie' ? [r.title, r.original_title] : [r.name, r.original_name];
        const dateStr = kind === 'movie' ? r.release_date : r.first_air_date;
        const rYear = dateStr ? Number(dateStr.slice(0, 4)) : null;
        let score = bestSimilarity(attempt.query, titles);
        score += Math.min(0.05, (r.popularity || 0) / 2000);
        score = adjustTitleScore(score, attempt.query, titles, {
          year, itemYear: rYear, yearWindow: 2, yearPenalty: 0.2, yearBonus: 0.1,
        });
        if (!best || score > best.score) best = { r, score, title: titles[0], year: rYear };
      }
      if (best && best.score >= minSimilarity) {
        return { tmdb_id: best.r.id, kind, title: best.title, year: best.year, score: Math.min(1, best.score) };
      }
    }
    return null;
  }

  /**
   * Resuelve una obra a partir de su `imdb_id` (`/find`). Es una referencia
   * EXACTA: una sola llamada que no depende del idioma del título ni del año, y
   * evita la búsqueda difusa por texto (que además puede devolver un homónimo).
   * @returns {Promise<{ tmdb_id:number, kind:'movie'|'tv', title:string|null, year:number|null, score:number }|null>}
   */
  async function findByImdb(imdbId, { preferKind = null } = {}) {
    const id = String(imdbId ?? '').trim();
    if (!/^tt\d+$/.test(id)) return null;
    let json;
    try {
      json = await get(`/find/${encodeURIComponent(id)}`, { external_source: 'imdb_id' });
    } catch (err) {
      if (err?.code === 'ERR_RATE_LIMITED') throw err;
      log?.warn(`TMDB: fallo en find/${id}: ${err.message}`);
      return null;
    }
    const movie = json?.movie_results?.[0] ?? null;
    const tv = json?.tv_results?.[0] ?? null;
    const pick = preferKind === 'movie' ? (movie || tv) : preferKind === 'tv' ? (tv || movie) : (tv || movie);
    if (!pick) return null;
    const isMovie = pick === movie;
    const date = isMovie ? pick.release_date : pick.first_air_date;
    return {
      tmdb_id: pick.id,
      kind: isMovie ? 'movie' : 'tv',
      title: (isMovie ? pick.title : pick.name) || null,
      year: date ? Number(String(date).slice(0, 4)) : null,
      score: 1, // referencia exacta: no hay similitud que estimar
    };
  }

  /** Devuelve `{ imdb_id, tvdb_id }` de una obra TMDB. */
  async function externalIds(kind, tmdbId) {
    try {
      const json = await get(`/${kind === 'movie' ? 'movie' : 'tv'}/${tmdbId}/external_ids`);
      return { imdb_id: json?.imdb_id || null, tvdb_id: json?.tvdb_id || null };
    } catch (err) {
      if (err?.code === 'ERR_RATE_LIMITED') throw err;
      log?.warn(`TMDB: fallo en external_ids ${kind}/${tmdbId}: ${err.message}`);
      return { imdb_id: null, tvdb_id: null };
    }
  }

  return { findBest, findByImdb, externalIds, stats: () => limiter.stats() };
}
