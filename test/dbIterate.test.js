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
