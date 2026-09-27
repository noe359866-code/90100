/**
 * Agrupación del enriquecedor: una obra con año y la misma sin año comparten IDs;
 * dos remakes de años distintos no.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './helpers/fakeSupabase.js';
import { createDb } from '../src/db.js';
import { runEnricher } from '../src/steps/05-enricher.js';

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, group() {}, groupEnd() {} };

const config = {
  table: 'torrents',
  cleanTitleColumn: 'title_text',
  dryRun: false,
  pageSize: 50,
  deleteChunkSize: 50,
  updateConcurrency: 2,
  maxDeleteRatio: 0.95,
  enrich: {
    tmdbApiKey: 'fake',
    maxLookups: 20,
    minSimilarity: 0.6,
    tmdbForAnime: false,
    concurrency: 2,
    trackIdsColumns: false,
  },
};

const movie = (id, title, extra = {}) => ({
  id,
  title,
  title_text: null,
  type: 'movie',
  season: null,
  episode: null,
  absolute_episode: null,
  imdb_id: null,
  tmdb_id: null,
  anilist_id: null,
  kitsu_id: null,
  mal_id: null,
  size_bytes: 2_000_000_000,
  seeders: 10,
  audio: null,
  subtitles: null,
  codec: null,
  quality: null,
  updated_at: new Date().toISOString(),
  ...extra,
});

test('enricher: propaga IDs de la ficha con año a la misma obra sin año', async () => {
  const { client, store } = createFakeSupabase([
    movie(1, 'Dune Part Two (2024) 1080p BluRay', { tmdb_id: 693134 }),
    movie(2, 'Dune Part Two 1080p BluRay x264'),
  ]);
  const db = createDb(config, { client });
  let searched = 0;
  await runEnricher(db, config, silentLog, {
    anilist: { findBest: async () => null, stats: () => ({}) },
    kitsu: { byAniListId: async () => null, byMalId: async () => null, findBest: async () => null, stats: () => ({}) },
    tmdb: {
      findBest: async () => { searched += 1; return null; },
      externalIds: async () => ({ imdb_id: 'tt15239678' }),
      stats: () => ({}),
    },
  });
  const byId = Object.fromEntries(store.tables.torrents.map((r) => [r.id, r]));
  assert.equal(searched, 0, 'con tmdb_id conocido no hace falta buscar el título');
  assert.equal(byId[2].tmdb_id, 693134);
  assert.equal(byId[2].imdb_id, 'tt15239678');
  assert.equal(byId[1].imdb_id, 'tt15239678');
});

test('enricher: no mezcla remakes de años distintos', async () => {
  const { client, store } = createFakeSupabase([
    movie(1, 'Dune (1984) 1080p', { tmdb_id: 841 }),
    movie(2, 'Dune (2021) 1080p'),
  ]);
  const db = createDb(config, { client });
  await runEnricher(db, config, silentLog, {
    anilist: { findBest: async () => null, stats: () => ({}) },
    kitsu: { byAniListId: async () => null, byMalId: async () => null, findBest: async () => null, stats: () => ({}) },
    tmdb: {
      findBest: async () => ({ tmdb_id: 438631, kind: 'movie', title: 'Dune', year: 2021, score: 0.99 }),
      externalIds: async (kind, id) => ({ imdb_id: id === 438631 ? 'tt1160419' : 'tt0087182' }),
      stats: () => ({}),
    },
  });
  const byId = Object.fromEntries(store.tables.torrents.map((r) => [r.id, r]));
  assert.equal(byId[1].tmdb_id, 841, 'el remake de 1984 conserva su id');
  assert.equal(byId[2].tmdb_id, 438631, '2021 no hereda el tmdb de 1984');
});

test('enricher: un título sin año no se pega a un remake si hay varios años', async () => {
  const { client, store } = createFakeSupabase([
    movie(1, 'Dune (1984) 1080p', { tmdb_id: 841 }),
    movie(2, 'Dune (2021) 1080p', { tmdb_id: 438631 }),
    movie(3, 'Dune 1080p'),
  ]);
  const db = createDb(config, { client });
  await runEnricher(db, config, silentLog, {
    anilist: { findBest: async () => null, stats: () => ({}) },
    kitsu: { byAniListId: async () => null, byMalId: async () => null, findBest: async () => null, stats: () => ({}) },
    tmdb: {
      findBest: async () => ({ tmdb_id: 999, kind: 'movie', title: 'Dune', year: 2021, score: 0.99 }),
      externalIds: async () => ({ imdb_id: null }),
      stats: () => ({}),
    },
  });
  const byId = Object.fromEntries(store.tables.torrents.map((r) => [r.id, r]));
  assert.equal(byId[3].tmdb_id, null, 'sin año y con dos remakes no hereda un tmdb');
});
