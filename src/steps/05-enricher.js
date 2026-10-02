/**
 * PASO 6 — ENRIQUECEDOR DE IDs CON APIS PÚBLICAS
 *
 * Para torrents "huérfanos" (sin `tmdb_id`, `anilist_id` o `kitsu_id`):
 *   1. Se agrupan por obra (tipo + título limpio + año [+ temporada en anime])
 *      para hacer UNA sola consulta por obra, no por torrent.
 *   2. Si algún torrent del grupo ya tiene un ID, se propaga al resto sin llamar a la API.
 *   3. Cada obra se resuelve por la vía MÁS BARATA y EXACTA disponible:
 *      · `imdb_id` ya guardado      → `/find` de TMDB (1 llamada, sin homónimos).
 *      · otro ID externo ya guardado → mappings de Kitsu (anilist↔kitsu↔mal): son
 *        referencias cruzadas exactas y evitan gastar cuota de AniList.
 *      · sin nada                 → búsqueda por título, en este orden:
 *          Anime  → TMDB (20 req/s) → tmdb_id; AniList (GraphQL, 20 req/min, el
 *                   recurso más escaso: 3 s por consulta) → anilist_id + mal_id;
 *                   Kitsu (90 req/min) → kitsu_id y, con sus mappings, rescata
 *                   anilist_id/mal_id si AniList dio 429 o no encontró la obra.
 *                   Si TMDB no encontró con las variantes, se reintenta con los
 *                   títulos canónicos de AniList/Kitsu → imdb_id vía external_ids.
 *          Movie/Series → TMDB search → tmdb_id → external_ids → imdb_id.
 *   4. Cada match se valida por similitud de título (+ año) para evitar falsos positivos.
 *   5. Temporadas: AniList/Kitsu tienen ficha POR TEMPORADA, así que con
 *      `season > 1` sólo se pregunta por las variantes que identifican la
 *      temporada ("Título 2nd Season"). TMDB sí usa el título pelado porque su
 *      `tmdb_id` es por serie. Sin esto, una T2 se quedaba con la ficha de la T1
 *      (metadatos equivocados en Stremio y riesgo de que la deduplicación
 *      agrupara temporadas distintas).
 *
 * `ENRICH_MAX_LOOKUPS` limita las obras resueltas por ejecución (las que más
 * torrents desbloquean primero), para respetar rate-limits y el tiempo del job.
 * Coste por obra (medido con clientes instrumentados): ~3 llamadas de búsqueda;
 * con IDs previos, 1-2 mappings exactos y CERO consultas de AniList.
 */
import { parseTitle, buildSearchVariants } from '../parser/titleParser.js';
import { createAniListClient } from '../apis/anilist.js';
import { createKitsuClient } from '../apis/kitsu.js';
import { createTmdbClient } from '../apis/tmdb.js';
import { mapWithConcurrency } from '../utils/async.js';

const ID_FIELDS = ['imdb_id', 'tmdb_id', 'anilist_id', 'kitsu_id', 'mal_id'];
const NUMERIC_ID_FIELDS = new Set(['tmdb_id', 'anilist_id', 'kitsu_id', 'mal_id']);

/**
 * Filtro PostgREST para IDs ausentes. El código también considera vacíos los
 * IDs numéricos `0` y el `imdb_id` de texto vacío, así que el prefiltro SQL debe
 * incluir esos sentinelas además de NULL.
 */
