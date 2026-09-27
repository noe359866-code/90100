/**
 * Test de integración: ejecuta los 6 pasos contra un Supabase falso en memoria
 * y clientes de API simulados. Verifica el flujo completo, DRY_RUN, RPC y fallback.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './helpers/fakeSupabase.js';
import { createDb } from '../src/db.js';
import { runAdultFilter } from '../src/steps/01-adultFilter.js';
import { runSizeFilter } from '../src/steps/02-sizeFilter.js';
import { runDeadPurger } from '../src/steps/03-deadPurger.js';
import { runNormalizer } from '../src/steps/04-normalizer.js';
import { runEnricher } from '../src/steps/05-enricher.js';
import { runDeduplicator } from '../src/steps/06-deduplicator.js';

const MB = 1024 * 1024;
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, group() {}, groupEnd() {} };

const baseConfig = (overrides = {}) => ({
  table: 'torrents',
  cleanTitleColumn: 'title_text',
  dryRun: false,
  pageSize: 3, // páginas pequeñas para ejercitar la paginación
  deleteChunkSize: 2,
  updateConcurrency: 2,
  maxDeleteRatio: 0.95,
  adult: { extraKeywords: [] },
  size: { minMovieBytes: 150 * MB, minSeriesBytes: 30 * MB, applyToAnime: true, includeZero: false },
  dead: { afterDays: 30, includeNullSeeders: false },
  normalize: { overwriteType: false, overwriteEpisodes: false, mergeTitleLanguages: true, typeConfidence: 0.8 },
  enrich: { tmdbApiKey: 'fake', maxLookups: 300, minSimilarity: 0.6, tmdbForAnime: true, concurrency: 2, anilistPerMinute: 1000, kitsuPerMinute: 1000, tmdbPerSecond: 1000 },
  dedupe: { otherLanguagePolicy: 'delete', unknownLanguageAs: 'english', fallbackTitleKey: false, seederWeight: 20 },
  ...overrides,
});

const row = (id, title, extra = {}) => ({
  id, title, title_text: null, type: null, season: null, episode: null, absolute_episode: null,
  imdb_id: null, tmdb_id: null, anilist_id: null, kitsu_id: null, mal_id: null,
  size_bytes: 2000 * MB, seeders: 10, audio: null, subtitles: null, codec: null, quality: null,
  updated_at: daysAgo(1), info_hash: `hash${id}`, ...extra,
});

const seed = () => [
  // adulto
  row(1, 'Brazzers Hot Scene XXX 1080p'),
  row(2, 'Saving Private Ryan 1998 1080p BluRay x264', { type: 'movie', imdb_id: 'tt0120815' }),
  // fakes por tamaño
  row(3, 'Dune 2021 1080p WEB-DL', { type: 'movie', size_bytes: 100 * MB }),
  row(4, 'Show S01E01 720p', { type: 'series', size_bytes: 10 * MB }),
  row(5, 'Show S01E02 720p', { type: 'series', size_bytes: 0 }), // tamaño desconocido → se conserva
  // muertos
  row(6, 'Old Movie 1999 720p', { type: 'movie', seeders: 0, updated_at: daysAgo(45) }),
  row(7, 'Recent Movie 2024 720p', { type: 'movie', seeders: 0, updated_at: daysAgo(5) }),
  // normalización + enriquecimiento + dedupe
  row(8, 'The.Mandalorian.S02E09.1080p.WEB-DL.H.264-FLUX', { audio: ['ENG', 'aac'], seeders: 100 }),
  row(9, 'The Mandalorian 2x09 HDTV XviD Castellano', { seeders: 30 }),
  row(10, 'The Mandalorian 2x09 1080p x264 Latino', { seeders: 50 }),
  row(11, 'The Mandalorian 2x09 720p x265 Latino', { seeders: 50 }),
  row(12, 'The Mandalorian 2x09 1080p French', { audio: ['fr'], subtitles: ['fr'], seeders: 500 }),
  row(13, '[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv', { seeders: 200 }),
  row(14, '[Erai-raws] Sousou no Frieren - 09 [1080p][Multiple Subtitle][ENG][SPA-LA]', { seeders: 150 }),
  row(15, '[PuyaSubs!] Sousou no Frieren - 09 [1080p]', { seeders: 20 }),
  row(16, 'Dune Part Two (2024) 2160p WEB-DL HEVC', { type: 'movie', tmdb_id: 693134, seeders: 300 }),
  row(17, 'Dune Part Two 2024 1080p BluRay x264', { type: 'movie', seeders: 250 }),
];

// --- Clientes de API simulados ---------------------------------------------
const fakeApis = () => {
  const calls = { anilist: 0, kitsu: 0, tmdb: 0 };
  return {
    calls,
    anilist: { findBest: async (variants) => { calls.anilist += 1; return /frieren/i.test(variants[0]) ? { anilist_id: 154587, mal_id: 52991, englishTitle: "Frieren: Beyond Journey's End", title: 'Sousou no Frieren', year: 2023, score: 0.95 } : null; } },
    kitsu: { byAniListId: async (id) => { calls.kitsu += 1; return id === 154587 ? 46474 : null; }, byMalId: async () => null, findBest: async () => null },
    tmdb: {
      findBest: async (kind, variants) => {
        calls.tmdb += 1;
        const q = variants[0];
        if (/mandalorian/i.test(q) && kind === 'tv') return { tmdb_id: 82856, kind, title: 'The Mandalorian', year: 2019, score: 0.98 };
        if (/dune part two/i.test(q) && kind === 'movie') return { tmdb_id: 693134, kind, title: 'Dune: Part Two', year: 2024, score: 0.9 };
        if (/frieren/i.test(q) && kind === 'tv') return { tmdb_id: 209867, kind, title: "Frieren: Beyond Journey's End", year: 2023, score: 0.9 };
        return null;
      },
      externalIds: async (kind, id) => {
        calls.tmdb += 1;
        return { imdb_id: { 82856: 'tt8111088', 693134: 'tt15239678', 209867: 'tt22248376', 8: 'tt0120815' }[id] || null };
      },
    },
  };
};

async function runAll(config, { rpc = false } = {}) {
  const { client, store } = createFakeSupabase(seed(), { rpc });
  const db = createDb(config, { client });
  const apis = fakeApis();
  const results = {};
  results.adult = await runAdultFilter(db, config, silentLog);
  results.size = await runSizeFilter(db, config, silentLog);
  results.dead = await runDeadPurger(db, config, silentLog);
  results.normalize = await runNormalizer(db, config, silentLog);
  results.enrich = await runEnricher(db, config, silentLog, apis);
  results.dedupe = await runDeduplicator(db, config, silentLog);
  return { db, store, results, apis, rows: store.tables.torrents };
}

test('pipeline completo (fallback UPDATE fila a fila)', async () => {
  const { rows, results, apis, store } = await runAll(baseConfig());
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  // 1. adulto
  assert.equal(results.adult.deleted, 1);
  assert.ok(!byId[1] && byId[2], 'borra Brazzers, conserva Private Ryan');
  // 2. tamaño
  assert.ok(!byId[3] && !byId[4] && byId[5], 'borra fakes, conserva tamaño desconocido');
  // 3. muertos
  assert.ok(!byId[6] && byId[7]);
  // 4/5. normalización
  assert.equal(byId[8].title_text, 'The Mandalorian');
  assert.equal(byId[8].type, 'series');
  assert.equal(byId[8].season, 2);
  assert.equal(byId[8].episode, 9);
  assert.deepEqual(byId[8].audio, ['english']);
  assert.equal(byId[8].codec, 'h264');
  assert.equal(byId[13].type, 'anime');
  assert.equal(byId[13].absolute_episode, 9);
  assert.deepEqual(byId[13].audio, ['japanese']);
  assert.deepEqual(byId[13].subtitles, ['english']);
  assert.deepEqual(byId[14].subtitles, ['english', 'latino']);
  assert.equal(byId[15], undefined, 'PuyaSubs (20 seeders) pierde frente a Erai-raws en el grupo spanish');
  // 6. enriquecimiento
  assert.equal(byId[8].tmdb_id, 82856);
  assert.equal(byId[8].imdb_id, 'tt8111088');
  assert.equal(byId[13].anilist_id, 154587);
  assert.equal(byId[13].kitsu_id, 46474);
  assert.equal(byId[13].mal_id, 52991);
  assert.equal(byId[13].tmdb_id, 209867);
  assert.equal(byId[17].tmdb_id, 693134, 'Dune: propagado desde la fila 16 sin llamar a TMDB search');
  assert.equal(byId[17].imdb_id, 'tt15239678');
  assert.equal(apis.calls.anilist, 1, 'una sola consulta AniList para las 3 filas de Frieren');
  // 7. dedupe
  const mando = rows.filter((r) => r.tmdb_id === 82856).map((r) => r.id).sort((a, b) => a - b);
  assert.deepEqual(mando, [8, 10], 'Mandalorian: mejor inglés (8) + mejor español (10: 1080p latino x264 > 720p x265 > xvid); francés fuera');
  const frieren = rows.filter((r) => r.anilist_id === 154587).map((r) => r.id).sort((a, b) => a - b);
  assert.deepEqual(frieren, [13, 14], 'Frieren: SubsPlease (en) + Erai-raws (en+lat, gana a Puya en seeders)');
  const dune = rows.filter((r) => r.tmdb_id === 693134).map((r) => r.id);
  assert.deepEqual(dune, [17], 'Dune: ambos "unknown"→english; con seeders parecidos (250 vs 300) gana 1080p H.264 BluRay frente a 2160p HEVC');
  assert.equal(store.rpcCalls, 0);
  assert.ok(store.updated.length > 0);
});

test('pipeline con RPC bulk_update_torrents', async () => {
  const { store, rows } = await runAll(baseConfig(), { rpc: true });
  assert.ok(store.rpcCalls > 0, 'usa la RPC');
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[8].title_text, 'The Mandalorian');
  assert.equal(byId[13].kitsu_id, 46474);
});

test('DRY_RUN no modifica nada', async () => {
  const { rows, results, store } = await runAll(baseConfig({ dryRun: true }));
  assert.equal(rows.length, seed().length);
  assert.equal(store.deleted.length, 0);
  assert.equal(store.updated.length, 0);
  assert.equal(results.adult.deleted, 1);
  assert.equal(results.size['movie'], 1);
  assert.equal(results.dead.deleted, 1);
  assert.ok(results.normalize.changed > 0);
  assert.ok(results.enrich.updated > 0);

  // Dedupe en DRY_RUN sobre datos ya normalizados/enriquecidos: informa pero no borra.
  const { client, store: store2 } = createFakeSupabase(seed());
  const real = baseConfig();
  const db = createDb(real, { client });
  await runNormalizer(db, real, silentLog);
  await runEnricher(db, real, silentLog, fakeApis());
  const before = store2.tables.torrents.length;
  const dry = baseConfig({ dryRun: true });
  const res = await runDeduplicator(createDb(dry, { client }), dry, silentLog);
  assert.ok(res.deleted > 0);
  assert.equal(store2.tables.torrents.length, before);
});

test('MAX_DELETE_RATIO aborta la deduplicación', async () => {
  const { client } = createFakeSupabase(seed());
  const config = baseConfig({ maxDeleteRatio: 0.1 });
  const db = createDb(config, { client });
  await runNormalizer(db, config, silentLog);
  await runEnricher(db, config, silentLog, fakeApis());
  await assert.rejects(() => runDeduplicator(db, config, silentLog), /MAX_DELETE_RATIO/);
});

test('política keep para otros idiomas', async () => {
  const config = baseConfig({ dedupe: { otherLanguagePolicy: 'keep', unknownLanguageAs: 'english', fallbackTitleKey: false, seederWeight: 20 } });
  const { rows } = await runAll(config);
  assert.ok(rows.some((r) => r.id === 12), 'el francés se conserva');
});

test('sin TMDB_API_KEY sólo se enriquece anime', async () => {
  const { client } = createFakeSupabase(seed());
  const config = baseConfig({ enrich: { ...baseConfig().enrich, tmdbApiKey: '' } });
  const db = createDb(config, { client });
  await runNormalizer(db, config, silentLog);
  const apis = fakeApis();
  await runEnricher(db, config, silentLog, { anilist: apis.anilist, kitsu: apis.kitsu });
  const byId = Object.fromEntries(client.from('torrents').store.tables.torrents.map((r) => [r.id, r]));
  assert.equal(byId[13].anilist_id, 154587);
  assert.equal(byId[8].tmdb_id, null);
});
