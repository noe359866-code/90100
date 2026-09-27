/**
 * Cliente Kitsu (JSON:API pública, sin API key).
 *
 * Prioriza la resolución exacta vía "mappings" (anilist → kitsu, mal → kitsu)
 * y sólo recurre a la búsqueda por texto si no hay IDs externos.
 */
import { fetchJson } from '../utils/http.js';
import { createRateLimiter } from '../utils/async.js';
import { bestSimilarity } from '../utils/text.js';

const BASE = 'https://kitsu.io/api/edge';
const HEADERS = { Accept: 'application/vnd.api+json', 'Content-Type': 'application/vnd.api+json' };

export function createKitsuClient({
  requestsPerMinute = 90,
  minRequestsPerMinute = 15,
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
    name: 'Kitsu',
    log,
  });
  const cache = new Map();

  const get = (url) => {
    if (cache.has(url)) return cache.get(url);
    const promise = limiter(() =>
      fetchJson(url, {
        headers: HEADERS,
        timeoutMs: 15000,
        retries: 3,
        onThrottle: (err) => limiter.reportThrottle?.(err.retryAfterMs),
        onRetry: (err, attempt, wait) => log?.warn(`Kitsu: reintento ${attempt} (${Math.round(wait)}ms) → ${err.message}`),
      }),
    ).then(
      (json) => {
        limiter.reportSuccess?.();
        return json;
      },
      // Un fallo NO se cachea (mismo razonamiento que en AniList).
      (err) => {
        cache.delete(url);
        throw err;
      },
    );
    cache.set(url, promise);
    promise.catch(() => {});
    return promise;
  };

  /** Resuelve kitsu_id a partir de un ID externo (anilist/anime, myanimelist/anime). */
  async function byExternalId(site, externalId) {
    if (!externalId) return null;
    const url = `${BASE}/mappings?filter[externalSite]=${encodeURIComponent(site)}&filter[externalId]=${encodeURIComponent(externalId)}&include=item&fields[anime]=canonicalTitle`;
    try {
      const json = await get(url);
      const mapping = json?.data?.[0];
      const itemId = mapping?.relationships?.item?.data?.id;
      const itemType = mapping?.relationships?.item?.data?.type;
      if (itemId && (itemType === 'anime' || !itemType)) return Number(itemId);
      const included = json?.included?.find((i) => i.type === 'anime');
      return included ? Number(included.id) : null;
    } catch (err) {
      log?.warn(`Kitsu: fallo en mapping ${site}=${externalId}: ${err.message}`);
      return null;
    }
  }

  const byAniListId = (id) => byExternalId('anilist/anime', id);
  const byMalId = (id) => byExternalId('myanimelist/anime', id);

  /** Búsqueda por texto con verificación de similitud. */
  async function findBest(variants, { year = null, minSimilarity = 0.6 } = {}) {
    for (const variant of variants) {
      const url = `${BASE}/anime?filter[text]=${encodeURIComponent(variant)}&page[limit]=10&fields[anime]=canonicalTitle,titles,abbreviatedTitles,startDate,subtype`;
      let json;
      try {
        json = await get(url);
      } catch (err) {
        log?.warn(`Kitsu: fallo buscando "${variant}": ${err.message}`);
        continue;
      }
      let best = null;
      for (const item of json?.data || []) {
        const a = item.attributes || {};
        if (a.subtype === 'music') continue;
        const titles = [a.canonicalTitle, ...Object.values(a.titles || {}), ...(a.abbreviatedTitles || [])];
        let score = bestSimilarity(variant, titles);
        const itemYear = a.startDate ? Number(a.startDate.slice(0, 4)) : null;
        if (year && itemYear) {
          if (Math.abs(itemYear - year) <= 1) score += 0.1;
          else if (Math.abs(itemYear - year) > 3) score -= 0.15;
        }
        if (!best || score > best.score) best = { item, score, title: a.canonicalTitle, year: itemYear };
      }
      if (best && best.score >= minSimilarity) {
        return { kitsu_id: Number(best.item.id), title: best.title, year: best.year, score: Math.min(1, best.score) };
      }
    }
    return null;
  }

  return { byAniListId, byMalId, findBest, stats: () => limiter.stats() };
}
