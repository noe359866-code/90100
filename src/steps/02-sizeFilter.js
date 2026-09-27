/**
 * PASO 2 — FILTRO ANTI-FAKES POR TAMAÑO
 *
 *  - `type = 'movie'`  y `size_bytes < MIN_MOVIE_MB`  (150 MB por defecto)
 *  - `type = 'series'` y `size_bytes < MIN_SERIES_MB` (30 MB por defecto)
 *  - opcionalmente `type = 'anime'` con el umbral de series
 *
 * Por defecto se ignoran `size_bytes = 0` / NULL (tamaño desconocido ≠ fake);
 * activa `SIZE_FILTER_INCLUDE_ZERO=true` para incluir los ceros.
 */
export async function runSizeFilter(db, config, log) {
  const { minMovieBytes, minSeriesBytes, applyToAnime, includeZero } = config.size;
  const lowerBound = (q) => (includeZero ? q.not('size_bytes', 'is', null) : q.gt('size_bytes', 0));

  const rules = [
    { label: 'size-filter movie', types: ['movie'], min: minMovieBytes },
    { label: 'size-filter series', types: applyToAnime ? ['series', 'anime'] : ['series'], min: minSeriesBytes },
  ];

  const result = {};
  for (const rule of rules) {
    const deleted = await db.deleteWhere(
      (q) => lowerBound(q.in('type', rule.types).lt('size_bytes', rule.min)),
      rule.label,
    );
    result[rule.types.join('+')] = deleted;
    log.info(`${rule.label}: ${deleted} torrents < ${(rule.min / 1024 / 1024).toFixed(0)} MB eliminados`);
  }
  return result;
}
