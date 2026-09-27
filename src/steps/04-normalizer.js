/**
 * PASO 4 + 5 — NORMALIZADOR DE TÍTULOS, TIPO, EPISODIOS, CODEC/CALIDAD E IDIOMAS
 *
 * Recorre toda la tabla (paginación keyset) y para cada fila:
 *   - Ejecuta el parser inteligente sobre `title`
 *   - `title_text` (columna configurable) ← título limpio para búsquedas
 *   - `type`               ← se rellena si es NULL; se sobrescribe sólo con NORMALIZE_OVERWRITE_TYPE
 *   - season / episode / absolute_episode ← se rellenan si son NULL (o NORMALIZE_OVERWRITE_EPISODES)
 *   - codec / quality      ← normalizados a etiquetas canónicas; se rellenan desde el título si faltan
 *   - audio / subtitles    ← arrays limpios, minúsculas, sin duplicados ni basura; opcionalmente
 *                            fusionados con los idiomas detectados en el título
 *
 * Sólo se envían a la BD las filas cuyo contenido cambia realmente.
 */
import { parseTitle } from '../parser/titleParser.js';
import { normalizeLanguageArray, sameLanguageArray } from '../parser/languages.js';
import { normalizeCodec, normalizeQuality, normalizeType } from '../parser/normalizers.js';

const toIntOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

/**
 * Calcula el parche de normalización de una fila. Función pura (testeable).
 * @returns {object|null} parche con las columnas a actualizar o null si no hay cambios
 */
export function buildNormalizationPatch(row, config) {
  const parsed = parseTitle(row.title);
  const patch = {};
  const opts = config.normalize;
  const cleanCol = config.cleanTitleColumn;

  // --- Título limpio ---
  if (parsed.cleanTitle && parsed.cleanTitle !== (row[cleanCol] ?? '')) {
    patch[cleanCol] = parsed.cleanTitle;
  }

  // --- Tipo ---
  const currentType = normalizeType(row.type);
  if (!currentType) {
    patch.type = parsed.type;
  } else if (currentType !== row.type) {
    patch.type = currentType; // 'Movie' → 'movie'
  } else if (opts.overwriteType && parsed.type !== currentType && parsed.typeConfidence >= opts.typeConfidence) {
    patch.type = parsed.type;
  }
  const finalType = patch.type || currentType;

  // --- Temporada / episodio ---
  const applyEpisodeField = (column, value) => {
    const current = toIntOrNull(row[column]);
    if (value === null || value === undefined) return;
    if (current === null || (opts.overwriteEpisodes && current !== value)) {
      if (current !== value) patch[column] = value;
    }
  };
  if (finalType !== 'movie' || parsed.episode !== null) {
    applyEpisodeField('season', parsed.season);
    applyEpisodeField('episode', parsed.episode);
    applyEpisodeField('absolute_episode', parsed.absoluteEpisode);
  }
  // Coherencia: si el valor almacenado no es entero (p. ej. "09" en texto), lo normalizamos.
  for (const column of ['season', 'episode', 'absolute_episode']) {
    if (row[column] !== null && row[column] !== undefined && typeof row[column] === 'string' && toIntOrNull(row[column]) !== null && !(column in patch)) {
      patch[column] = toIntOrNull(row[column]);
    }
  }

  // --- Codec / calidad ---
  const codec = normalizeCodec(row.codec) || parsed.codec || null;
  if (codec && codec !== row.codec) patch.codec = codec;
  const quality = normalizeQuality(row.quality) || parsed.quality || null;
  if (quality && quality !== row.quality) patch.quality = quality;

  // --- Idiomas ---
  let audio = normalizeLanguageArray(row.audio);
  let subtitles = normalizeLanguageArray(row.subtitles);
  if (opts.mergeTitleLanguages) {
    audio = [...new Set([...audio, ...parsed.languages.audio])].sort();
    subtitles = [...new Set([...subtitles, ...parsed.languages.subtitles])].sort();
  }
  const isEmptyValue = (v) => v === null || v === undefined || (Array.isArray(v) && v.length === 0) || v === '';
  const languagePatch = (column, normalized) => {
    const current = row[column];
    const unchanged = Array.isArray(current) && sameLanguageArray(normalized, current);
    const bothEmpty = normalized.length === 0 && isEmptyValue(current);
    if (!unchanged && !bothEmpty) patch[column] = normalized;
  };
  languagePatch('audio', audio);
  languagePatch('subtitles', subtitles);

  return Object.keys(patch).length ? patch : null;
}

export async function runNormalizer(db, config, log) {
  const cleanCol = config.cleanTitleColumn;
  const select = ['id', 'title', cleanCol, 'type', 'season', 'episode', 'absolute_episode', 'codec', 'quality', 'audio', 'subtitles']
    .filter((c, i, arr) => arr.indexOf(c) === i)
    .join(',');

  let scanned = 0;
  let changed = 0;
  const columnCounts = {};
  const t0 = Date.now();

  for await (const page of db.iterateRows({ select })) {
    const updates = [];
    for (const row of page) {
      scanned += 1;
      let patch = null;
      try {
        patch = buildNormalizationPatch(row, config);
      } catch (err) {
        log.warn(`normalizer: error parseando id=${row.id} "${row.title}": ${err.message}`);
        continue;
      }
      if (!patch) continue;
      for (const k of Object.keys(patch)) columnCounts[k] = (columnCounts[k] || 0) + 1;
      updates.push({ id: row.id, patch });
    }
    if (updates.length) {
      changed += await db.updateRows(updates, 'normalizer');
    }
    if (scanned % (config.pageSize * 10) === 0) {
      log.info(`normalizer: ${scanned} filas analizadas, ${changed} actualizadas (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }

  log.info(`Normalizador: ${scanned} filas analizadas, ${changed} actualizadas. Columnas: ${JSON.stringify(columnCounts)}`);
  return { scanned, changed, columnCounts };
}
