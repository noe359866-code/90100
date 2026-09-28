/**
 * PASO 3 — PURGADOR DE TORRENTS MUERTOS
 *
 * Elimina torrents con `seeders = 0` cuya última actualización (`updated_at`)
 * tenga más de `DEAD_AFTER_DAYS` días (30 por defecto).
 *
 * Con `DEAD_INCLUDE_NULL_SEEDERS=true` también se purgan los `seeders IS NULL`
 * (nunca se ha podido comprobar su salud) con la misma antigüedad.
 */
import { exceedsDeleteRatio, deleteRatioError } from './guard.js';

export async function runDeadPurger(db, config, log) {
  const { afterDays, includeNullSeeders } = config.dead;
  const cutoff = new Date(Date.now() - afterDays * 24 * 60 * 60 * 1000).toISOString();

  const apply = (q) => {
    const base = q.lt('updated_at', cutoff);
    return includeNullSeeders ? base.or('seeders.eq.0,seeders.is.null') : base.eq('seeders', 0);
  };
  const [pending, evaluated] = await Promise.all([
    db.countWhere(apply, 'dead-purger pending'),
    db.countWhere((q) => q, 'dead-purger evaluated'),
  ]);
  if (exceedsDeleteRatio(pending, evaluated, config.maxDeleteRatio)) {
    throw deleteRatioError('dead-purger', pending, evaluated, config.maxDeleteRatio);
  }

  const deleted = await db.deleteWhere(apply, 'dead-purger');

  log.info(`Purga de muertos: ${deleted} torrents con 0 seeders y sin actualizar desde ${cutoff.slice(0, 10)} eliminados`);
  return { deleted, cutoff };
}
