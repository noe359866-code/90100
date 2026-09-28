/**
 * `iterateRows` con `prefetch` > 1 (paginación keyset con páginas en vuelo) y el
 * tamaño de lote de la RPC de updates (`UPDATE_CHUNK_SIZE`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const mkRows = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1,
  title: `Show ${i} 2020 1080p`,
  type: i % 2 ? 'series' : 'movie',
  tmdb_id: null,
  imdb_id: null,
}));

const mkDb = (client, extra = {}) => createDb({
  table: 'torrents',
  dryRun: false,
  supabaseUrl: 'http://example.invalid',
  supabaseKey: 'test',
  ...extra,
}, { client });

test('iterateRows: prefetch > 1 devuelve exactamente las mismas páginas que prefetch 1', async () => {
  const total = 350;
  const collect = async (prefetch) => {
    const { client } = createFakeSupabase(mkRows(total));
    const db = mkDb(client);
    const pages = [];
    for await (const page of db.iterateRows({ select: 'id', pageSize: 100, prefetch })) pages.push(page.map((r) => r.id));
    return pages;
  };
  const sequential = await collect(1);
  const pipelined = await collect(3);

  assert.equal(sequential.length, 4, '350 filas a 100/página = 4 páginas');
  assert.deepEqual(pipelined, sequential);
  const all = pipelined.flat();
  assert.equal(all.length, total);
  assert.equal(new Set(all).size, total, 'sin duplicados');
  assert.deepEqual([...all].sort((a, b) => a - b), all, 'ids en orden ascendente (cursor keyset correcto)');
});

test('iterateRows: con prefetch la última página corta no dispara peticiones extra', async () => {
  const { client } = createFakeSupabase(mkRows(250));
  let queries = 0;
  const origFrom = client.from.bind(client);
  client.from = (table) => {
    queries += 1;
    return origFrom(table);
  };
  const db = mkDb(client);
  const pages = [];
  for await (const page of db.iterateRows({ select: 'id', pageSize: 100, prefetch: 4 })) pages.push(page.length);
  assert.deepEqual(pages, [100, 100, 50]);
  // 3 páginas reales; con prefetch 4 hay hasta 4 cadenas pero la 4ª nunca llega a
  // pedir nada (detecta la página corta antes del fetch). Mínimo: 3 consultas.
  assert.ok(queries >= 3 && queries <= 4, `se hicieron ${queries} consultas`);
});

test('iterateRows: un error en una página intermedia se propaga sin colgar ni duplicar', async () => {
  const { client } = createFakeSupabase(mkRows(400));
  const origFrom = client.from.bind(client);
  client.from = (table) => {
    const q = origFrom(table);
    const origThen = q.then.bind(q);
    // La segunda página en adelante (id > 100) falla de forma no transitoria
    // (sin reintentos). Se comprueba en `then`, cuando el cursor ya está aplicado.
    q.then = (resolve, reject) => {
      if (q.conds.some((c) => c.op === 'gt' && c.val > 100)) {
        return Promise.reject(new Error('boom')).then(resolve, reject);
      }
      return origThen(resolve, reject);
    };
    return q;
  };
  const db = mkDb(client);
  const seen = [];
  await assert.rejects(
    async () => {
      for await (const page of db.iterateRows({ select: 'id', pageSize: 100, prefetch: 3 })) {
        seen.push(page.length);
      }
    },
    /boom/,
  );
  assert.equal(seen.length, 2, 'se entregan las páginas previas al fallo');
  // Respiro para que, si quedara alguna promesa sin manejar, el runner lo registrara.
  await new Promise((r) => setTimeout(r, 20));
});

test('iterateRows: si el consumidor corta antes, las páginas en vuelo no revientan el proceso', async () => {
  const { client } = createFakeSupabase(mkRows(1000));
  const db = mkDb(client);
  let rows = 0;
  for await (const page of db.iterateRows({ select: 'id', pageSize: 100, prefetch: 4 })) {
    rows += page.length;
    if (rows >= 200) break; // corta con páginas todavía en vuelo
  }
  assert.equal(rows, 200);
  await new Promise((r) => setTimeout(r, 20));
});

test('updateRows: respeta config.updateChunkSize al llamar a la RPC', async () => {
  const rows = mkRows(450);
  const { client, store } = createFakeSupabase(rows, { rpc: true });
  const db = mkDb(client, { updateChunkSize: 500 });
  const updates = rows.map((r) => ({ id: r.id, patch: { tmdb_id: 42 } }));
  const updated = await db.updateRows(updates, 'test');
  assert.equal(updated, 450);
  assert.equal(store.rpcCalls, 1, '450 updates caben en un solo lote de 500');

  const { client: c2, store: s2 } = createFakeSupabase(mkRows(450), { rpc: true });
  const db2 = mkDb(c2, { updateChunkSize: 200 });
  await db2.updateRows(updates, 'test');
  assert.equal(s2.rpcCalls, 3, '450 updates a 200/lote = 3 llamadas');
});

/**
 * Cliente mínimo donde una lista de ids es "protegida": el DELETE las acepta pero
 * PostgREST devuelve un `count` menor y las filas siguen ahí (simula RLS/triggers
 * que permiten SELECT pero bloquean DELETE).
 */
