/**
 * PASO 7 — DEDUPLICADOR INTELIGENTE COMPATIBLE CON STREMIO
 *
 * Objetivo: por cada obra + episodio conservar SÓLO
 *   - el mejor torrent del grupo 'spanish' (castellano, latino o subtitulado en español)
 *   - el mejor torrent del grupo 'english' (audio o subtítulos en inglés)
 * y eliminar el resto.
 *
 * Agrupación:
 *   - Clave de obra: imdb_id → tmdb_id (con tipo movie/tv) → anilist_id → kitsu_id.
 *     Union-find une filas relacionadas por más de un ID. Si falta el ID, se usa
 *     título/tipo/año; ese alias sólo se conecta a IDs cuando no es ambiguo.
 *   - Clave de episodio: SxxEyy / episodio absoluto / pack de temporada / película.
 *
 * Puntuación (mayor = mejor):
 *   score = log2(1 + seeders) * SEEDER_WEIGHT + bonus_compatibilidad
 *   donde la compatibilidad premia H.264 > HEVC, MP4/MKV, BluRay/WEB-DL, 1080p,
 *   AAC/AC3, y penaliza CAM/TS, AV1, XviD, Dolby Vision, TrueHD/DTS-HD, AVI/WMV...
 *   Con el peso por defecto (20), duplicar los seeders vale 20 puntos; un H.264
 *   frente a un XviD vale 70 → la compatibilidad sólo decide entre torrents con
 *   una cantidad de seeders comparable.
 */
import { parseTitle } from '../parser/titleParser.js';
import { classifyLanguage, normalizeLanguageArray, SPANISH_GROUP, ENGLISH_GROUP } from '../parser/languages.js';
import { normalizeCodec, normalizeQuality } from '../parser/normalizers.js';
import { exceedsDeleteRatio, deleteRatioError } from './guard.js';

/**
 * Una lista de idiomas que sólo trae el título se fusiona con la de la BD.
 * Mismo resultado que `[...new Set([...a, ...b])]` pero sin crear un Set ni dos
 * arrays intermedios por fila (esto corre sobre tablas enteras).
 */
