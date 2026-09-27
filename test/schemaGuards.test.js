/**
 * Blindajes frente a las restricciones reales de la tabla
 * (varchar(10)/(20), CHECK de imdb_id, telemetría de IDs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNormalizationPatch, fitToColumn } from '../src/steps/04-normalizer.js';
import { parseTitle } from '../src/parser/titleParser.js';
import { resolveWork } from '../src/steps/05-enricher.js';

const config = {
  cleanTitleColumn: 'title_text',
  normalize: { overwriteType: false, overwriteEpisodes: false, mergeTitleLanguages: true, typeConfidence: 0.8 },
};

const row = (title, extra = {}) => ({
  id: 1,
  title,
  title_text: null,
  type: 'movie',
  season: null,
  episode: null,
  absolute_episode: null,
  codec: null,
  quality: null,
  audio: [],
  subtitles: [],
  ...extra,
});

test('schema: los valores se recortan al ancho de su columna varchar', () => {
  assert.equal(fitToColumn('type', 'a'.repeat(25)), 'a'.repeat(10));
  assert.equal(fitToColumn('codec', 'b'.repeat(40)), 'b'.repeat(20));
  assert.equal(fitToColumn('quality', 'c'.repeat(99)), 'c'.repeat(20));
  assert.equal(fitToColumn('title_text', 'd'.repeat(500)), 'd'.repeat(500), 'title_text es text: no se recorta');
  assert.equal(fitToColumn('quality', '1080p'), '1080p', 'los valores normales no se tocan');
  assert.equal(fitToColumn('quality', null), null);
});

test('schema: el parser nunca genera valores más anchos que la columna', () => {
  // El recorte es una red de seguridad; con el parser actual sobra.
  for (const title of ['Peli 1080p', 'Peli 4K UHD', 'Serie S01E01 720p BluRay x265', 'Anime - 05 [1080p][HEVC]']) {
    const parsed = parseTitle(title);
    for (const [column, value] of [['type', parsed.type], ['codec', parsed.codec], ['quality', parsed.quality]]) {
      if (value) assert.ok(value.length <= (column === 'type' ? 10 : 20), `${column}="${value}" en "${title}"`);
    }
  }
});

test('schema: un type desconocido se normaliza a movie/series/anime', () => {
  const patch = buildNormalizationPatch(row('Peli 1080p', { type: 'Movie' }), config);
  assert.equal(patch.type, 'movie');
});

test('schema: no se escribe un imdb_id que no cumpla el CHECK ^tt[0-9]+$', async () => {
  const group = {
    type: 'movie',
    label: 'Test',
    variants: ['Test'],
    year: 2020,
    hasEpisode: false,
    known: {},
    needed: new Set(['tmdb_id', 'imdb_id']),
  };
  const cfg = { enrich: { minSimilarity: 0.6 } };
  const log = { debug() {}, warn() {} };

  const tmdb = {
    findBest: async () => ({ tmdb_id: 123, kind: 'movie', title: 'Test', year: 2020, score: 0.9 }),
    externalIds: async () => ({ imdb_id: 'nm1234567' }), // no es un tt…
  };

  const { ids } = await resolveWork(group, { tmdb, config: cfg, log });
  assert.equal(ids.tmdb_id, 123);
  assert.ok(!('imdb_id' in ids), 'un imdb_id inválido no debe escribirse (rompería el CHECK)');
});

test('schema: un imdb_id válido sí se escribe', async () => {
  const group = {
    type: 'movie',
    label: 'Test',
    variants: ['Test'],
    year: 2020,
    hasEpisode: false,
    known: {},
    needed: new Set(['tmdb_id', 'imdb_id']),
  };
  const tmdb = {
    findBest: async () => ({ tmdb_id: 123, kind: 'movie', title: 'Test', year: 2020, score: 0.9 }),
    externalIds: async () => ({ imdb_id: ' tt0111161 ' }), // con espacios: se recorta
  };

  const { ids } = await resolveWork(group, { tmdb, config: { enrich: { minSimilarity: 0.6 } }, log: { debug() {}, warn() {} } });
  assert.equal(ids.imdb_id, 'tt0111161');
});
