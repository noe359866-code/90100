/**
 * PASO 6 — ENRIQUECEDOR DE IDs CON APIS PÚBLICAS
 *
 * Para torrents "huérfanos" (sin `tmdb_id`, `anilist_id` o `kitsu_id`):
 *   1. Se agrupan por obra (tipo + título limpio + año [+ temporada en anime])
 *      para hacer UNA sola consulta por obra, no por torrent.
 *   2. Si algún torrent del grupo ya tiene un ID, se propaga al resto sin llamar a la API.
 *   3. Anime  → AniList (GraphQL) → anilist_id + mal_id; Kitsu por mapping exacto
 *              (anilist→kitsu / mal→kitsu) o búsqueda por texto → kitsu_id.
 *              Opcionalmente TMDB (tv) con el título inglés de AniList → tmdb_id + imdb_id.
 *      Movie/Series → TMDB search → tmdb_id → external_ids → imdb_id.
 *   4. Cada match se valida por similitud de título (+ año) para evitar falsos positivos.
 *
 * `ENRICH_MAX_LOOKUPS` limita las obras resueltas por ejecución (las que más
 * torrents desbloquean primero), para respetar rate-limits y el tiempo del job.
 */
import { parseTitle, buildSearchVariants } from '../parser/titleParser.js';
import { createAniListClient } from '../apis/anilist.js';
import { createKitsuClient } from '../apis/kitsu.js';
import { createTmdbClient } from '../apis/tmdb.js';
import { mapWithConcurrency } from '../utils/async.js';

const ID_FIELDS = ['imdb_id', 'tmdb_id', 'anilist_id', 'kitsu_id', 'mal_id'];

const isMissing = (v) => v === null || v === undefined || v === '' || v === 0;

/** Decide qué IDs le faltan a una fila según su tipo y la configuración. */
export function missingIdsFor(type, row, { hasTmdb, tmdbForAnime }) {
  const missing = new Set();
  if (type === 'anime') {
    if (isMissing(row.anilist_id)) missing.add('anilist_id');
    if (isMissing(row.kitsu_id)) missing.add('kitsu_id');
    if (isMissing(row.mal_id)) missing.add('mal_id');
    if (hasTmdb && tmdbForAnime) {
      if (isMissing(row.tmdb_id)) missing.add('tmdb_id');
      if (isMissing(row.imdb_id)) missing.add('imdb_id');
    }
  } else if (hasTmdb) {
    if (isMissing(row.tmdb_id)) missing.add('tmdb_id');
    if (isMissing(row.imdb_id)) missing.add('imdb_id');
  }
  return missing;
}

/**
 * Resuelve los IDs de una obra consultando las APIs necesarias.
 * @returns {Promise<object>} IDs encontrados (sólo los nuevos)
 */
