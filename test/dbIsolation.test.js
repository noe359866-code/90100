/**
 * Un CHECK de una sola fila no debe abortar el lote entero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';

test('updateRows: aísla una fila que viola un CHECK y actualiza el resto', async () => {
  const rows = [
    { id: 1, title: 'ok' },
    { id: 2, title: 'bad' },
  ];
  const client = {
    from() {
      return {
        update(patch) {
          return {
            eq(_col, id) {
              if (id === 2) {
                return Promise.resolve({ data: null, error: { code: '23514', message: 'new row violates check constraint "imdb_id"' } });
              }
              Object.assign(rows.find((r) => r.id === id), patch);
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
    rpc: async () => ({ data: null, error: { code: '23514', message: 'new row violates check constraint "imdb_id"' } }),
  };
  const db = createDb({
    table: 'torrents',
    dryRun: false,
    updateConcurrency: 2,
    supabaseUrl: 'http://example.invalid',
    supabaseKey: 'test',
  }, { client });
  const updated = await db.updateRows([
    { id: 1, patch: { title_text: 'Bien' } },
    { id: 2, patch: { imdb_id: 'no-es-tt' } },
  ], 'test');
  assert.equal(updated, 1);
  assert.equal(rows[0].title_text, 'Bien');
  assert.equal(rows[1].title, 'bad');
});
