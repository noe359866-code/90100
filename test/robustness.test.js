/**
 * Robustez: los 6 pasos se ejecutan sobre filas deliberadamente "sucias"
 * (nulos, tipos equivocados, valores fuera de rango, cadenas larguísimas...) y
 * deben terminar sin lanzar ni escribir valores inválidos (NaN, undefined,
 * cadenas donde van enteros...). Es la red de seguridad contra una fila con
 * forma inesperada que tumbe el mantenimiento entero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './helpers/fakeSupabase.js';
import { createDb } from '../src/db.js';
import { parseTitle } from '../src/parser/titleParser.js';
import { runAdultFilter } from '../src/steps/01-adultFilter.js';
import { runSizeFilter } from '../src/steps/02-sizeFilter.js';
import { runDeadPurger } from '../src/steps/03-deadPurger.js';
import { runNormalizer } from '../src/steps/04-normalizer.js';
import { runEnricher } from '../src/steps/05-enricher.js';
import { runDeduplicator } from '../src/steps/06-deduplicator.js';

const MB = 1024 * 1024;
const silentLog = { debug() {}, info() {}, warn() {}, error() {}, group() {}, groupEnd() {} };

const config = {
  table: 'torrents',
  cleanTitleColumn: 'title_text',
  dryRun: false,
  pageSize: 3,
  deleteChunkSize: 2,
  updateConcurrency: 2,
  updateChunkSize: 10,
  maxDeleteRatio: 1, // aquí se prueba la robustez, no la salvaguarda de ratio
  adult: { extraKeywords: [] },
  size: { minMovieBytes: 150 * MB, minSeriesBytes: 30 * MB, applyToAnime: true, includeZero: false },
  dead: { afterDays: 30, includeNullSeeders: false },
  normalize: { overwriteType: false, overwriteEpisodes: false, mergeTitleLanguages: true, typeConfidence: 0.8 },
  enrich: {
    tmdbApiKey: 'fake', maxLookups: 50, minSimilarity: 0.6, tmdbForAnime: true, concurrency: 2,
    anilistPerMinute: 1000, kitsuPerMinute: 1000, tmdbPerSecond: 1000,
    trackIdsColumns: false, recheckAfterDays: 14, maxAttempts: 3,
  },
  dedupe: { otherLanguagePolicy: 'delete', unknownLanguageAs: 'english', fallbackTitleKey: false, seederWeight: 20 },
};

/** Clientes de API simulados: nunca salen a la red. */
const fakeApis = () => ({
  anilist: { findBest: async () => null, stats: () => ({ throttles: 0, rate: 1, maxRate: 1, disabled: false }) },
  kitsu: { findBest: async () => null, byAniListId: async () => null, byMalId: async () => null, externalIds: async () => ({ anilist_id: null, mal_id: null }), stats: () => ({ throttles: 0, rate: 1, maxRate: 1, disabled: false }) },
  tmdb: { findBest: async () => null, externalIds: async () => ({ imdb_id: null, tvdb_id: null }), stats: () => ({ throttles: 0, rate: 1, maxRate: 1, disabled: false }) },
});

const BASE = {
  title_text: null, type: null, season: null, episode: null, absolute_episode: null,
  imdb_id: null, tmdb_id: null, anilist_id: null, kitsu_id: null, mal_id: null,
  size_bytes: 2000 * MB, seeders: 10, audio: null, subtitles: null, codec: null, quality: null,
  updated_at: new Date(Date.now() - 86_400_000).toISOString(), info_hash: 'h', file_index: null,
  ids_checked_at: null, ids_source: null, ids_confidence: null, ids_attempts: null,
};

/** Filas hostiles: lo que puede llegar de un scraper ajeno o de un esquema distinto. */
const hostileRows = () => [
  { ...BASE, id: 1, title: null },
  { ...BASE, id: 2, title: '' },
  { ...BASE, id: 3, title: 12345 },
  { ...BASE, id: 4, title: { a: 1 } },
  { ...BASE, id: 5, title: 'A'.repeat(3000) },
  { ...BASE, id: 6, title: 'Movie 2020 1080p', type: 'MOVIE', audio: 'latino', subtitles: 'ENG' },
  { ...BASE, id: 7, title: 'Show S01E01 1080p', type: 'series', season: '01', episode: '2', absolute_episode: 'abc' },
  { ...BASE, id: 8, title: 'Dune 2021 1080p', type: 'movie', size_bytes: '100', seeders: '10', updated_at: 'no-es-una-fecha' },
  { ...BASE, id: 9, title: 'Test 1080p x265', codec: 'x265 10bit', quality: ['4K'], audio: [null, 5, 'LATINO', 'latino'] },
  { ...BASE, id: 10, title: 'Movie 2020', imdb_id: 0, tmdb_id: -1, anilist_id: {}, kitsu_id: '12', mal_id: '' },
  { ...BASE, id: 11, title: 'Test S01E01', seeders: -3, size_bytes: -5, updated_at: null },
  { ...BASE, id: 12, title: 'Test - 05 [1080p]', episode: 1.5, season: -1 },
  { ...BASE, id: 13, title: '💥 Emoji Movie 2020 1080p', type: 'película' },
  { ...BASE, id: 14, title: 'Nulls', type: null, season: true, episode: false, size_bytes: null, seeders: null },
];