const mergeLanguages = (fromRow, fromTitle) => {
  if (!fromTitle.length) return fromRow;
  if (!fromRow.length) return fromTitle;
  let out = fromRow;
  for (const l of fromTitle) {
    if (out.includes(l)) continue;
    if (out === fromRow) out = fromRow.slice();
    out.push(l);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Union-Find para unir identificadores de la misma obra
// ---------------------------------------------------------------------------
class UnionFind {
  constructor() {
    this.parent = new Map();
    /** Tamaño de cada árbol: unir el pequeño bajo el grande evita cadenas largas
     *  (con tablas de cientos de miles de filas la diferencia se nota). */
    this.size = new Map();
  }
  find(x) {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.size.set(x, 1);
    }
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // Compresión de caminos completa.
    while (this.parent.get(x) !== root) { const next = this.parent.get(x); this.parent.set(x, root); x = next; }
    return root;
  }
  union(a, b) {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    const sa = this.size.get(ra) ?? 1;
    const sb = this.size.get(rb) ?? 1;
    if (sa < sb) [ra, rb] = [rb, ra];
    this.parent.set(rb, ra);
    this.size.set(ra, sa + sb);
    this.size.delete(rb);
  }
}

const isMissing = (v) => v === null || v === undefined || v === '' || v === 0;

/** Identificadores de obra de una fila, en orden de preferencia. */
export function workIdentifiers(row, parsed) {
  const type = row.type || parsed.type;
  const tmdbKind = type === 'movie' ? 'movie' : 'tv';
  const ids = [];
  if (!isMissing(row.imdb_id)) ids.push(`imdb:${String(row.imdb_id).trim().toLowerCase()}`);
  if (!isMissing(row.tmdb_id)) ids.push(`tmdb:${tmdbKind}:${row.tmdb_id}`);
  if (!isMissing(row.anilist_id)) ids.push(`anilist:${row.anilist_id}`);
  if (!isMissing(row.kitsu_id)) ids.push(`kitsu:${row.kitsu_id}`);
  if (!isMissing(row.mal_id)) ids.push(`mal:${row.mal_id}`);
  return ids;
}

const toInt = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/** Clave de episodio dentro de una obra. */
export function episodeKey(row, parsed) {
  const type = row.type || parsed.type;
  const season = toInt(row.season) ?? parsed.season;
  const episode = toInt(row.episode) ?? parsed.episode;
  const absolute = toInt(row.absolute_episode) ?? parsed.absoluteEpisode;

  if (type === 'movie' && episode === null && season === null) return 'movie';
  if (episode !== null) {
    // Un pack S01E01-E10 no es el episodio 1: si compartieran clave, el pack
    // borraría el episodio suelto (o al revés) y se perderían el resto de capítulos.
    const end = parsed.episodeEnd;
    const range = end != null && end !== episode ? `-e${end}` : '';
    // En anime, "sin temporada" y "temporada 1" se refieren normalmente al mismo episodio.
    if (type === 'anime' && (season === null || season === 1)) return `e${episode}${range}`;
    if (season !== null) return `s${season}e${episode}${range}`;
    return `e${episode}${range}`;
  }
  if (absolute !== null) return `e${absolute}`;
  if (season !== null) {
    // S01-S03 no es el pack de la temporada 1: si compartieran clave, uno borraría al otro.
    const end = parsed.seasonEnd;
    const range = end != null && end !== season ? `-s${end}` : '';
    return `s${season}${range}pack`;
  }
  return parsed.isComplete ? 'complete' : 'full';
}

// ---------------------------------------------------------------------------
// Puntuación de compatibilidad con Stremio
// ---------------------------------------------------------------------------
const CODEC_SCORE = { h264: 40, hevc: 25, vp9: 0, av1: -20, mpeg2: -30, xvid: -30, vc1: -20 };
const CONTAINER_SCORE = { mp4: 15, mkv: 10, m4v: 5, webm: 0, ts: -20, m2ts: -20, avi: -25, mpg: -25, mpeg: -25, wmv: -40, flv: -40, rmvb: -50, iso: -100 };
const SOURCE_SCORE = { remux: 8, bluray: 12, 'web-dl': 12, webrip: 8, hdtv: 2, hdrip: 0, dvd: -8, dvdrip: -8, vhs: -30, screener: -50, telecine: -70, telesync: -80, cam: -90 };
const QUALITY_SCORE = { '2160p': 6, '1080p': 15, '720p': 8, '576p': -2, '480p': -6, '360p': -15 };
const AUDIO_SCORE = { aac: 8, ac3: 6, eac3: 6, opus: 3, mp3: 0, atmos: 0, flac: -5, dts: -8, truehd: -10, pcm: -10 };
const HDR_SCORE = { dv: -25, 'hdr10+': -10, hdr10: -8, hdr: -8, hlg: -5, sdr: 0 };

/**
 * Calcula la puntuación de un torrent.
 * @returns {{ score:number, breakdown:object }}
 */
export function scoreTorrent(row, parsed, { seederWeight = 20 } = {}) {
  const seeders = Math.max(0, toInt(row.seeders) ?? 0);
  const codec = normalizeCodec(row.codec) || parsed.codec;
  const quality = normalizeQuality(row.quality) || parsed.quality;
  const breakdown = {
    seeders: Math.log2(1 + seeders) * seederWeight,
    codec: CODEC_SCORE[codec] ?? 0,
    container: CONTAINER_SCORE[parsed.container] ?? 0,
    source: SOURCE_SCORE[parsed.source] ?? 0,
    quality: QUALITY_SCORE[quality] ?? 0,
    audio: AUDIO_SCORE[parsed.audioCodec] ?? 0,
    hdr: HDR_SCORE[parsed.hdr] ?? 0,
    extras: 0,
  };
  if (parsed.bitDepth === 10 && codec !== 'hevc') breakdown.extras -= 5; // Hi10P (x264 10bit) es problemático
  if (parsed.flags.includes('repack') || parsed.flags.includes('proper')) breakdown.extras += 2;
  if (parsed.languages.dual) breakdown.extras += 4;
  const size = toInt(row.size_bytes) ?? 0;
  if (size > 30 * 1024 ** 3) breakdown.extras -= 10; // > 30 GB: pesado para streaming
  if (size > 0 && size < 300 * 1024 ** 2 && quality === '1080p') breakdown.extras -= 10; // 1080p sospechosamente pequeño

  // Suma directa en vez de crear un array con Object.values() por fila.
  const score = breakdown.seeders + breakdown.codec + breakdown.container + breakdown.source
    + breakdown.quality + breakdown.audio + breakdown.hdr + breakdown.extras;
  return { score, breakdown };
}

/** Comparador: mayor score, luego más seeders, luego más reciente, luego mayor tamaño. */
function compareCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const sa = toInt(a.row.seeders) ?? 0;
  const sb = toInt(b.row.seeders) ?? 0;
  if (sb !== sa) return sb - sa;
  const ua = Date.parse(a.row.updated_at || 0) || 0;
  const ub = Date.parse(b.row.updated_at || 0) || 0;
  if (ub !== ua) return ub - ua;
  return (toInt(b.row.size_bytes) ?? 0) - (toInt(a.row.size_bytes) ?? 0);
}

