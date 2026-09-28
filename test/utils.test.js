/**
 * Utilidades de colecciones/concurrencia (`src/utils/async.js`, `src/utils/text.js`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, mapWithConcurrency } from '../src/utils/async.js';

test('chunk: reparte en trozos del tamaño pedido', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([1, 2, 3, 4], 4), [[1, 2, 3, 4]]);
  assert.deepEqual(chunk([], 3), []);
});

test('chunk: un tamaño inválido no provoca un bucle infinito', () => {
  // Antes: size=0 (o NaN) dejaba el índice quieto y el bucle no terminaba.
  assert.deepEqual(chunk([1, 2, 3], 0), [[1], [2], [3]]);
  assert.deepEqual(chunk([1, 2, 3], -5), [[1], [2], [3]]);
  assert.deepEqual(chunk([1, 2, 3], undefined), [[1], [2], [3]]);
  assert.deepEqual(chunk([1, 2, 3], NaN), [[1], [2], [3]]);
  assert.deepEqual(chunk([1, 2, 3], 1.9), [[1], [2], [3]]);
});

test('mapWithConcurrency: conserva el orden y respeta el límite', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10]);
  assert.ok(peak <= 2, `no debería pasar de 2 en vuelo (fue ${peak})`);
});

test('mapWithConcurrency: una lista vacía no lanza y un límite mayor que la lista funciona', async () => {
  assert.deepEqual(await mapWithConcurrency([], 5, async (n) => n), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 99, async (n) => n + 1), [2, 3]);
});

test('mapWithConcurrency: propaga el primer error', async () => {
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }),
    /boom/,
  );
});