const INT_COLUMNS = ['season', 'episode', 'absolute_episode'];
const TEXT_COLUMNS = ['title_text', 'codec', 'quality', 'type'];

/** ¿Este valor incumple el contrato de su columna? */
function isInvalidValue(col, value) {
  if (value === undefined) return true;
  if (typeof value === 'number' && !Number.isFinite(value)) return true;
  if (INT_COLUMNS.includes(col) && value !== null && !Number.isInteger(value)) return true;
  if (TEXT_COLUMNS.includes(col) && value !== null && typeof value !== 'string') return true;
  return false;
}

/**
 * Celdas que YA llegaban mal de origen (p. ej. `absolute_episode = 'abc'`): el
 * mantenimiento no tiene por qué arreglarlas (no se sobrescriben episodios por
 * defecto) y en un esquema real con columnas enteras ni existirían. Lo que se
 * vigila es que los pasos no INTRODUZCAN valores inválidos.
 */
const preExistingGarbage = new Set(
  hostileRows().flatMap((row) => Object.entries(row)
    .filter(([col, value]) => isInvalidValue(col, value))
    .map(([col]) => `${row.id}:${col}`)),
);

/** Ninguna escritura puede colar valores que rompan la BD (NaN, undefined, tipos raros). */
function assertStoreSane(store, stepName) {
  for (const row of store.tables.torrents) {
    for (const [col, value] of Object.entries(row)) {
      if (preExistingGarbage.has(`${row.id}:${col}`)) continue;
      assert.ok(!isInvalidValue(col, value), `${stepName}: ${col} inválido en id=${row.id} (${JSON.stringify(value)})`);
    }
  }
}

const runStep = async (run, { withApis = false } = {}) => {
  const { client, store } = createFakeSupabase(hostileRows(), { rpc: false });
  const db = createDb(config, { client });
  const result = await run(db, config, silentLog, withApis ? fakeApis() : undefined);
  assertStoreSane(store, run.name);
  return result;
};

test('parseTitle no lanza con títulos de cualquier forma', () => {
  for (const row of hostileRows()) {
    const parsed = parseTitle(row.title);
    assert.equal(typeof parsed.cleanTitle, 'string');
    assert.equal(typeof parsed.searchKey, 'string');
  }
});

test('paso 1 (adulto) aguanta filas hostiles', async () => {
  const result = await runStep(runAdultFilter);
  assert.equal(typeof result.deleted, 'number');
});

test('paso 2 (tamaño) aguanta filas hostiles', async () => {
  const result = await runStep(runSizeFilter);
  assert.equal(typeof result, 'object');
});

test('paso 3 (muertos) aguanta filas hostiles', async () => {
  const result = await runStep(runDeadPurger);
  assert.equal(typeof result.deleted, 'number');
});

test('paso 4 (normalizador) aguanta filas hostiles y escribe tipos válidos', async () => {
  const result = await runStep(runNormalizer);
  assert.equal(result.scanned, hostileRows().length, 'debe analizar todas las filas');
});

test('paso 5 (enricher) aguanta filas hostiles', async () => {
  const result = await runStep(runEnricher, { withApis: true });
  assert.equal(result.scanned > 0, true);
  assert.ok(result.failures === 0, `no debería haber errores por filas raras (${result.failures})`);
});

test('paso 6 (dedupe) aguanta filas hostiles', async () => {
  const result = await runStep(runDeduplicator);
  assert.equal(typeof result.scanned, 'number');
});

test('el pipeline completo (6 pasos, en orden) termina sobre filas hostiles', async () => {
  const { client, store } = createFakeSupabase(hostileRows(), { rpc: false });
  const db = createDb(config, { client });
  const apis = fakeApis();
  const results = [];
  results.push(await runAdultFilter(db, config, silentLog));
  results.push(await runSizeFilter(db, config, silentLog));
  results.push(await runDeadPurger(db, config, silentLog));
  results.push(await runNormalizer(db, config, silentLog));
  results.push(await runEnricher(db, config, silentLog, apis));
  results.push(await runDeduplicator(db, config, silentLog));
  assert.equal(results.length, 6);
  assertStoreSane(store, 'pipeline');
});