/**
 * Margen de puntuación en el que se prefiere el idioma en el AUDIO.
 *
 * Un doblaje al español es mejor experiencia que un "sólo subtítulos" (VOSE) para
 * el usuario de Stremio, pero los seeders mandan: un VOSE con muchos más seeders
 * se ve y el doblaje con cuatro seeders puede que no. Por eso el desempate sólo
 * se aplica cuando están casi empatados: 10 puntos ≈ la mitad de una duplicación
 * de seeders (con peso 20, cada duplicación vale 20 puntos).
 */
export const AUDIO_TIE_MARGIN = 10;

/**
 * Reordena (si procede) para que el mejor candidato con el idioma en el audio
 * quede primero, siempre que no esté a más de `AUDIO_TIE_MARGIN` puntos del mejor.
 * @param {object[]} ranked ya ordenado de mejor a peor
 * @param {'spanish'|'english'} flag qué campo de audio mirar (`spanishAudio`/`englishAudio`)
 */
function preferAudioMatch(ranked, flag) {
  if (ranked.length < 2) return ranked;
  const field = flag === 'spanish' ? 'spanishAudio' : 'englishAudio';
  if (ranked[0][field] === true) return ranked;
  const alt = ranked.find((c, i) => i > 0 && c[field] === true && ranked[0].score - c.score <= AUDIO_TIE_MARGIN);
  if (!alt) return ranked;
  return [alt, ...ranked.filter((c) => c !== alt)];
}

/**
 * Decide qué filas conservar y cuáles borrar dentro de un grupo obra+episodio.
 * Función pura (testeable).
 * @param {Array<{row:object, score:number, lang:object, spanishAudio?:boolean, englishAudio?:boolean}>} candidates
 * @param {object} dedupeConfig
 * @returns {{ keep: Set<any>, remove: any[] }}
 */
export function selectSurvivors(candidates, dedupeConfig) {
  const keep = new Set();
  if (candidates.length <= 1) {
    for (const c of candidates) keep.add(c.row.id);
    return { keep, remove: [] };
  }
  const { otherLanguagePolicy, unknownLanguageAs } = dedupeConfig;

  const spanish = [];
  const english = [];
  const untouched = [];
  for (const c of candidates) {
    let { spanish: es, english: en, unknown, other } = c.lang;
    if (unknown) {
      if (unknownLanguageAs === 'english') en = true;
      else if (unknownLanguageAs === 'spanish') es = true;
      else untouched.push(c);
    }
    if (other && otherLanguagePolicy === 'keep') untouched.push(c);
    if (es) spanish.push(c);
    if (en) english.push(c);
  }
  spanish.sort(compareCandidates);
  english.sort(compareCandidates);
  // Entre candidatos casi empatados, el doblaje gana al "sólo subtítulos".
  const esRanked = preferAudioMatch(spanish, 'spanish');
  const enRanked = preferAudioMatch(english, 'english');
  if (esRanked.length) keep.add(esRanked[0].row.id);
  if (enRanked.length) keep.add(enRanked[0].row.id);
  for (const c of untouched) keep.add(c.row.id);

  // Dos copias en francés (u otro idioma) no deben borrarse mutuamente: si no queda
  // ningún superviviente es/en, se conserva el mejor en vez de vaciar la obra.
  if (!keep.size && candidates.length) {
    const best = [...candidates].sort(compareCandidates)[0];
    keep.add(best.row.id);
  }

  const remove = candidates.filter((c) => !keep.has(c.row.id)).map((c) => c.row.id);
  return { keep, remove };
}