function partialDeleteClient(protectedIds) {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `Fila ${i + 1}` }));
  const state = { after: null, limit: null };
  const stats = { selectCalls: 0, deleteCalls: 0, deletedIds: [] };
  const run = (mode, ids) => {
    if (mode === 'delete') {
      stats.deleteCalls += 1;
      const removable = ids.filter((id) => !protectedIds.has(id));
      for (const id of removable) {
        const idx = rows.findIndex((r) => r.id === id);
        if (idx >= 0) rows.splice(idx, 1);
        stats.deletedIds.push(id);
      }
      return { data: null, error: null, count: removable.length };
    }
    stats.selectCalls += 1;
    const data = rows.filter((r) => state.after === null || r.id > state.after).slice(0, state.limit).map((r) => ({ ...r }));
    return { data, error: null, count: null };
  };
  const query = (mode, ids) => {
    const promise = Promise.resolve().then(() => run(mode, ids));
    promise.then = promise.then.bind(promise);
    return promise;
  };
  const from = () => {
    const q = {
      select: () => q,
      order: () => q,
      limit: (n) => { state.limit = n; return q; },
      gt: (_col, value) => { state.after = value; return q; },
      delete: () => ({ in: (_col, ids) => query('delete', ids) }),
      then: (resolve, reject) => query('select').then(resolve, reject),
    };
    return q;
  };
  return { client: { from }, stats, rows };
}

test('deleteWhere: un lote que no se puede borrar entero no bloquea al resto', async () => {
  // ids 1..4 "protegidos": antes el bucle se atascaba reintentando el mismo lote
  // y dejaba sin borrar el resto de la tabla.
  const { client, stats, rows } = partialDeleteClient(new Set([1, 2, 3, 4]));
  const db = createDb({
    table: 'torrents', dryRun: false, deleteChunkSize: 4, pageSize: 50,
    supabaseUrl: 'http://example.invalid', supabaseKey: 'test',
  }, { client });
  const deleted = await db.deleteWhere((q) => q, 'test');
  assert.equal(deleted, 8, 'se borran las 8 filas que sí se pueden borrar');
  assert.deepEqual(rows.map((r) => r.id), [1, 2, 3, 4], 'las protegidas se quedan');
  assert.deepEqual([...stats.deletedIds].sort((a, b) => a - b), [5, 6, 7, 8, 9, 10, 11, 12]);
  // El cursor avanza tras el lote bloqueado: ni se reintenta ni se reenvían ids ya descartados.
  assert.equal(stats.deleteCalls, 3, `sin reintentos inútiles del lote bloqueado (${stats.deleteCalls} DELETEs)`);
  assert.equal(stats.selectCalls, 4);
});

test('deleteWhere: si el mismo lote vuelve a salir sin progresar, se corta', async () => {
  // El SELECT siempre devuelve lo mismo (cursor que no avanza) → red de seguridad.
  const rows = [{ id: 1 }, { id: 2 }];
  let selects = 0;
  const client = {
    from: () => {
      const q = {
        select: () => q, order: () => q, limit: () => q, gt: () => q,
        delete: () => ({ in: () => Promise.resolve({ data: null, error: null, count: 0 }) }),
        then: (resolve) => {
          selects += 1;
          return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(resolve);
        },
      };
      return q;
    },
  };
  const db = createDb({
    table: 'torrents', dryRun: false, deleteChunkSize: 2, pageSize: 50,
    supabaseUrl: 'http://example.invalid', supabaseKey: 'test',
  }, { client });
  const deleted = await db.deleteWhere((q) => q, 'test');
  assert.equal(deleted, 0);
  assert.equal(selects, 4, `no se repite el mismo lote sin fin (${selects} SELECTs)`);
});
