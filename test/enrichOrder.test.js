/**
 * Orden de consulta de las APIs en el enricher:
 *   anime → TMDB (1ª pasada, variantes del parser) → AniList → Kitsu
 *         → TMDB (2ª pasada, sólo si faltó el match y hay títulos canónicos).
 * TMDB va primero porque su cuota es mucho mayor (20 req/s frente a 20 req/min
 * de AniList): tmdb_id/imdb_id no deben esperar en la cola de AniList.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './helpers/fakeSupabase.js';
import { createDb } from '../src/db.js';
import { runEnricher } from '../src/steps/05-enricher.js';

const MB = 1024 * 1024;
const silentLog = { debug() {}, info() {}, warn() {}, error() {}, group() {}, groupEnd() {} };

const config = () => ({
  table: 'torrents',
  cleanTitleColumn: 'title_text',
  dryRun: false,
  pageSize: 100,
  deleteChunkSize: 500,
  updateConcurrency: 8,
  maxDeleteRatio: 0.95,
  enrich: {
    tmdbApiKey: 'fake',
    maxLookups: 300,
    minSimilarity: 0.6,
    tmdbForAnime: true,
    concurrency: 1,
    anilistPerMinute: 1000,
    anilistMinPerMinute: 5,
    kitsuPerMinute: 1000,
    kitsuMinPerMinute: 15,
    tmdbPerSecond: 1000,
    trackIdsColumns: true,
    recheckAfterDays: 14,
    maxAttempts: 3,
  },
});

const animeRow = (id, title) => ({
  id,
  title,
  title_text: null,
  type: 'anime',
  season: null,
  episode: null,
  absolute_episode: null,
  imdb_id: null,
  tmdb_id: null,
  anilist_id: null,
  kitsu_id: null,
  mal_id: null,
  ids_checked_at: null,
  ids_source: null,
  ids_confidence: null,
  ids_attempts: 0,
  size_bytes: 2000 * MB,
  seeders: 10,
});

test('orden anime: TMDB se consulta antes que AniList y Kitsu', async () => {
  const { client, store } = createFakeSupabase([
    animeRow(1, '[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv'),
  ]);
  const db = createDb(config(), { client });

  const order = [];
  const result = await runEnricher(db, config(), silentLog, {
    anilist: {
      findBest: async () => {
        order.push('anilist');
        return { anilist_id: 154587, mal_id: 52991, englishTitle: 'Frieren: Beyond Journey\u2019s End', title: 'Sousou no Frieren', year: 2023, score: 0.95 };
      },
      stats: () => ({ throttles: 0, disabled: false }),
    },
    kitsu: {
      byAniListId: async () => {
        order.push('kitsu-mapping');
        return 46474;
      },
      byMalId: async () => null,
      findBest: async () => { order.push('kitsu-search'); return null; },
      externalIds: async () => ({ anilist_id: null, mal_id: null }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
    tmdb: {
      findBest: async () => {
        order.push('tmdb');
        return { tmdb_id: 209867, kind: 'tv', title: 'Sousou no Frieren', year: 2023, score: 0.9 };
      },
      externalIds: async () => ({ imdb_id: 'tt22103410', tvdb_id: null }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
  });

  assert.equal(result.resolved, 1);
  assert.deepEqual(
    order,
    ['tmdb', 'anilist', 'kitsu-mapping'],
    'TMDB debe ir primero; AniList después y Kitsu al final (mapping, sin búsqueda de texto)',
  );
  const row = store.tables.torrents[0];
  assert.equal(row.tmdb_id, 209867);
  assert.equal(row.imdb_id, 'tt22103410');
  assert.equal(row.anilist_id, 154587);
  assert.equal(row.kitsu_id, 46474);
  assert.equal(row.ids_source, 'tmdb+anilist+kitsu');
});

test('orden anime: si TMDB no encuentra con las variantes, reintenta con el título de AniList', async () => {
  const { client, store } = createFakeSupabase([
    animeRow(1, '[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv'),
  ]);
  const db = createDb(config(), { client });

  const tmdbQueries = [];
  const ENGLISH = 'Frieren: Beyond Journey\u2019s End';
  const result = await runEnricher(db, config(), silentLog, {
    anilist: {
      findBest: async () => ({
        anilist_id: 154587, mal_id: 52991, englishTitle: ENGLISH, title: 'Sousou no Frieren', year: 2023, score: 0.95,
      }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
    kitsu: {
      byAniListId: async () => 46474,
      byMalId: async () => null,
      findBest: async () => null,
      externalIds: async () => ({ anilist_id: null, mal_id: null }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
    tmdb: {
      // Sólo encuentra la obra cuando la búsqueda incluye el título inglés de AniList.
      findBest: async (_kind, variants) => {
        tmdbQueries.push([...variants]);
        if (!variants.includes(ENGLISH)) return null;
        return { tmdb_id: 209867, kind: 'tv', title: 'Sousou no Frieren', year: 2023, score: 0.9 };
      },
      externalIds: async () => ({ imdb_id: 'tt22103410', tvdb_id: null }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
  });

  assert.equal(result.resolved, 1, 'la 2ª pasada de TMDB resuelve la obra');
  assert.equal(tmdbQueries.length, 2, 'TMDB se consulta dos veces (variantes y título canónico)');
  assert.ok(!tmdbQueries[0].includes(ENGLISH), 'la 1ª pasada sólo usa variantes del parser');
  assert.equal(tmdbQueries[1][0], ENGLISH, 'la 2ª pasada pone el título canónico el primero');
  const row = store.tables.torrents[0];
  assert.equal(row.tmdb_id, 209867);
  assert.equal(row.imdb_id, 'tt22103410');
});

test('orden anime: sin título canónico no hay 2ª pasada de TMDB', async () => {
  const { client } = createFakeSupabase([
    animeRow(1, '[SubsPlease] Obra Desconocida - 01 (1080p).mkv'),
  ]);
  const db = createDb(config(), { client });

  let tmdbCalls = 0;
  const result = await runEnricher(db, config(), silentLog, {
    anilist: {
      findBest: async () => null, // sin match: no hay englishTitle
      stats: () => ({ throttles: 0, disabled: false }),
    },
    kitsu: {
      byAniListId: async () => null,
      byMalId: async () => null,
      findBest: async () => null, // sin match: no hay kitsuTitle
      externalIds: async () => ({ anilist_id: null, mal_id: null }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
    tmdb: {
      findBest: async () => {
        tmdbCalls += 1;
        return null;
      },
      externalIds: async () => ({ imdb_id: null, tvdb_id: null }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
  });

  assert.equal(result.resolved, 0);
  assert.equal(result.unresolved, 1);
  // 1 sola llamada: la 1ª pasada (tv, la 2ª movie no procede porque el título trae
  // episodio) y la repetición con títulos canónicos no ocurre si AniList/Kitsu no
  // aportaron ninguno nuevo.
  assert.equal(tmdbCalls, 1, `sin títulos canónicos no debe repetir TMDB (llamadas: ${tmdbCalls})`);
});
