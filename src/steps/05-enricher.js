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
 *      Si AniList está saturado (429) o no encuentra la obra, Kitsu resuelve por
 *      texto y sus mappings rescatan anilist_id/mal_id; TMDB se busca igualmente
 *      (con las variantes del parser y el título canónico de Kitsu).
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

/**
 * `imdb_id` suele llevar un CHECK `^tt[0-9]+$` en la tabla: si TMDB devuelve algo
 * raro ('', 'nm123', null...) el UPDATE entero fallaria con el error 23514.
 */
const IMDB_RE = /^tt\d+$/;
const cleanImdbId = (value) => {
  const v = typeof value === 'string' ? value.trim() : '';
  return IMDB_RE.test(v) ? v : null;
};

/** Columnas de telemetría de resolución (opcionales; ver sql/004_ids_telemetry.sql). */
export const ID_TELEMETRY_FIELDS = ['ids_checked_at', 'ids_source', 'ids_confidence', 'ids_attempts'];

const isMissing = (v) => v === null || v === undefined || v === '' || v === 0;

/**
 * ¿Qué columnas de telemetría tiene la tabla? (opcionales; ver sql/004_ids_telemetry.sql).
 * Las 4 comprobaciones salen en paralelo: son un round-trip cada una y el enricher
 * hace esta detección al comienzo de cada ejecución.
 * @returns {Promise<string[]>} columnas disponibles (vacío si faltan las imprescindibles)
 */
async function detectIdTelemetry(db, table) {
  const results = await Promise.all(ID_TELEMETRY_FIELDS.map(async (col) => {
    try {
      const { error } = await db.supabase.from(table).select(col).limit(1);
      return error ? null : col;
    } catch {
      return null; // la columna no existe en la tabla
    }
  }));
  const available = results.filter(Boolean);
  // Sin ids_checked_at/ids_attempts no se pueden controlar los reintentos; el resto son informativos.
  if (!available.includes('ids_checked_at') || !available.includes('ids_attempts')) return [];
  return available;
}

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
 * @returns {Promise<{ ids:object, source:string, confidence:number|null }>}
 *   `ids` sólo contiene los IDs nuevos; `source` es la lista de APIs que han
 *   resuelto algo ('anilist+kitsu+tmdb') y `confidence` la mejor similitud obtenida.
 */
