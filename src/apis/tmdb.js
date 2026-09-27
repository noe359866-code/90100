/**
 * Cliente TMDB (requiere `TMDB_API_KEY`).
 * Acepta tanto la API key v3 (query `api_key`) como el token de lectura v4 (Bearer).
 */
import { fetchJson } from '../utils/http.js';
import { createRateLimiter } from '../utils/async.js';
import { bestSimilarity } from '../utils/text.js';

const BASE = 'https://api.themoviedb.org/3';

export function createTmdbClient({ apiKey, requestsPerSecond = 20, log } = {}) {
  if (!apiKey) return null;
  const isBearer = apiKey.startsWith('eyJ') || apiKey.length > 40;
  const limiter = createRateLimiter({ maxRequests: requestsPerSecond, perMs: 1000 });
  const cache = new Map();

  const get = (path, params = {}) => {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    if (!isBearer) url.searchParams.set('api_key', apiKey);
    const key = url.toString();
    if (cache.has(key)) return cache.get(key);
    const p = limiter(() =>
      fetchJson(key, {
        headers: isBearer ? { Authorization: `Bearer ${apiKey}` } : {},
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