export async function resolveWork(group, { anilist, kitsu, tmdb, config, log }) {
  const found = {};
  const known = { ...group.known };
  const need = (f) => group.needed.has(f) && isMissing(known[f]) && isMissing(found[f]);
  const minSimilarity = config.enrich.minSimilarity;
  const variants = group.variants;
  const year = group.year;

  if (group.type === 'anime') {
    // --- AniList ---
    let englishTitle = null;
    if (need('anilist_id') || need('mal_id')) {
      const hit = await anilist.findBest(variants, { year, minSimilarity });
      if (hit) {
        if (need('anilist_id')) found.anilist_id = hit.anilist_id;
        if (need('mal_id') && hit.mal_id) found.mal_id = hit.mal_id;
        englishTitle = hit.englishTitle;
        log.debug(`AniList ✓ "${group.label}" → ${hit.anilist_id} (${hit.title}, score ${hit.score.toFixed(2)})`);
      } else {
        log.debug(`AniList ✗ "${group.label}"`);
      }
    }
    // --- Kitsu ---
    if (need('kitsu_id')) {
      const anilistId = known.anilist_id || found.anilist_id;
      const malId = known.mal_id || found.mal_id;
      let kitsuId = anilistId ? await kitsu.byAniListId(anilistId) : null;
      if (!kitsuId && malId) kitsuId = await kitsu.byMalId(malId);
      if (!kitsuId) {
        const hit = await kitsu.findBest(englishTitle ? [...variants, englishTitle] : variants, { year, minSimilarity });
        kitsuId = hit?.kitsu_id ?? null;
      }
      if (kitsuId) found.kitsu_id = kitsuId;
      log.debug(`Kitsu ${kitsuId ? '✓ ' + kitsuId : '✗'} "${group.label}"`);
    }
    // --- TMDB (opcional para anime) ---
    if (tmdb && (need('tmdb_id') || need('imdb_id'))) {
      let tmdbId = known.tmdb_id || found.tmdb_id || null;
      let kind = 'tv';
      if (!tmdbId) {
        const tmdbVariants = englishTitle ? [englishTitle, ...variants] : variants;
        let hit = await tmdb.findBest('tv', tmdbVariants, { year, minSimilarity });
        if (!hit && !group.hasEpisode) {
          hit = await tmdb.findBest('movie', tmdbVariants, { year, minSimilarity });
        }
        if (hit) {
          tmdbId = hit.tmdb_id;
          kind = hit.kind;
          if (need('tmdb_id')) found.tmdb_id = tmdbId;
        }
      }
      if (tmdbId && need('imdb_id')) {
        const ext = await tmdb.externalIds(kind, tmdbId);
        if (ext.imdb_id) found.imdb_id = ext.imdb_id;
      }
    }
  } else if (tmdb) {
    const kind = group.type === 'movie' ? 'movie' : 'tv';
    let tmdbId = known.tmdb_id || null;
    if (!tmdbId && need('tmdb_id')) {
      const hit = await tmdb.findBest(kind, variants, { year, minSimilarity });
      if (hit) {
        tmdbId = hit.tmdb_id;
        found.tmdb_id = tmdbId;
        log.debug(`TMDB ✓ "${group.label}" → ${kind}/${tmdbId} (${hit.title} ${hit.year ?? ''}, score ${hit.score.toFixed(2)})`);
      } else {
        log.debug(`TMDB ✗ "${group.label}"`);
      }
    }
    if (tmdbId && need('imdb_id')) {
      const ext = await tmdb.externalIds(kind, tmdbId);
      if (ext.imdb_id) found.imdb_id = ext.imdb_id;
    }
  }
  return found;
}

/**
 * @param {object} [deps] clientes inyectables (tests): { anilist, kitsu, tmdb }
 */