export async function resolveWork(group, { anilist, kitsu, tmdb, config, log }) {
  const found = {};
  const sources = [];
  let confidence = null;
  let rateLimited = false;
  const credit = (api, score = null) => {
    if (!sources.includes(api)) sources.push(api);
    if (typeof score === 'number' && Number.isFinite(score)) confidence = Math.max(confidence ?? 0, score);
  };
  const known = { ...group.known };
  const need = (f) => group.needed.has(f) && isMissing(known[f]) && isMissing(found[f]);
  const minSimilarity = config.enrich.minSimilarity;
  const variants = group.variants;
  const year = group.year;
  // Un 429 no debe tirar los IDs que ya encontramos en otra API.
  const guard = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err?.code === 'ERR_RATE_LIMITED') {
        rateLimited = true;
        return undefined;
      }
      throw err;
    }
  };

  if (group.type === 'anime') {
    // --- AniList ---
    let englishTitle = null;
    // Si AniList nos ha cerrado el grifo por rate limit, no insistimos: esa obra
    // se queda sin resolver y se reintentará en la próxima ejecución.
    const anilistBlocked = anilist?.stats?.().disabled === true;
    if (anilistBlocked) rateLimited = true;
    if (!anilistBlocked && (need('anilist_id') || need('mal_id'))) {
      const hit = await guard(() => anilist.findBest(variants, { year, minSimilarity }));
      if (hit) {
        if (need('anilist_id')) found.anilist_id = hit.anilist_id;
        if (need('mal_id') && hit.mal_id) found.mal_id = hit.mal_id;
        englishTitle = hit.englishTitle;
        credit('anilist', hit.score);
        log.debug(`AniList ✓ "${group.label}" → ${hit.anilist_id} (${hit.title}, score ${hit.score.toFixed(2)})`);
      } else if (!rateLimited) {
        log.debug(`AniList ✗ "${group.label}"`);
      }
    }
    // --- Kitsu ---
    // No se salta aunque AniList esté en pausa: Kitsu resuelve kitsu_id y, con
    // sus mappings, puede rescatar también anilist_id/mal_id cuando AniList da
    // 429 o no encuentra la obra.
    let kitsuTitle = null;
    if (need('kitsu_id') || need('anilist_id') || need('mal_id')) {
      const anilistId = known.anilist_id || found.anilist_id;
      const malId = known.mal_id || found.mal_id;
      let kitsuId = isMissing(known.kitsu_id) ? null : Number(known.kitsu_id);
      if (!kitsuId && need('kitsu_id')) {
        kitsuId = anilistId ? await guard(() => kitsu.byAniListId(anilistId)) : null;
        if (!kitsuId && malId) kitsuId = await guard(() => kitsu.byMalId(malId));
        let hit = null;
        if (!kitsuId) {
          hit = (await guard(() => kitsu.findBest(englishTitle ? [...variants, englishTitle] : variants, { year, minSimilarity }))) ?? null;
          kitsuId = hit?.kitsu_id ?? null;
          kitsuTitle = hit?.title ?? null;
        }
        if (kitsuId) {
          found.kitsu_id = kitsuId;
          // El mapping exacto no tiene score; la búsqueda por texto sí.
          credit('kitsu', hit?.score ?? null);
        }
        log.debug(`Kitsu ${kitsuId ? '✓ ' + kitsuId : '✗'} "${group.label}"`);
      }
      // Fallback contra el rate limit de AniList: los mappings de la entrada de
      // Kitsu (anilist/anime, myanimelist/anime) rellenan los IDs que AniList no
      // pudo darnos (429, penalty box o simplemente sin match).
      if (kitsuId && (need('anilist_id') || need('mal_id')) && typeof kitsu.externalIds === 'function') {
        const ext = await guard(() => kitsu.externalIds(kitsuId));
        const rescued = [];
        if (ext?.anilist_id && need('anilist_id')) {
          found.anilist_id = ext.anilist_id;
          credit('kitsu');
          rescued.push(`anilist=${ext.anilist_id}`);
        }
        if (ext?.mal_id && need('mal_id')) {
          found.mal_id = ext.mal_id;
          credit('kitsu');
          rescued.push(`mal=${ext.mal_id}`);
        }
        if (rescued.length) log.debug(`Kitsu mappings ✓ "${group.label}" → ${rescued.join(' ')} (fallback)`);
      }
    }
    // --- TMDB (opcional para anime) ---
    if (tmdb && (need('tmdb_id') || need('imdb_id'))) {
      let tmdbId = known.tmdb_id || found.tmdb_id || null;
      let kind = 'tv';
      let kindKnown = false;
      if (!tmdbId) {
        // Sin el título inglés de AniList (p. ej. por un 429) se buscan las
        // variantes del parser más el título canónico de Kitsu.
        const extraTitles = [...new Set([englishTitle, kitsuTitle].filter(Boolean))];
        const tmdbVariants = extraTitles.length ? [...extraTitles, ...variants] : variants;
        let hit = await guard(() => tmdb.findBest('tv', tmdbVariants, { year, minSimilarity }));
        if (!hit && !group.hasEpisode) {
          hit = await guard(() => tmdb.findBest('movie', tmdbVariants, { year, minSimilarity }));
        }
        if (hit) {
          tmdbId = hit.tmdb_id;
          kind = hit.kind || kind;
          kindKnown = true;
          credit('tmdb', hit.score);
          if (need('tmdb_id')) found.tmdb_id = tmdbId;
        }
      }
      if (tmdbId && need('imdb_id')) {
        let ext = await guard(() => tmdb.externalIds(kind, tmdbId));
        // Un tmdb_id ya guardado no dice si es movie o tv. Sólo entonces se prueba el otro tipo.
        if (!kindKnown && !cleanImdbId(ext?.imdb_id) && kind === 'tv') {
          const movieExt = await guard(() => tmdb.externalIds('movie', tmdbId));
          if (cleanImdbId(movieExt?.imdb_id)) ext = movieExt;
        }
        const extImdb = cleanImdbId(ext?.imdb_id);
        if (extImdb) found.imdb_id = extImdb;
      }
    }
  } else if (tmdb) {
    let kind = group.type === 'movie' ? 'movie' : 'tv';
    let kindKnown = false;
    let tmdbId = known.tmdb_id || null;
    if (!tmdbId && need('tmdb_id')) {
      let hit = await guard(() => tmdb.findBest(kind, variants, { year, minSimilarity }));
      // Tipo inferido por el parser (filas sin `type` en la BD): si el tipo
      // "principal" no da match, se prueba el otro antes de rendirse.
      if (!hit && group.typeGuessed && !group.hasEpisode) {
        hit = await guard(() => tmdb.findBest(kind === 'movie' ? 'tv' : 'movie', variants, { year, minSimilarity }));
      }
      if (hit) {
        tmdbId = hit.tmdb_id;
        kind = hit.kind || kind;
        kindKnown = true;
        found.tmdb_id = tmdbId;
        credit('tmdb', hit.score);
        log.debug(`TMDB ✓ "${group.label}" → ${kind}/${tmdbId} (${hit.title} ${hit.year ?? ''}, score ${hit.score.toFixed(2)})`);
      } else if (!rateLimited) {
        log.debug(`TMDB ✗ "${group.label}"`);
      }
    }
    if (tmdbId && need('imdb_id')) {
      let ext = await guard(() => tmdb.externalIds(kind, tmdbId));
      // tmdb_id ya guardado + tipo inferido: el id puede ser del otro tipo (movie vs tv).
      if (!kindKnown && group.typeGuessed && !cleanImdbId(ext?.imdb_id)) {
        const otherExt = await guard(() => tmdb.externalIds(kind === 'movie' ? 'tv' : 'movie', tmdbId));
        if (cleanImdbId(otherExt?.imdb_id)) ext = otherExt;
      }
      const extImdb = cleanImdbId(ext?.imdb_id);
      if (extImdb) found.imdb_id = extImdb;
    }
  }
  return { ids: found, source: sources.join('+'), confidence, rateLimited };
}

