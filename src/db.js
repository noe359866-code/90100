/**
 * Capa de acceso a Supabase.
 *
 *  - Paginación keyset por `id` (funciona con uuid y bigint, sin OFFSET lento)
 *  - Borrados por lotes con reintentos (evita statement timeouts en tablas grandes)
 *  - Actualizaciones masivas mediante la RPC `bulk_update_torrents` (ver sql/)
 *    con fallback automático a UPDATE fila a fila con concurrencia limitada
 *  - Soporte de DRY_RUN: nunca escribe, sólo cuenta
 */
import { createClient } from '@supabase/supabase-js';
import { chunk, mapWithConcurrency, sleep, withRetry } from './utils/async.js';
import { log } from './logger.js';

/** Códigos/mensajes que consideramos transitorios y reintentables. */
const TRANSIENT_CODES = new Set(['57014', '40001', '40P01', '08006', '08003', '08000', '53300', '53400', 'PGRST301', 'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003']);
const TRANSIENT_TEXT = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timeout|timed out|too many connections|network|502|503|504|429/i;

/** Errores de datos (CHECK, varchar, tipo): reintentar el lote no los arregla. */
const DATA_ERROR = /^(23514|23502|23503|23505|22001|22003|22P02|22007|42804)$/;
function isDataError(err) {
  if (err?.code && DATA_ERROR.test(String(err.code))) return true;
  return /check constraint|value too long|invalid input syntax|invalid input value/i.test(String(err?.message || ''));
}

function isTransient(err) {
  if (!err) return false;
  if (err.code && TRANSIENT_CODES.has(String(err.code))) return true;
  if (err.status && (err.status === 429 || err.status >= 500)) return true;
  return TRANSIENT_TEXT.test(String(err.message || err));
}

class DbError extends Error {
  constructor(label, error) {
    super(`${label}: ${error?.message || error} ${error?.code ? `(code ${error.code})` : ''}${error?.details ? ` — ${error.details}` : ''}`);
    this.name = 'DbError';
    this.code = error?.code;
    this.status = error?.status;
    this.details = error?.details;
    this.hint = error?.hint;
  }
}

/**
 * Ejecuta una consulta de supabase-js (`() => builder`) desenvolviendo `{data, error}`
 * y reintentando errores transitorios.
 */
async function run(label, buildQuery, { retries = 4 } = {}) {
  return withRetry(
    async () => {
      let res;
      try {
        res = await buildQuery();
      } catch (err) {
        throw new DbError(label, err);
      }
      if (res.error) throw new DbError(label, res.error);
      return res;
    },
    {
      retries,
      shouldRetry: isTransient,
      onRetry: (err, attempt, wait) => log.warn(`${label}: reintento ${attempt} en ${Math.round(wait)}ms → ${err.message}`),
    },
  );
}

/**
 * @param {import('./config.js').config} config
 * @param {{ client?: any }} [deps] cliente inyectable (tests)
 */