export async function runEnricher(db, config, log, deps = {}) {
  const hasTmdb = Boolean(config.enrich.tmdbApiKey) || Boolean(deps.tmdb);
  const tmdbForAnime = config.enrich.tmdbForAnime;
  if (!hasTmdb) log.warn('TMDB_API_KEY no configurada: sólo se enriquecerán animes (AniList/Kitsu).');

  const anilist = deps.anilist || createAniListClient({ requestsPerMinute: config.enrich.anilistPerMinute, log });
  const kitsu = deps.kitsu || createKitsuClient({ requestsPerMinute: config.enrich.kitsuPerMinute, log });
  const tmdb = deps.tmdb || createTmdbClient({ apiKey: config.enrich.tmdbApiKey, requestsPerSecond: config.enrich.tmdbPerSecond, log });

  const cleanCol = config.cleanTitleColumn;
  const select = ['id', 'title', cleanCol, 'type', 'season', 'episode', ...ID_FIELDS].filter((c, i, a) => a.indexOf(c) === i).join(',');

  // --- 1. Recolectar candidatos por tipo ---------------------------------------
  const queries = [
    {
      label: 'anime',
      filters: (q) => q.eq('type', 'anime').or(`anilist_id.is.null,kitsu_id.is.null,mal_id.is.null${hasTmdb && tmdbForAnime ? ',tmdb_id.is.null,imdb_id.is.null' : ''}`),
    },
  ];
  if (hasTmdb) {
    queries.push({ label: 'movie/series', filters: (q) => q.in('type', ['movie', 'series']).or('tmdb_id.is.null,imdb_id.is.null') });
  }
  queries.push({ label: 'sin tipo', filters: (q) => q.is('type', null).or('tmdb_id.is.null,anilist_id.is.null,kitsu_id.is.null') });

  /** @type {Map<string, object>} */
  const groups = new Map();
  let scanned = 0;

  for (const query of queries) {
    for await (const page of db.iterateRows({ select, applyFilters: query.filters })) {
      for (const row of page) {
        scanned += 1;
        const parsed = parseTitle(row.title);
        const type = row.type || parsed.type;
        const needed = missingIdsFor(type, row, { hasTmdb, tmdbForAnime });
        if (!needed.size || !parsed.cleanTitle) continue;

        const season = type === 'anime' && parsed.season && parsed.season > 1 ? parsed.season : '';
        const key = `${type}|${parsed.searchKey}|${parsed.year ?? ''}|${season}`;
        let g = groups.get(key);
        if (!g) {
          g = {
            key,
            type,
            label: parsed.cleanTitle + (parsed.year ? ` (${parsed.year})` : '') + (season ? ` S${season}` : ''),
            variants: buildSearchVariants(parsed),
            year: parsed.year,
            hasEpisode: parsed.episode !== null || parsed.season !== null,
            known: {},
            needed: new Set(),
            rows: [],
          };
          groups.set(key, g);
        }
        g.rows.push({ id: row.id, needed });
        for (const f of needed) g.needed.add(f);
        for (const f of ID_FIELDS) if (!isMissing(row[f]) && isMissing(g.known[f])) g.known[f] = row[f];
        if (parsed.episode !== null || parsed.season !== null) g.hasEpisode = true;
      }
    }
  }

  log.info(`enricher: ${scanned} torrents huérfanos en ${groups.size} obras distintas`);

  // --- 2. Propagación interna + selección de obras a consultar -------------------
  const updates = [];
  const applyToRows = (g, ids) => {
    for (const r of g.rows) {
      const patch = {};
      for (const f of r.needed) if (!isMissing(ids[f])) patch[f] = ids[f];
      if (Object.keys(patch).length) updates.push({ id: r.id, patch });
    }
  };

  const toLookup = [];
  let propagatedGroups = 0;
  for (const g of groups.values()) {
    const stillNeeded = [...g.needed].filter((f) => isMissing(g.known[f]));
    if (!stillNeeded.length) {
      applyToRows(g, g.known); // todo resoluble con lo que ya sabemos
      propagatedGroups += 1;
    } else {
      g.needed = new Set(stillNeeded);
      toLookup.push(g);
    }
  }
  toLookup.sort((a, b) => b.rows.length - a.rows.length);
  const selected = toLookup.slice(0, config.enrich.maxLookups);
  if (toLookup.length > selected.length) {
    log.info(`enricher: ${toLookup.length} obras requieren API; se procesan ${selected.length} (ENRICH_MAX_LOOKUPS). El resto quedará para la próxima ejecución.`);
  }

  // --- 3. Consultas a APIs ---------------------------------------------------------
  let resolved = 0;
  let unresolved = 0;
  let failures = 0;
  await mapWithConcurrency(selected, config.enrich.concurrency, async (g) => {
    try {
      const found = await resolveWork(g, { anilist, kitsu, tmdb, config, log });
      const ids = { ...g.known, ...found };
      if (Object.keys(found).length) {
        resolved += 1;
        applyToRows(g, ids);
      } else {
        unresolved += 1;
        if (g.known && Object.values(g.known).some((v) => !isMissing(v))) applyToRows(g, ids);
      }
    } catch (err) {
      failures += 1;
      log.warn(`enricher: error resolviendo "${g.label}": ${err.message}`);
    }
  });

  // --- 4. Persistencia ----------------------------------------------------------------
  const updated = await db.updateRows(updates, 'enricher');

  log.info(`Enriquecedor: ${resolved} obras resueltas por API, ${propagatedGroups} por propagación, ${unresolved} sin match, ${failures} errores → ${updated} torrents actualizados`);
  return { scanned, groups: groups.size, lookedUp: selected.length, resolved, propagatedGroups, unresolved, failures, updated };
}
