/**
 * Fallback del enriquecedor: cuando AniList no puede responder (429 / penalty
 * box / sin match), Kitsu resuelve la obra por texto y sus mappings rescatan
 * anilist_id/mal_id; TMDB se consulta igualmente para tmdb_id/imdb_id.
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
    concurrency: 2,
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

const animeRow = (id, title, extra = {}) => ({
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
  audio: null,
  subtitles: null,
  codec: null,
  quality: null,
  updated_at: new Date().toISOString(),
  info_hash: `hash${id}`,
  ...extra,
});

/** AniList acaba de devolver 429: falla la consulta pero el interruptor sigue cerrado. */
const throttledAniList = () => ({
  findBest: async () => {
    const err = new Error('HTTP 429 Too Many Requests → https://graphql.anilist.co');
    err.code = 'ERR_RATE_LIMITED';
    throw err;
  },
  stats: () => ({ rate: 10, maxRate: 20, throttles: 2, cooldownMs: 5000, disabled: false, windowUsed: 3 }),
});

const byTitle = (variants, hit) => (variants.join(' ').toLowerCase().includes('frieren') ? hit.frieren : hit.chainsaw);

test('fallback: con AniList saturado, Kitsu y TMDB resuelven la obra igualmente', async () => {
  const { client, store } = createFakeSupabase([
    animeRow(1, '[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv', { seeders: 200 }),
    animeRow(2, '[Erai-raws] Sousou no Frieren - 10 [1080p][Multiple Subtitle][ENG][SPA-LA]', { seeders: 150 }),
    animeRow(3, 'Chainsaw Man - 01 [1080p]', { seeders: 90 }),
  ]);
  const db = createDb(config(), { client });

  const kitsuSearches = [];
  const result = await runEnricher(db, config(), silentLog, {
    anilist: throttledAniList(),
    kitsu: {
      byAniListId: async () => null,
      byMalId: async () => null,
      findBest: async (variants) => {
        kitsuSearches.push(variants.join(' '));
        return byTitle(variants, {
          frieren: { kitsu_id: 46474, title: 'Sousou no Frieren', year: 2023, score: 0.93 },
          chainsaw: { kitsu_id: 50026, title: 'Chainsaw Man', year: 2022, score: 0.91 },
        });
      },
      externalIds: async (kitsuId) =>
        kitsuId === 46474 ? { anilist_id: 154587, mal_id: 52991 } : { anilist_id: 126403, mal_id: 44511 },
      stats: () => ({ throttles: 0, disabled: false }),
    },
    tmdb: {
      findBest: async (kind, variants) => {
        assert.equal(kind, 'tv', 'el anime se busca como tv');
        return byTitle(variants, {
          frieren: { tmdb_id: 209867, kind: 'tv', title: 'Sousou no Frieren', year: 2023, score: 0.9 },
          chainsaw: { tmdb_id: 114410, kind: 'tv', title: 'Chainsaw Man', year: 2022, score: 0.88 },
        });
      },
      externalIds: async (kind, tmdbId) => ({ imdb_id: tmdbId === 209867 ? 'tt22103410' : 'tt12708542' }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
  });

  assert.equal(result.resolved, 2, 'Kitsu+TMDB deben resolver las 2 obras sin AniList');
  assert.equal(result.rateLimited, 0, 'con el fallback nada queda bloqueado');
  assert.equal(result.failures, 0);
  assert.equal(result.updated, 3, 'los 3 torrents reciben los IDs');
  assert.equal(kitsuSearches.length, 2, 'una búsqueda de Kitsu por obra');

  const rows = store.tables.torrents;
  for (const r of rows) {
    const frieren = r.title.includes('Frieren');
    assert.equal(r.anilist_id, frieren ? 154587 : 126403, `anilist_id de ${r.title}`);
    assert.equal(r.mal_id, frieren ? 52991 : 44511, `mal_id de ${r.title}`);
    assert.equal(r.kitsu_id, frieren ? 46474 : 50026, `kitsu_id de ${r.title}`);
    assert.equal(r.tmdb_id, frieren ? 209867 : 114410, `tmdb_id de ${r.title}`);
    assert.equal(r.imdb_id, frieren ? 'tt22103410' : 'tt12708542', `imdb_id de ${r.title}`);
    assert.equal(r.ids_source, 'kitsu+tmdb');
    assert.equal(r.ids_attempts, 1);
    assert.equal(r.ids_checked_at != null, true);
  }
  assert.equal(rows[0].ids_confidence, 0.93, 'la confianza es la del mejor match (Kitsu)');
});

test('fallback: los mappings de Kitsu rellenan mal_id cuando AniList no lo trae', async () => {
  const { client, store } = createFakeSupabase([
    animeRow(1, '[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv'),
  ]);
  const db = createDb(config(), { client });

  const result = await runEnricher(db, config(), silentLog, {
    // AniList encuentra la obra pero sin idMal (idMal null en su GraphQL)
    anilist: {
      findBest: async () => ({ anilist_id: 154587, mal_id: null, englishTitle: 'Frieren', title: 'Sousou no Frieren', year: 2023, score: 0.93 }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
    kitsu: {
      byAniListId: async (id) => (id === 154587 ? 46474 : null),
      byMalId: async () => null,
      findBest: async () => null,
      externalIds: async (kitsuId) => {
        assert.equal(kitsuId, 46474);
        return { anilist_id: 154587, mal_id: 52991 };
      },
      stats: () => ({ throttles: 0, disabled: false }),
    },
    tmdb: {
      findBest: async () => null,
      externalIds: async () => ({ imdb_id: null }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
  });

  assert.equal(result.resolved, 1);
  const row = store.tables.torrents[0];
  assert.equal(row.anilist_id, 154587);
  assert.equal(row.kitsu_id, 46474);
  assert.equal(row.mal_id, 52991, 'mal_id rescatado vía mappings de Kitsu');
  assert.equal(row.ids_source, 'anilist+kitsu');
});

test('fallback: filas sin type prueban también el tipo TMDB contrario si el primero no casa', async () => {
  const { client, store } = createFakeSupabase([
    // type NULL en la BD → el parser infiere "movie", pero la obra es una serie.
    animeRow(1, 'Dark 2020 1080p', { type: null }),
  ]);
  const db = createDb(config(), { client });

  const kindsTried = [];
  const result = await runEnricher(db, config(), silentLog, {
    anilist: { findBest: async () => null, stats: () => ({ throttles: 0, disabled: false }) },
    kitsu: {
      byAniListId: async () => null,
      byMalId: async () => null,
      findBest: async () => null,
      externalIds: async () => ({ anilist_id: null, mal_id: null }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
    tmdb: {
      findBest: async (kind, variants) => {
        kindsTried.push(kind);
        return kind === 'tv'
          ? { tmdb_id: 75886, kind: 'tv', title: 'Dark', year: 2017, score: 0.92 }
          : null;
      },
      externalIds: async (kind, tmdbId) => {
        assert.equal(kind, 'tv', 'external_ids debe consultarse con el tipo del hit');
        assert.equal(tmdbId, 75886);
        return { imdb_id: 'tt5753856' };
      },
      stats: () => ({ throttles: 0, disabled: false }),
    },
  });

  assert.deepEqual(kindsTried, ['movie', 'tv'], 'si movie no casa se prueba tv');
  assert.equal(result.resolved, 1);
  const row = store.tables.torrents[0];
  assert.equal(row.tmdb_id, 75886);
  assert.equal(row.imdb_id, 'tt5753856');
  assert.equal(row.ids_source, 'tmdb');
});

test('fallback: una fila con type explícito NO prueba el tipo contrario', async () => {
  const { client } = createFakeSupabase([
    animeRow(1, 'Dark 2020 1080p', { type: 'movie' }),
  ]);
  const db = createDb(config(), { client });

  const kindsTried = [];
  await runEnricher(db, config(), silentLog, {
    anilist: { findBest: async () => null, stats: () => ({ throttles: 0, disabled: false }) },
    kitsu: {
      byAniListId: async () => null,
      byMalId: async () => null,
      findBest: async () => null,
      externalIds: async () => ({ anilist_id: null, mal_id: null }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
    tmdb: {
      findBest: async (kind) => {
        kindsTried.push(kind);
        return null;
      },
      externalIds: async () => ({ imdb_id: null }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
  });

  assert.deepEqual(kindsTried, ['movie'], 'el tipo de la BD es autoritativo');
});

test('fallback: si Kitsu tampoco resuelve, no se inventa ningún ID', async () => {
  const { client, store } = createFakeSupabase([
    animeRow(1, '[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv'),
  ]);
  const db = createDb(config(), { client });

  const result = await runEnricher(db, config(), silentLog, {
    anilist: throttledAniList(),
    kitsu: {
      byAniListId: async () => null,
      byMalId: async () => null,
      findBest: async () => null,
      externalIds: async () => ({ anilist_id: null, mal_id: null }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
    tmdb: {
      findBest: async () => null,
      externalIds: async () => ({ imdb_id: null }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
  });

  assert.equal(result.resolved, 0);
  assert.equal(result.updated, 0);
  const row = store.tables.torrents[0];
  assert.equal(row.anilist_id, null);
  assert.equal(row.mal_id, null);
  assert.equal(row.kitsu_id, null);
  // El rate limit no quema el intento: la obra se reintentará en la próxima ejecución
  assert.equal(row.ids_attempts, 0);
  assert.equal(row.ids_checked_at, null);
});