export async function runDeduplicator(db, config, log) {
  const select = 'id,imdb_id,tmdb_id,anilist_id,kitsu_id,mal_id,type,season,episode,absolute_episode,seeders,size_bytes,codec,quality,audio,subtitles,title,updated_at';
  const uf = new UnionFind();
  /** filas compactas: [{ id, ids[], epKey, score, lang, row }] */
  const entries = [];
  let scanned = 0;
  let skippedNoId = 0;
  let fallbackTitleRows = 0;
  let ambiguousTitleLinks = 0;
  const titleOnlyKeys = new Set();
  /** Guarda los grupos con ID para conectarlos sólo si el alias no es ambiguo. */
  const titleToExternalIds = new Map();

  const applyFilters = (q) => (config.dedupe.fallbackTitleKey
    ? q
    : q.or('imdb_id.not.is.null,tmdb_id.not.is.null,anilist_id.not.is.null,kitsu_id.not.is.null,mal_id.not.is.null'));
  if (!config.dedupe.fallbackTitleKey) {
    log.warn('dedupe: DEDUP_FALLBACK_TITLE_KEY=false; se ignorarán las filas sin ningún ID externo.');
  }

  for await (const page of db.iterateRows({ select, applyFilters })) {
    for (const row of page) {
      scanned += 1;
      const parsed = parseTitle(row.title);
      let ids = workIdentifiers(row, parsed);

      // Una misma obra puede tener filas mezcladas: unas con ID de TMDB/IMDb y
      // otras sin ningún ID. El título normalizado + tipo + año agrupa las que no
      // tienen ID; luego sólo las enlaza con IDs si hay un único grupo de IDs posible.
      // Así evitamos fusionar remakes/obras homónimas sólo por compartir el nombre.
      const titleKey = config.dedupe.fallbackTitleKey && parsed.searchKey.length >= 3
        ? `title:${String(row.type || parsed.type || 'unknown').toLowerCase()}:${parsed.searchKey}:${parsed.year ?? ''}`
        : null;
      if (ids.length && titleKey) {
        let owners = titleToExternalIds.get(titleKey);
        if (!owners) { owners = new Set(); titleToExternalIds.set(titleKey, owners); }
        owners.add(ids[0]);
      } else if (titleKey) {
        ids = [titleKey];
        titleOnlyKeys.add(titleKey);
        fallbackTitleRows += 1;
      }
      if (!ids.length) { skippedNoId += 1; continue; }
      for (let i = 1; i < ids.length; i += 1) uf.union(ids[0], ids[i]);

      const audio = mergeLanguages(normalizeLanguageArray(row.audio), parsed.languages.audio);
      const subtitles = mergeLanguages(normalizeLanguageArray(row.subtitles), parsed.languages.subtitles);
      const lang = classifyLanguage({ audio, subtitles });
      const { score } = scoreTorrent(row, parsed, { seederWeight: config.dedupe.seederWeight });

      // Sólo lo imprescindible: la tabla entera cabe en memoria durante el paso,
      // así que cada campo de más se multiplica por cientos de miles de filas.
      entries.push({
        primaryId: ids[0],
        epKey: episodeKey(row, parsed),
        score,
        lang,
        // El idioma "de verdad" (audio) se distingue de los subtítulos: sirve para
        // desempatar entre un doblaje y un VOSE cuando están igualados.
        spanishAudio: audio.some((l) => SPANISH_GROUP.has(l)) || undefined,
        englishAudio: audio.some((l) => ENGLISH_GROUP.has(l)) || undefined,
        row: { id: row.id, seeders: row.seeders, size_bytes: row.size_bytes, updated_at: row.updated_at, title: row.title },
      });
    }
    if (scanned % (config.pageSize * 20) === 0) log.info(`dedupe: ${scanned} filas cargadas...`);
  }

  // Conecta los grupos por título con los que sí tenían IDs. Si dos o más grupos
  // de IDs diferentes comparten título/tipo/año, el alias es ambiguo y no se usa.
  for (const titleKey of titleOnlyKeys) {
    const owners = titleToExternalIds.get(titleKey);
    if (!owners?.size) continue;
    const roots = new Set([...owners].map((id) => uf.find(id)));
    if (roots.size === 1) uf.union(titleKey, roots.values().next().value);
    else ambiguousTitleLinks += 1;
  }

  // --- Agrupar por obra → episodio ---
  // Map anidado en lugar de una clave de texto (`raíz|episodio`) por fila: evita
  // crear y comparar cientos de miles de cadenas y deja el episodio a mano.
  /** @type {Map<string, Map<string, object[]>>} */
  const groups = new Map();
  for (const e of entries) {
    const root = uf.find(e.primaryId);
    let byEpisode = groups.get(root);
    if (!byEpisode) { byEpisode = new Map(); groups.set(root, byEpisode); }
    let bucket = byEpisode.get(e.epKey);
    if (!bucket) { bucket = []; byEpisode.set(e.epKey, bucket); }
    bucket.push(e);
  }

  // --- Seleccionar supervivientes ---
  const toDelete = [];
  let groupCount = 0;
  let groupsWithDuplicates = 0;
  let unknownEpisodeGroups = 0;
  let unknownEpisodeRows = 0;
  let sampleLogged = 0;
  for (const [root, byEpisode] of groups) {
    for (const [epKey, candidates] of byEpisode) {
      groupCount += 1;
      if (candidates.length < 2) continue;
      // Episodio NO identificable (`full`): no se borra nada. Dos releases
      // "Serie 1080p WEB-DL" y "Serie 720p HDTV" pueden ser dos episodios
      // distintos cuyo título no traía número; agruparlos por la fuerza borraría
      // la única copia de uno de ellos. Se dejan intactos y se informa.
      if (epKey === 'full') {
        unknownEpisodeGroups += 1;
        unknownEpisodeRows += candidates.length;
        continue;
      }
      const { keep, remove } = selectSurvivors(candidates, config.dedupe);
      if (!remove.length) continue;
      groupsWithDuplicates += 1;
      toDelete.push(...remove);
      if (sampleLogged < 15) {
        sampleLogged += 1;
        const kept = candidates.filter((c) => keep.has(c.row.id)).map((c) => `✓ [${c.score.toFixed(0)}] ${c.row.title}`);
        const removed = candidates.filter((c) => !keep.has(c.row.id)).map((c) => `✗ [${c.score.toFixed(0)}] ${c.row.title}`);
        log.debug(`dedupe grupo ${root} ${epKey}:\n   ${[...kept, ...removed].join('\n   ')}`);
      }
    }
  }

  // --- Salvaguarda ---
  const ratio = entries.length ? toDelete.length / entries.length : 0;
  if (unknownEpisodeGroups > 0) {
    log.info(`dedupe: ${unknownEpisodeRows} filas en ${unknownEpisodeGroups} grupos sin episodio identificable se dejan intactas (no se puede saber si son el mismo episodio)`);
  }
  if (ambiguousTitleLinks > 0) {
    log.info(`dedupe: ${ambiguousTitleLinks} alias título/tipo/año ambiguos no se usaron para enlazar IDs distintos`);
  }
  log.info(`dedupe: ${scanned} filas (${fallbackTitleRows} sin IDs agrupadas por título/año, ${skippedNoId} sin clave de obra ignoradas), ${groupCount} grupos obra+episodio, ${groupsWithDuplicates} con duplicados → ${toDelete.length} a eliminar (${(ratio * 100).toFixed(1)}%)`);
  if (exceedsDeleteRatio(toDelete.length, entries.length, config.maxDeleteRatio)) {
    throw deleteRatioError('dedupe', toDelete.length, entries.length, config.maxDeleteRatio);
  }

  const deleted = await db.deleteByIds(toDelete, 'dedupe');
  if (config.dryRun) {
    log.info(`Deduplicador: ${deleted} torrents excedentes se eliminarían (DRY_RUN; no se borró nada)`);
  } else {
    log.info(`Deduplicador: ${deleted} torrents excedentes eliminados`);
  }
  return {
    scanned,
    skippedNoId,
    fallbackTitleRows,
    ambiguousTitleLinks,
    groups: groupCount,
    groupsWithDuplicates,
    deleted,
    ...(config.dryRun ? { plannedDeletes: deleted } : {}),
    skippedUnknownEpisode: unknownEpisodeRows,
  };
}
