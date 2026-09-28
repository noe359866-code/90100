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
 *     Se usa union-find para unir filas de la misma obra aunque tengan IDs
 *     distintos (una fila con imdb+tmdb enlaza ambas claves).
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
import { classifyLanguage, normalizeLanguageArray } from '../parser/languages.js';
import { normalizeCodec, normalizeQuality } from '../parser/normalizers.js';
import { exceedsDeleteRatio, deleteRatioError } from './guard.js';

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

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
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
 * Decide qué filas conservar y cuáles borrar dentro de un grupo obra+episodio.
 * Función pura (testeable).
 * @param {Array<{row:object, score:number, lang:object}>} candidates
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
  if (spanish.length) keep.add(spanish[0].row.id);
  if (english.length) keep.add(english[0].row.id);
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

  const applyFilters = (q) => (config.dedupe.fallbackTitleKey
    ? q
    : q.or('imdb_id.not.is.null,tmdb_id.not.is.null,anilist_id.not.is.null,kitsu_id.not.is.null,mal_id.not.is.null'));

  for await (const page of db.iterateRows({ select, applyFilters })) {
    for (const row of page) {
      scanned += 1;
      const parsed = parseTitle(row.title);
      let ids = workIdentifiers(row, parsed);
      if (!ids.length) {
        if (!config.dedupe.fallbackTitleKey || !parsed.searchKey) { skippedNoId += 1; continue; }
        ids = [`title:${row.type || parsed.type}:${parsed.searchKey}:${parsed.year ?? ''}`];
      }
      for (let i = 1; i < ids.length; i += 1) uf.union(ids[0], ids[i]);
      uf.find(ids[0]);

      const audio = [...new Set([...normalizeLanguageArray(row.audio), ...parsed.languages.audio])];
      const subtitles = [...new Set([...normalizeLanguageArray(row.subtitles), ...parsed.languages.subtitles])];
      const lang = classifyLanguage({ audio, subtitles });
      const { score } = scoreTorrent(row, parsed, { seederWeight: config.dedupe.seederWeight });

      // Sólo lo imprescindible: la tabla entera cabe en memoria durante el paso,
      // así que cada campo de más se multiplica por cientos de miles de filas.
      entries.push({
        primaryId: ids[0],
        epKey: episodeKey(row, parsed),
        score,
        lang,
        row: { id: row.id, seeders: row.seeders, size_bytes: row.size_bytes, updated_at: row.updated_at, title: row.title },
      });
    }
    if (scanned % (config.pageSize * 20) === 0) log.info(`dedupe: ${scanned} filas cargadas...`);
  }

  // --- Agrupar por (raíz de obra, episodio) ---
  const groups = new Map();
  for (const e of entries) {
    const key = `${uf.find(e.primaryId)}|${e.epKey}`;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(e);
  }

  // --- Seleccionar supervivientes ---
  const toDelete = [];
  let groupsWithDuplicates = 0;
  let sampleLogged = 0;
  for (const [key, candidates] of groups) {
    if (candidates.length < 2) continue;
    const { keep, remove } = selectSurvivors(candidates, config.dedupe);
    if (!remove.length) continue;
    groupsWithDuplicates += 1;
    toDelete.push(...remove);
    if (sampleLogged < 15) {
      sampleLogged += 1;
      const kept = candidates.filter((c) => keep.has(c.row.id)).map((c) => `✓ [${c.score.toFixed(0)}] ${c.row.title}`);
      const removed = candidates.filter((c) => !keep.has(c.row.id)).map((c) => `✗ [${c.score.toFixed(0)}] ${c.row.title}`);
      log.debug(`dedupe grupo ${key}:\n   ${[...kept, ...removed].join('\n   ')}`);
    }
  }

  // --- Salvaguarda ---
  const ratio = entries.length ? toDelete.length / entries.length : 0;
  log.info(`dedupe: ${scanned} filas (${skippedNoId} sin IDs ignoradas), ${groups.size} grupos obra+episodio, ${groupsWithDuplicates} con duplicados → ${toDelete.length} a eliminar (${(ratio * 100).toFixed(1)}%)`);
  if (exceedsDeleteRatio(toDelete.length, entries.length, config.maxDeleteRatio)) {
    throw deleteRatioError('dedupe', toDelete.length, entries.length, config.maxDeleteRatio);
  }

  const deleted = await db.deleteByIds(toDelete, 'dedupe');
  log.info(`Deduplicador: ${deleted} torrents excedentes eliminados`);
  return { scanned, skippedNoId, groups: groups.size, groupsWithDuplicates, deleted };
}