/**
 * @param {object} [deps] clientes inyectables (tests): { anilist, kitsu, tmdb }
 */
export async function runEnricher(db, config, log, deps = {}) {
  const hasTmdb = Boolean(config.enrich.tmdbApiKey) || Boolean(deps.tmdb);
  const tmdbForAnime = config.enrich.tmdbForAnime;
  if (!hasTmdb) {
    log.warn('TMDB_API_KEY no configurada: sólo se enriquecerán animes (AniList/Kitsu).');
    log.warn('Si la definiste en GitHub: revisa que el secret se llame exactamente TMDB_API_KEY, esté en la pestaña Secrets (no en Variables ni en un Environment sin declarar en el job) y relanza el workflow.');
  }

  const anilist = deps.anilist || createAniListClient({
    requestsPerMinute: config.enrich.anilistPerMinute,
    minRequestsPerMinute: config.enrich.anilistMinPerMinute,
    log,
  });
  const kitsu = deps.kitsu || createKitsuClient({
    requestsPerMinute: config.enrich.kitsuPerMinute,
    minRequestsPerMinute: config.enrich.kitsuMinPerMinute,
    log,
  });
  const tmdb = deps.tmdb || createTmdbClient({ apiKey: config.enrich.tmdbApiKey, requestsPerSecond: config.enrich.tmdbPerSecond, log });

  const cleanCol = config.cleanTitleColumn;
  const telemetryCols = config.enrich.trackIdsColumns ? await detectIdTelemetry(db, config.table) : [];
  const trackIds = telemetryCols.length > 0;
  if (config.enrich.trackIdsColumns && !trackIds) {
    log.info('enricher: la tabla no tiene ids_checked_at/ids_attempts → se revisarán todas las obras huérfanas cada ejecución (ver sql/004_ids_telemetry.sql).');
  }
  const select = ['id', 'title', cleanCol, 'type', 'season', 'episode', ...ID_FIELDS, ...(trackIds ? ['ids_attempts'] : [])]
    .filter((c, i, a) => a.indexOf(c) === i)
    .join(',');

  // Obras ya consultadas hace poco o con demasiados intentos: se saltan.
  // Fecha en formato YYYY-MM-DD: evita los puntos de un timestamp dentro de or().
  const recheckDays = Number.isFinite(config.enrich.recheckAfterDays) ? config.enrich.recheckAfterDays : 14;
  const maxAttempts = Number.isFinite(config.enrich.maxAttempts) ? config.enrich.maxAttempts : 3;
  const recheckCutoff = new Date(Date.now() - recheckDays * 86_400_000).toISOString().slice(0, 10);
  const recheckFilter = (q) => {
    let out = q.or(`ids_checked_at.is.null,ids_checked_at.lt.${recheckCutoff}`);
    if (maxAttempts > 0) out = out.or(`ids_attempts.is.null,ids_attempts.lt.${maxAttempts}`);
    return out;
  };

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

  if (trackIds) {
    for (const query of queries) {
      const inner = query.filters;
      query.filters = (q) => recheckFilter(inner(q));
    }
  }

  /** @type {Map<string, object>} */
  const groups = new Map();
  let scanned = 0;

  // Progreso visible: en tablas grandes el escaneo tarda minutos y en el log de
  // Actions antes parecía que el paso estaba colgado hasta que aparecía el total.
  let totalEstimate = 0;
  try {
    const counts = await Promise.all(queries.map((q) => db.countWhere(q.filters, 'enricher (cuenta huérfanos)').catch(() => 0)));
    totalEstimate = counts.reduce((a, b) => a + b, 0);
  } catch {
    totalEstimate = 0; // el recuento es sólo informativo
  }
  if (totalEstimate > 0) log.info(`enricher: escaneando ${totalEstimate} filas candidatas (consultas en paralelo)…`);

  let lastProgressAt = Date.now();
  const logProgress = () => {
    if (Date.now() - lastProgressAt < 15_000) return;
    lastProgressAt = Date.now();
    const pct = totalEstimate > 0 ? ` (${Math.min(100, Math.round((scanned / totalEstimate) * 100))}%)` : '';
    log.info(`enricher: escaneando… ${scanned} filas${pct}, ${groups.size} obras hasta ahora`);
  };

  /**
   * Procesa una página completa. Debe ser SÍNCRONA: al no haber `await` dentro,
   * dos consultas paralelas nunca entremezclan filas sobre el mismo `groups`.
   */
  const ingestRows = (page) => {
    for (const row of page) {
      scanned += 1;
      let parsed = parseTitle(row.title);
      if (!parsed.cleanTitle && row[cleanCol]) {
        const alt = parseTitle(String(row[cleanCol]));
        if (alt.cleanTitle) parsed = { ...parsed, cleanTitle: alt.cleanTitle, searchKey: alt.searchKey, year: parsed.year ?? alt.year };
      }
      const type = row.type || parsed.type;
      const needed = missingIdsFor(type, row, { hasTmdb, tmdbForAnime });
      if (!needed.size || !parsed.cleanTitle) continue;

      const seasonKey = type === 'anime' && parsed.season && parsed.season > 1 ? String(parsed.season) : '';
      const key = `${type}|${parsed.searchKey}|${parsed.year ?? ''}|${seasonKey}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          type,
          /** `type` inferido por el parser (la fila no lo tiene en la BD): el match de TMDB se intenta en ambos tipos. */
          typeGuessed: !row.type,
          searchKey: parsed.searchKey,
          seasonKey,
          label: parsed.cleanTitle + (parsed.year ? ` (${parsed.year})` : '') + (seasonKey ? ` S${seasonKey}` : ''),
          variants: buildSearchVariants(parsed),
          year: parsed.year,
          hasEpisode: parsed.episode !== null || parsed.season !== null || row.episode != null || row.season != null || row.absolute_episode != null,
          known: {},
          needed: new Set(),
          rows: [],
        };
        groups.set(key, g);
      }
      g.rows.push({ id: row.id, needed });
      if (!row.type) g.typeGuessed = true;
      if (trackIds) g.attempts = Math.max(g.attempts ?? 0, Number(row.ids_attempts) || 0);
      for (const f of needed) g.needed.add(f);
      for (const f of ID_FIELDS) if (!isMissing(row[f]) && isMissing(g.known[f])) g.known[f] = row[f];
      if (parsed.episode !== null || parsed.season !== null || row.episode != null || row.season != null || row.absolute_episode != null) g.hasEpisode = true;
    }
  };

  // 2 páginas en vuelo por consulta: la petición de la página siguiente viaja
  // mientras la actual se parsea (3 streams × 2 = máx. 6 selects simultáneos).
  await Promise.all(queries.map(async (query) => {
    for await (const page of db.iterateRows({ select, applyFilters: query.filters, prefetch: 2 })) {
      ingestRows(page);
      logProgress();
    }
  }));

  // "Dune Part Two (2024)" y "Dune Part Two 1080p" son la misma obra. Años
  // distintos (remakes) no se mezclan; un año ausente se une al único año conocido.
  const merged = new Map();
  const buckets = new Map();
  for (const g of groups.values()) {
    const bkey = `${g.type}|${g.searchKey}|${g.seasonKey}`;
    if (!buckets.has(bkey)) buckets.set(bkey, []);
    buckets.get(bkey).push(g);
  }
  for (const list of buckets.values()) {
    const years = [...new Set(list.map((g) => g.year).filter((y) => y != null))];
    if (years.length > 1) {
      for (const g of list) {
        // "Dune" sin año, con remakes de 1984 y 2021, no se consulta: el match sería una moneda al aire.
        if (g.year == null) g.ambiguousYear = true;
        merged.set(g.key, g);
      }
      continue;
    }
    const base = list.find((g) => g.year != null) || list[0];
    for (const g of list) {
      if (g === base) continue;
      base.rows.push(...g.rows);
      base.variants = [...new Set([...base.variants, ...g.variants])];
      for (const f of g.needed) base.needed.add(f);
      for (const [f, v] of Object.entries(g.known)) if (isMissing(base.known[f])) base.known[f] = v;
      if (g.hasEpisode) base.hasEpisode = true;
      if (g.typeGuessed) base.typeGuessed = true;
      base.attempts = Math.max(base.attempts ?? 0, g.attempts ?? 0);
    }
    if (years.length === 1) base.year = years[0];
    merged.set(base.key, base);
  }
  groups.clear();
  for (const [k, g] of merged) groups.set(k, g);

  log.info(`enricher: ${scanned} torrents huérfanos en ${groups.size} obras distintas`);

  // --- 2. Propagación interna + selección de obras a consultar -------------------
  const updates = [];
  /** Telemetría aparte: así se detecta si la RPC está obsoleta y la ignora. */
  const telemetryUpdates = [];
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
    } else if (g.ambiguousYear) {
      // Hay varios remakes: no se pregunta a la API, pero sí se copian los IDs que ya hay en el grupo.
      if (Object.values(g.known).some((v) => !isMissing(v))) {
        applyToRows(g, g.known);
        propagatedGroups += 1;
      }
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
  const checkedAt = new Date().toISOString();
  /** Telemetría: cuándo se ha mirado esta obra, con qué API y con qué confianza. */
  const telemetryPatch = (g, { source, confidence }) => {
    const patch = {};
    if (telemetryCols.includes('ids_checked_at')) patch.ids_checked_at = checkedAt;
    if (telemetryCols.includes('ids_attempts')) patch.ids_attempts = (g.attempts ?? 0) + 1;
    if (telemetryCols.includes('ids_source')) patch.ids_source = source || 'none';
    if (telemetryCols.includes('ids_confidence')) {
      patch.ids_confidence = typeof confidence === 'number' && Number.isFinite(confidence) ? Math.round(confidence * 1000) / 1000 : null;
    }
    return patch;
  };

  let resolved = 0;
  let unresolved = 0;
  let failures = 0;
  let rateLimited = 0;
  let rateLimitWarned = false;
  const warnRate = () => {
    if (rateLimitWarned) return;
    rateLimitWarned = true;
    log.warn('enricher: una API está en pausa por rate limit; las obras afectadas quedan para la próxima ejecución.');
  };
  await mapWithConcurrency(selected, config.enrich.concurrency, async (g) => {
    try {
      const { ids: found, source, confidence, rateLimited: limited } = await resolveWork(g, { anilist, kitsu, tmdb, config, log });
      const ids = { ...g.known, ...found };
      const got = Object.keys(found).length > 0;
      const stillMissing = [...g.needed].some((f) => isMissing(ids[f]));
      // No quemar ids_attempts si el rate limit dejó IDs sin resolver: si no, tres
      // ejecuciones bloqueadas dan la obra por perdida sin haberla buscado de verdad.
      if (trackIds && !config.dryRun && !(limited && stillMissing)) {
        const meta = telemetryPatch(g, { source, confidence });
        for (const r of g.rows) telemetryUpdates.push({ id: r.id, patch: { ...meta } });
      }
      if (got) {
        resolved += 1;
        applyToRows(g, ids);
        if (limited && stillMissing) warnRate();
      } else if (limited) {
        rateLimited += 1;
        warnRate();
      } else {
        unresolved += 1;
        if (g.known && Object.values(g.known).some((v) => !isMissing(v))) applyToRows(g, ids);
      }
    } catch (err) {
      failures += 1;
      if (err?.code === 'ERR_RATE_LIMITED') {
        rateLimited += 1;
        warnRate();
      } else {
        log.warn(`enricher: error resolviendo "${g.label}": ${err.message}`);
      }
    }
  });

  // --- 4. Persistencia ----------------------------------------------------------------
  const updated = await db.updateRows(updates, 'enricher');

  if (telemetryUpdates.length) {
    const tracked = await db.updateRows(telemetryUpdates, 'enricher (telemetría ids)');
    if (tracked === 0 && db.isRpcAvailable?.()) {
      log.warn('Las columnas ids_* no se están guardando: la RPC bulk_update_torrents es antigua. Ejecuta la versión actual de sql/002_bulk_update_rpc.sql.');
    }
  }

  const throttles = [
    ['AniList', anilist?.stats?.()],
    ['Kitsu', kitsu?.stats?.()],
    ['TMDB', tmdb?.stats?.()],
  ]
    .filter(([, s]) => s?.throttles > 0)
    .map(([n, s]) => `${n}: ${s.throttles}×429 (tasa final ${s.rate}/${s.maxRate}${s.disabled ? ', en pausa' : ''})`);
  if (throttles.length) log.warn(`enricher: límites de tasa alcanzados → ${throttles.join(' · ')}`);

  log.info(`Enriquecedor: ${resolved} obras resueltas por API, ${propagatedGroups} por propagación, ${unresolved} sin match, ${failures} errores (${rateLimited} por rate limit) → ${updated} torrents actualizados`);
  return { scanned, groups: groups.size, lookedUp: selected.length, resolved, propagatedGroups, unresolved, failures, rateLimited, updated };
}
