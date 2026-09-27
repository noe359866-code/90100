/**
 * PASO 2 — FILTRO ANTI-FAKES POR TAMAÑO
 *
 *  - `type = 'movie'`  y `size_bytes < MIN_MOVIE_MB`  (150 MB por defecto)
 *  - `type = 'series'` y `size_bytes < MIN_SERIES_MB` (30 MB por defecto)
 *  - opcionalmente `type = 'anime'` con el umbral de series
 *  - `type` NULL: se decide en cliente con el parser, sólo si está seguro.
 *    El filtro de tamaño corre ANTES del normalizador, así que sin esto un fake
 *    sin tipo sobrevive hasta la siguiente ejecución.
 *
 * Por defecto se ignoran `size_bytes = 0` / NULL (tamaño desconocido ≠ fake);
 * activa `SIZE_FILTER_INCLUDE_ZERO=true` para incluir los ceros.
 */
import { parseTitle } from '../parser/titleParser.js';

async function abortIfTooMany(db, config, label, pendingFilters, evaluatedFilters) {
  const [pending, evaluated] = await Promise.all([
    db.countWhere(pendingFilters, `${label} pending`),
    db.countWhere(evaluatedFilters, `${label} evaluated`),
  ]);
  if (evaluated > 0 && pending / evaluated > config.maxDeleteRatio) {
    const pct = ((pending / evaluated) * 100).toFixed(1);
    throw new Error(`${label}: se eliminarían ${pending} de ${evaluated} filas (${pct}%), por encima de MAX_DELETE_RATIO=${config.maxDeleteRatio}. Abortado por seguridad.`);
  }
}

export async function runSizeFilter(db, config, log) {
  const { minMovieBytes, minSeriesBytes, applyToAnime, includeZero } = config.size;
  const lowerBound = (q) => (includeZero ? q.not('size_bytes', 'is', null) : q.gt('size_bytes', 0));

  const rules = [
    { label: 'size-filter movie', types: ['movie'], min: minMovieBytes },
    { label: 'size-filter series', types: applyToAnime ? ['series', 'anime'] : ['series'], min: minSeriesBytes },
  ];

  const result = {};
  for (const rule of rules) {
    const pending = (q) => lowerBound(q.in('type', rule.types).lt('size_bytes', rule.min));
    await abortIfTooMany(db, config, rule.label, pending, (q) => q.in('type', rule.types));
    const deleted = await db.deleteWhere(pending, rule.label);
    result[rule.types.join('+')] = deleted;
    log.info(`${rule.label}: ${deleted} torrents < ${(rule.min / 1024 / 1024).toFixed(0)} MB eliminados`);
  }

  // Sin tipo: el parser sólo decide si está seguro (nunca por debajo de 0.8).
  // El conteo SQL es un techo (confirm() sólo quita filas): si ya supera el ratio, se aborta.
  await abortIfTooMany(
    db,
    config,
    'size-filter untyped',
    (q) => lowerBound(q.is('type', null).lt('size_bytes', minMovieBytes)),
    (q) => q,
  );
  const confidence = Math.max(config.normalize?.typeConfidence ?? 0.8, 0.8);
  const untyped = await db.deleteWhere(
    (q) => lowerBound(q.is('type', null).lt('size_bytes', minMovieBytes)),
    'size-filter untyped',
    {
      select: 'id,title,size_bytes',
      confirm: (row) => {
        const parsed = parseTitle(row.title);
        if (!parsed.cleanTitle || parsed.typeConfidence < confidence) return false;
        const size = Number(row.size_bytes);
        if (!Number.isFinite(size)) return false;
        if (!includeZero && size <= 0) return false;
        if (parsed.type === 'movie') return size < minMovieBytes;
        if (parsed.type === 'series' || (applyToAnime && parsed.type === 'anime')) return size < minSeriesBytes;
        return false;
      },
    },
  );
  if (untyped) {
    result.untyped = untyped;
    log.info(`size-filter untyped: ${untyped} torrents sin tipo y por debajo del umbral eliminados`);
  }
  return result;
}