export function createDb(config, { client } = {}) {
  const supabase = client || createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { 'x-application-name': 'torrents-maintenance' },
      // Evita que una consulta colgada bloquee el job hasta el timeout de Actions.
      fetch: (url, options = {}) => fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(120_000) }),
    },
  });

  const table = () => supabase.from(config.table);
  let rpcAvailable = null; // null = desconocido, true/false tras el primer intento

  const stats = { deleted: 0, updated: 0, deleteCalls: 0, updateCalls: 0, selectCalls: 0 };

  /**
   * Itera todas las filas que cumplan `applyFilters(query)` en páginas ordenadas por id.
   * @param {object} p
   * @param {string} p.select
   * @param {(q: any) => any} [p.applyFilters]
   * @param {number} [p.pageSize]
   * @param {number} [p.prefetch] páginas en vuelo simultáneas (1 = secuencial, como
   *   siempre; 2-3 solapa la petición de la página siguiente con el procesado de la
   *   actual). El orden de entrega y el cursor keyset no cambian.
   */
  async function* iterateRows({ select, applyFilters = (q) => q, pageSize = config.pageSize, prefetch = 1 }) {
    const depth = Math.max(1, Math.min(Number(prefetch) || 1, 8));
    let lastId = null;
    let exhausted = false;

    // Cursor keyset: cada página necesita el último id de la anterior. Encadenamos
    // promesas para mantener hasta `depth` peticiones en vuelo; la cadena decide el
    // cursor, así que las páginas se entregan en orden y no hay solapes de filas.
    let tail = Promise.resolve(null);
    const pending = [];
    const schedule = () => {
      if (exhausted) return;
      tail = tail.then((prevPage) => {
        if (exhausted) return null;
        if (prevPage) {
          if (prevPage.length < pageSize) {
            exhausted = true; // era la última página
            return null;
          }
          lastId = prevPage[prevPage.length - 1].id;
        }
        return run('select page', () => {
          let q = table().select(select).order('id', { ascending: true }).limit(pageSize);
          if (lastId !== null) q = q.gt('id', lastId);
          return applyFilters(q);
        }).then((res) => {
          stats.selectCalls += 1;
          return res.data ?? [];
        }, (err) => {
          exhausted = true;
          throw err;
        });
      });
      pending.push(tail);
    };

    try {
      while (true) {
        while (!exhausted && pending.length < depth) schedule();
        const page = await pending.shift();
        if (!page || page.length === 0) return;
        yield page;
      }
    } finally {
      exhausted = true;
      // Si el consumidor corta antes o una página falla, el resto de la cadena
      // rechaza con el mismo error: lo marcamos como manejado (si no, Node
      // interpretaría cada eslabón pendiente como unhandledRejection).
      for (const p of pending) p.catch(() => {});
      pending.length = 0;
    }
  }

  /** Cuenta filas que cumplen los filtros (HEAD request, sin traer datos). */
  async function countWhere(applyFilters, label = 'count') {
    const { count } = await run(label, () => applyFilters(table().select('id', { count: 'exact', head: true })));
    return count ?? 0;
  }

  /** Borra por lista de ids, en trozos. Respeta DRY_RUN. Devuelve nº de ids procesados. */
  async function deleteByIds(ids, label = 'delete') {
    const unique = [...new Set(ids)];
    if (!unique.length) return 0;
    if (config.dryRun) {
      log.info(`[DRY_RUN] ${label}: se borrarían ${unique.length} filas`);
      stats.deleted += unique.length;
      return unique.length;
    }
    let total = 0;
    for (const part of chunk(unique, config.deleteChunkSize)) {
      const { count } = await run(`${label} (chunk ${part.length})`, () =>
        table().delete({ count: 'exact' }).in('id', part));
      stats.deleteCalls += 1;
      total += count ?? part.length;
    }
    stats.deleted += total;
    return total;
  }

  /**
   * Borra todas las filas que cumplan `applyFilters`, en bucle por lotes:
   * SELECT ids LIMIT n → DELETE WHERE id IN (...) → repetir hasta vaciar.
   * Es más robusto que un único DELETE masivo (sin statement timeout ni locks largos).
   *
   * @param {(q:any)=>any} applyFilters  se aplica tanto al SELECT como al DELETE
   * @param {string} label
   * @param {{ preview?: (rows:any[]) => void, select?: string, confirm?: (row:any)=>boolean }} [opts]
   *   `confirm`: filtro adicional en cliente (p. ej. regex precisa) — las filas que no lo pasen no se borran.
   */
  async function deleteWhere(applyFilters, label, { select = 'id', confirm } = {}) {
    if (config.dryRun) {
      if (!confirm) {
        const n = await countWhere(applyFilters, `${label} (count)`);
        log.info(`[DRY_RUN] ${label}: se borrarían ${n} filas`);
        stats.deleted += n;
        return n;
      }
      // Con filtro en cliente hay que revisar las filas candidatas una a una.
      let n = 0;
      for await (const page of iterateRows({ select, applyFilters })) {
        n += page.filter(confirm).length;
      }
      log.info(`[DRY_RUN] ${label}: se borrarían ${n} filas`);
      stats.deleted += n;
      return n;
    }

    let total = 0;
    let lastId = null; // cursor keyset; sólo avanza cuando quedan filas sin borrar en el lote
    let stagnant = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data } = await run(`${label} (select batch)`, () => {
        let q = table().select(select).order('id', { ascending: true }).limit(config.deleteChunkSize);
        if (lastId !== null) q = q.gt('id', lastId);
        return applyFilters(q);
      });
      stats.selectCalls += 1;
      if (!data || data.length === 0) break;

      const targets = confirm ? data.filter(confirm) : data;
      let deleted = 0;
      if (targets.length) {
        const { count } = await run(`${label} (delete batch)`, () =>
          applyFilters(table().delete({ count: 'exact' }).in('id', targets.map((r) => r.id))));
        stats.deleteCalls += 1;
        deleted = count ?? targets.length;
        total += deleted;
      }

      if (confirm) {
        // Con filtro en cliente pueden quedar filas candidatas no borradas → avanzamos siempre.
        lastId = data[data.length - 1].id;
      } else if (deleted === 0) {
        // Nada borrado (¿RLS/permisos?): avanzamos para no repetir el mismo lote infinitamente.
        stagnant += 1;
        lastId = data[data.length - 1].id;
        if (stagnant >= 3) {
          log.warn(`${label}: los borrados no progresan (¿RLS/permisos?), se detiene el bucle`);
          break;
        }
      } else {
        stagnant = 0; // sin cursor: las filas borradas desaparecen y el siguiente SELECT trae las siguientes
      }

      if (data.length < config.deleteChunkSize) break; // era la última página de candidatos
      await sleep(25); // pequeño respiro para no saturar la BD
    }
    stats.deleted += total;
    return total;
  }

  /** Intenta la RPC de actualización masiva. Devuelve nº de filas o `null` si la RPC no existe. */
  async function tryBulkRpc(updates) {
    if (rpcAvailable === false) return null;
    try {
      const { data } = await run('rpc bulk_update_torrents', () =>
        supabase.rpc('bulk_update_torrents', { updates }), { retries: 2 });
      rpcAvailable = true;
      return typeof data === 'number' ? data : updates.length;
    } catch (err) {
      const missing = /PGRST202|42883|Could not find the function|does not exist/i.test(`${err.code} ${err.message}`);
      if (missing && rpcAvailable === null) {
        rpcAvailable = false;
        log.warn('RPC bulk_update_torrents no disponible (ejecuta sql/002_bulk_update_rpc.sql para acelerar). Usando UPDATE fila a fila.');
        return null;
      }
      throw err;
    }
  }

  /**
   * Aplica una lista de actualizaciones `[{ id, patch }]`.
   * Usa la RPC si existe; si no, UPDATE por fila con concurrencia limitada.
   */
  async function updateRows(updates, label = 'update') {
    const valid = updates.filter((u) => u && u.id !== undefined && u.patch && Object.keys(u.patch).length);
    if (!valid.length) return 0;
    if (config.dryRun) {
      log.info(`[DRY_RUN] ${label}: se actualizarían ${valid.length} filas`);
      log.debug(`[DRY_RUN] ejemplo: ${JSON.stringify(valid[0])}`);
      stats.updated += valid.length;
      return valid.length;
    }

    let total = 0;
    const applyOne = async (u) => {
      try {
        await run(`${label} id=${u.id}`, () => table().update(u.patch).eq('id', u.id));
        stats.updateCalls += 1;
        return 1;
      } catch (err) {
        if (!isDataError(err)) throw err;
        log.warn(`${label}: se omite id=${u.id} (no cumple el schema: ${err.message})`);
        return 0;
      }
    };
    for (const part of chunk(valid, config.updateChunkSize ?? 500)) {
      let viaRpc = null;
      try {
        viaRpc = await tryBulkRpc(part.map((u) => ({ id: String(u.id), patch: u.patch })));
      } catch (err) {
        // Un CHECK/varchar en una fila tumba el lote entero. No es que falte la RPC:
        // se aísla fila a fila y se sigue con el resto.
        if (!isDataError(err)) throw err;
        log.warn(`${label}: la RPC rechazó el lote (${err.code || 'datos'}). Reintentando fila a fila.`);
        viaRpc = null;
      }
      if (viaRpc !== null) {
        stats.updateCalls += 1;
        total += viaRpc;
        continue;
      }
      const results = await mapWithConcurrency(part, config.updateConcurrency, applyOne);
      total += results.reduce((a, b) => a + b, 0);
    }
    stats.updated += total;
    return total;
  }

  /** Comprobación de conectividad/permisos al arrancar. */
  async function healthcheck() {
    const { count } = await run('healthcheck', () => table().select('id', { count: 'estimated', head: true }));
    return count ?? 0;
  }

  return { supabase, table, iterateRows, countWhere, deleteByIds, deleteWhere, updateRows, healthcheck, isRpcAvailable: () => rpcAvailable === true, stats };
}