function missingIdFilter(fields) {
  return fields.flatMap((field) => NUMERIC_ID_FIELDS.has(field)
    ? [`${field}.is.null`, `${field}.eq.0`]
    : [`${field}.is.null`, `${field}.eq.\"\"`]).join(',');
}

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
  /**
   * AniList/Kitsu/MAL identifican la TEMPORADA: en una obra de temporada > 1 se
   * pregunta sólo por las variantes de temporada ("Título 2nd Season"...). El
   * título pelado se reserva para TMDB, donde el id es por serie.
   */
  const seasonalVariants = group.seasonalVariants?.length ? group.seasonalVariants : variants;
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
    // --- TMDB (1ª pasada) ---
    // TMDB va primero: es la API con más cuota (20 req/s frente a las 20 req/min
    // de AniList) y así tmdb_id/imdb_id no esperan en la cola de AniList. Si con
    // las variantes del parser no hay match, al final se reintenta con los títulos
    // canónicos de AniList/Kitsu (2ª pasada), que era la ventaja del orden antiguo.
    //
    // Dos caminos, del más barato/exacto al más caro/difuso:
    //   1. `imdb_id` ya guardado + `/find` de TMDB → tmdb_id exacto en UNA llamada,
    //      sin búsqueda por texto (ni homónimos ni dependencia del idioma del título).
    //   2. búsqueda por variantes del parser + año.
    let englishTitle = null;
    let kitsuTitle = null;
    let tmdbId = known.tmdb_id || null;
    let kind = 'tv';
    let kindKnown = false;
    const tmdbWanted = Boolean(tmdb) && (need('tmdb_id') || need('imdb_id'));

    // Atajo exacto: referencia imdb → tmdb. Si el atajo falla por cualquier motivo
    // (TMDB cambia de forma, error raro...), la búsqueda por texto sigue siendo el
    // plan B: perder la obra por un fallo del atajo no tendría sentido.
    const knownImdb = cleanImdbId(known.imdb_id);
    if (tmdb && !tmdbId && need('tmdb_id') && knownImdb && typeof tmdb.findByImdb === 'function') {
      let hit;
      try {
        hit = await guard(() => tmdb.findByImdb(knownImdb, { preferKind: null }));
      } catch (err) {
        log.warn(`TMDB: no se pudo resolver "${group.label}" por imdb_id (${err.message}); se busca por título`);
      }
      if (hit?.tmdb_id) {
        tmdbId = hit.tmdb_id;
        kind = hit.kind || kind;
        kindKnown = true;
        credit('tmdb', hit.score);
        found.tmdb_id = tmdbId;
        log.debug(`TMDB ✓ \"${group.label}\" → ${kind}/${tmdbId} (por imdb_id exacto, sin búsqueda)`);
      }
    }

    const tryTmdb = async (extraTitles) => {
      if (!tmdb || tmdbId || !need('tmdb_id')) return;
      const tmdbVariants = extraTitles.length ? [...new Set([...extraTitles, ...variants])] : variants;
      let hit = await guard(() => tmdb.findBest('tv', tmdbVariants, { year, minSimilarity }));
      if (!hit && !group.hasEpisode) {
        hit = await guard(() => tmdb.findBest('movie', tmdbVariants, { year, minSimilarity }));
      }
      if (hit) {
        tmdbId = hit.tmdb_id;
        kind = hit.kind || kind;
        kindKnown = true;
        credit('tmdb', hit.score);
        found.tmdb_id = tmdbId;
        log.debug(`TMDB ✓ \"${group.label}\" → ${kind}/${tmdbId} (${hit.title} ${hit.year ?? ''}, score ${hit.score.toFixed(2)})`);
      }
    };
    if (tmdbWanted) await tryTmdb([]);

    /**
     * Vía Kitsu. Dos modos:
     *  - `mapping`: ya conocemos un id externo (mal/anilist/kitsu) → los mappings
     *    de Kitsu son una referencia EXACTA (1-2 llamadas) y no hace falta la
     *    búsqueda por texto.
     *  - `search`: no sabemos nada de la obra → búsqueda por título y, si hay
     *    suerte, mappings para rescatar anilist_id/mal_id.
     * @returns {Promise<boolean>} true si ya no hay nada más que pedirle a Kitsu
     */
    const runKitsu = async ({ allowSearch }) => {
      if (need('kitsu_id') || need('anilist_id') || need('mal_id')) {
        const anilistId = known.anilist_id || found.anilist_id;
        const malId = known.mal_id || found.mal_id;
        let kitsuId = isMissing(known.kitsu_id) ? null : Number(known.kitsu_id);
        let hit = null;
        if (!kitsuId && need('kitsu_id')) {
          // Mappings exactos antes que búsqueda por texto: son más fiables y no
          // consumen cuota de AniList.
          kitsuId = anilistId ? await guard(() => kitsu.byAniListId(anilistId)) : null;
          if (!kitsuId && malId) kitsuId = await guard(() => kitsu.byMalId(malId));
          if (!kitsuId && allowSearch) {
            const kitsuVariants = englishTitle ? [...new Set([...seasonalVariants, englishTitle])] : seasonalVariants;
            hit = (await guard(() => kitsu.findBest(kitsuVariants, { year, minSimilarity }))) ?? null;
            kitsuId = hit?.kitsu_id ?? null;
            kitsuTitle = hit?.title ?? null;
          }
          if (kitsuId) {
            found.kitsu_id = kitsuId;
            // El mapping exacto no tiene score; la búsqueda por texto sí.
            credit('kitsu', hit?.score ?? null);
          }
          log.debug(`Kitsu ${kitsuId ? '✓ ' + kitsuId : '✗'} \"${group.label}\"`);
        }
        // Los mappings de la entrada de Kitsu (anilist/anime, myanimelist/anime)
        // rellenan los IDs que aún falten: es una referencia cruzada real, no una
        // búsqueda aproximada.
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
          if (rescued.length) log.debug(`Kitsu mappings ✓ \"${group.label}\" → ${rescued.join(' ')}`);
        }
      }
      return !(need('kitsu_id') || need('anilist_id') || need('mal_id'));
    };

    // Si ya conocemos algún ID externo, la vía barata y exacta va PRIMERO: así
    // muchas obras de anime se resuelven sin gastar una sola llamada de AniList
    // (20 req/min, el recurso más escaso del job). Con la obra "anónima" se
    // mantiene el orden de siempre: AniList (búsqueda) y después Kitsu.
    //
    // La búsqueda por texto de Kitsu sólo se permite aquí si TMDB no encontró
    // nada: en ese caso su título canónico es lo que permite el reintento de TMDB
    // (2ª pasada). Si TMDB ya resolvió, no se gasta ninguna llamada de más.
    const knownExternalId = !isMissing(known.kitsu_id) || !isMissing(known.anilist_id) || !isMissing(known.mal_id);
    const kitsuDone = knownExternalId ? await runKitsu({ allowSearch: tmdbWanted && !tmdbId }) : false;

    // --- AniList ---
    // Si AniList nos ha cerrado el grifo por rate limit, no insistimos: esa obra
    // se queda sin resolver y se reintentará en la próxima ejecución.
    const anilistBlocked = !anilist || anilist.stats?.().disabled === true;
    if (!kitsuDone && anilistBlocked) rateLimited = rateLimited || Boolean(anilist);
    if (anilist && !kitsuDone && !anilistBlocked && (need('anilist_id') || need('mal_id'))) {
      const hit = await guard(() => anilist.findBest(seasonalVariants, { year, minSimilarity }));
      if (hit) {
        if (need('anilist_id')) found.anilist_id = hit.anilist_id;
        if (need('mal_id') && hit.mal_id) found.mal_id = hit.mal_id;
        englishTitle = hit.englishTitle;
        credit('anilist', hit.score);
        log.debug(`AniList ✓ \"${group.label}\" → ${hit.anilist_id} (${hit.title}, score ${hit.score.toFixed(2)})`);
      } else if (!rateLimited) {
        log.debug(`AniList ✗ \"${group.label}\"`);
      }
    }
    // --- Kitsu (búsqueda por texto), si no se hizo antes ---
    if (!kitsuDone) await runKitsu({ allowSearch: true });

    // --- TMDB (2ª pasada, con los títulos canónicos si los hay) ---
    if (tmdbWanted && (englishTitle || kitsuTitle)) {
      await tryTmdb([englishTitle, kitsuTitle].filter(Boolean));
    }
    // --- imdb_id a partir del tmdb_id ---
    if (tmdb && tmdbId && need('imdb_id')) {
      let ext = await guard(() => tmdb.externalIds(kind, tmdbId));
      // Un tmdb_id ya guardado no dice si es movie o tv. Sólo entonces se prueba el otro tipo.
      if (!kindKnown && !cleanImdbId(ext?.imdb_id) && kind === 'tv') {
        const movieExt = await guard(() => tmdb.externalIds('movie', tmdbId));
        if (cleanImdbId(movieExt?.imdb_id)) ext = movieExt;
      }
      const extImdb = cleanImdbId(ext?.imdb_id);
      if (extImdb) found.imdb_id = extImdb;
    }
  } else if (tmdb) {
    let kind = group.type === 'movie' ? 'movie' : 'tv';
    let kindKnown = false;
    let tmdbId = known.tmdb_id || null;
    // Atajo exacto por imdb_id: una sola llamada y sin homónimos posibles. Si el
    // atajo falla, se sigue con la búsqueda por texto (plan B).
    const knownImdb = cleanImdbId(known.imdb_id);
    if (!tmdbId && need('tmdb_id') && knownImdb && typeof tmdb.findByImdb === 'function') {
      let hit;
      try {
        hit = await guard(() => tmdb.findByImdb(knownImdb, { preferKind: group.type === 'movie' ? 'movie' : 'tv' }));
      } catch (err) {
        log.warn(`TMDB: no se pudo resolver "${group.label}" por imdb_id (${err.message}); se busca por título`);
      }
      if (hit?.tmdb_id) {
        tmdbId = hit.tmdb_id;
        kind = hit.kind || kind;
        kindKnown = true;
        found.tmdb_id = tmdbId;
        credit('tmdb', hit.score);
        log.debug(`TMDB ✓ "${group.label}" → ${kind}/${tmdbId} (por imdb_id exacto, sin búsqueda)`);
      }
    }
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
      filters: (q) => q.eq('type', 'anime').or(missingIdFilter([
        'anilist_id', 'kitsu_id', 'mal_id',
        ...(hasTmdb && tmdbForAnime ? ['tmdb_id', 'imdb_id'] : []),
      ])),
    },
  ];
  if (hasTmdb) {
    queries.push({
      label: 'movie/series',
      filters: (q) => q.in('type', ['movie', 'series']).or(missingIdFilter(['tmdb_id', 'imdb_id'])),
    });
  }
  // El tipo puede inferirse del título al ingerir la fila, así que este prefiltro
  // incluye todos los IDs. Limitarlo a tmdb/anilist/kitsu dejaba sin revisar, por
  // ejemplo, filas sin tipo con sólo mal_id=0 o imdb_id vacío.
  queries.push({ label: 'sin tipo', filters: (q) => q.is('type', null).or(missingIdFilter(ID_FIELDS)) });

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
          /**
           * Variantes que identifican la temporada (sólo anime con temporada > 1).
           * AniList/Kitsu tienen ficha POR TEMPORADA: con el título pelado
           * devolverían la ficha de otra temporada. TMDB no las usa (su id es por serie).
           */
          seasonalVariants: buildSearchVariants(parsed, { onlySeason: true }),
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
      base.seasonalVariants = [...new Set([...(base.seasonalVariants ?? []), ...(g.seasonalVariants ?? [])])];
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
