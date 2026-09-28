/**
 * Salvaguarda común de borrado (pasos 1, 2, 3 y 7).
 *
 * Si un paso pretende eliminar más de `MAX_DELETE_RATIO` de las filas que ha
 * evaluado, se aborta en lugar de vaciar la tabla por un filtro mal configurado.
 *
 * Las tablas diminutas quedan fuera del cálculo: con pocas filas el porcentaje es
 * puro ruido (borrar la única película fake de una tabla de 4 filas es 100 % y no
 * es ninguna catástrofe) y provocaba abortos en falso que dejaban el
 * mantenimiento sin borrar nada en tablas pequeñas o recién creadas.
 */

/** Por debajo de este número de filas evaluadas el porcentaje no es significativo. */
export const MIN_ROWS_FOR_RATIO = 10;

/**
 * ¿El borrado propuesto supera el ratio permitido?
 * @param {number} pending   filas que se borrarían
 * @param {number} evaluated filas sobre las que se ha decidido
 * @param {number} maxRatio  0-1 (config.maxDeleteRatio)
 * @param {number} [minRows] filas mínimas para que el ratio se aplique
 */
export function exceedsDeleteRatio(pending, evaluated, maxRatio, minRows = MIN_ROWS_FOR_RATIO) {
  if (!Number.isFinite(pending) || !Number.isFinite(evaluated)) return false;
  if (pending <= 0 || evaluated <= 0) return false;
  if (evaluated < minRows) return false;
  return pending / evaluated > maxRatio;
}

/** Error uniforme para los pasos que abortan por ratio. */
export function deleteRatioError(label, pending, evaluated, maxRatio) {
  const pct = ((pending / evaluated) * 100).toFixed(1);
  return new Error(`${label}: se eliminarían ${pending} de ${evaluated} filas (${pct}%), por encima de MAX_DELETE_RATIO=${maxRatio}. Abortado por seguridad (revisa con DRY_RUN=true o ajusta MAX_DELETE_RATIO).`);
}
