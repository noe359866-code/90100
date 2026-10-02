/**
 * Cliente AniList (GraphQL público, sin API key).
 * Rate limit oficial: 90 req/min (actualmente degradado a 30 req/min) → limitador propio.
 */
import { fetchJson } from '../utils/http.js';
import { createRateLimiter } from '../utils/async.js';
import { adjustTitleScore, bestSimilarity } from '../utils/text.js';

const ENDPOINT = 'https://graphql.anilist.co';

const SEARCH_QUERY = `
query ($search: String) {
  Page(perPage: 10) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      id
      idMal
      format
      seasonYear
      episodes
      title { romaji english native userPreferred }
      synonyms
    }
  }
}`;

export function createAniListClient({
  requestsPerMinute = 20,
  minRequestsPerMinute = 5,
  cooldownMs,
  maxConsecutiveThrottles,
  disableMs,
  log,
} = {}) {
  const limiter = createRateLimiter({
    maxRequests: requestsPerMinute,
    perMs: 60_000,
    minRequests: minRequestsPerMinute,
    baseCooldownMs: cooldownMs,
    maxConsecutiveThrottles,
    disableMs,
    name: 'AniList',
    log,
  });
  const cache = new Map();

  async function search(text) {
    const key = text.trim().toLowerCase();
    if (cache.has(key)) return cache.get(key);
    const promise = limiter(() =>
      fetchJson(ENDPOINT, {
        method: 'POST',
        body: { query: SEARCH_QUERY, variables: { search: text } },
        timeoutMs: 15000,
        retries: 3,
        retryCondition: (err) => !([429, 503].includes(err?.status) && limiter.stats().disabled),
        onThrottle: (err) => limiter.reportThrottle?.(err.retryAfterMs),
        // El reintento espera el cooldown del penalty box: reintentar antes sólo
        // provoca otro 429 y alarga el bloqueo.
        minWaitMs: () => limiter.stats().cooldownMs,
        onRetry: (err, attempt, wait) => log?.warn(`AniList: reintento ${attempt} (${Math.round(wait)}ms) → ${err.message}`),
      }),
    ).then(
      (json) => {
        const media = json?.data?.Page?.media;
        if (!Array.isArray(media)) {
          const message = json?.errors?.map((e) => e.message).filter(Boolean).join('; ') || 'respuesta sin resultados';
          const err = new Error(`AniList: ${message}`);
          // A veces el rate limit llega como HTTP 200 + errors, no como 429.
          if (/too many requests|rate limit/i.test(message)) {
            err.code = 'ERR_RATE_LIMITED';
            err.retryAfterMs = 60_000;
            limiter.reportThrottle?.(err.retryAfterMs);
          }
          throw err;
        }
        limiter.reportSuccess?.();
        return media.filter((m) => m.format !== 'MUSIC');
      },
      // Un fallo NO se cachea: si no, el siguiente título igual fallaría sin reintentar.
      (err) => {
        cache.delete(key);
        throw err;
      },
    );
    cache.set(key, promise);
    promise.catch(() => {}); // evita "unhandledRejection" si nadie espera esta entrada
    return promise;
  }

  /**
   * Busca el mejor candidato para un título.
   * @param {string[]} variants      títulos a probar en orden (de más a menos específico)
   * @param {object}   [opts]
   * @param {number}   [opts.year]   año conocido (bonus si coincide)
   * @param {number}   [opts.minSimilarity]
   * @returns {Promise<{ anilist_id:number, mal_id:number|null, title:string, englishTitle:string|null, year:number|null, score:number }|null>}
   */
  async function findBest(variants, { year = null, minSimilarity = 0.6 } = {}) {
    for (const variant of variants) {
      let media;
      try {
        media = await search(variant);
      } catch (err) {
        // Si AniList nos ha cerrado el grifo, no tiene sentido probar más variantes
        if (err?.code === 'ERR_RATE_LIMITED') throw err;
        log?.warn(`AniList: fallo buscando "${variant}": ${err.message}`);
        continue;
      }
      let best = null;
      for (const m of media) {
        const titles = [m.title?.romaji, m.title?.english, m.title?.native, m.title?.userPreferred, ...(m.synonyms || [])];
        const score = adjustTitleScore(bestSimilarity(variant, titles), variant, titles, {
          year, itemYear: m.seasonYear, yearWindow: 3, yearPenalty: 0.15, yearBonus: 0.1,
        });
        if (!best || score > best.score) best = { m, score };
      }
      if (best && best.score >= minSimilarity) {
        return {
          anilist_id: best.m.id,
          mal_id: best.m.idMal ?? null,
          title: best.m.title?.romaji || best.m.title?.userPreferred || variant,
          englishTitle: best.m.title?.english || null,
          year: best.m.seasonYear ?? null,
          score: Math.min(1, best.score),
        };
      }
    }
    return null;
  }

  return { search, findBest, stats: () => limiter.stats() };
}
