/**
 * Integración: el enriquecedor debe sobrevivir a que una API le cierre el grifo
 * por rate limit (interruptor abierto) sin gastar el resto de la ejecución.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './helpers/fakeSupabase.js';
import { createDb } from '../src/db.js';
import { runNormalizer } from '../src/steps/04-normalizer.js';
import { runEnricher } from '../src/steps/05-enricher.js';

const MB = 1024 * 1024;
const silentLog = { debug() {}, info() {}, warn() {}, error() {}, group() {}, groupEnd() {} };
const verboseLog = { ...silentLog, warn: (...a) => warnings.push(a.join(' ')) };
const warnings = [];

const baseConfig = () => ({
  table: 'torrents',
  cleanTitleColumn: 'title_text',
  dryRun: false,
  pageSize: 100,
  deleteChunkSize: 500,
  updateConcurrency: 8,
  maxDeleteRatio: 0.95,
  adult: { extraKeywords: [] },
  size: { minMovieBytes: 150 * MB, minSeriesBytes: 30 * MB, applyToAnime: true, includeZero: false },
  dead: { afterDays: 30, includeNullSeeders: false },
  normalize: { overwriteType: false, overwriteEpisodes: false, mergeTitleLanguages: true, typeConfidence: 0.8 },
  enrich: {
    tmdbApiKey: 'fake',
    maxLookups: 300,
    minSimilarity: 0.6,
    tmdbForAnime: true,
    concurrency: 4,
    anilistPerMinute: 1000,
    anilistMinPerMinute: 5,
    kitsuPerMinute: 1000,
    kitsuMinPerMinute: 15,
    tmdbPerSecond: 1000,
  },
  dedupe: { otherLanguagePolicy: 'delete', unknownLanguageAs: 'english', fallbackTitleKey: false, seederWeight: 20 },
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

const seed = () => [
  animeRow(1, '[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv', { seeders: 200 }),
  animeRow(2, '[Erai-raws] Sousou no Frieren - 10 [1080p][Multiple Subtitle][ENG][SPA-LA]', { seeders: 150 }),
  animeRow(3, '[PuyaSubs!] Sousou no Frieren - 11 [1080p]', { seeders: 20 }),
  animeRow(4, 'Chainsaw Man - 01 [1080p]', { seeders: 90 }),
];

/** Cliente AniList con el interruptor abierto: falla siempre y rápido. */
const blockedAniList = () => ({
  findBest: async () => {
    const err = new Error('AniList: en pausa por rate limit hasta las 2026-01-01T00:00:00.000Z');
    err.code = 'ERR_RATE_LIMITED';
    throw err;
  },
  stats: () => ({ rate: 5, maxRate: 20, throttles: 12, cooldownMs: 60000, disabled: true, windowUsed: 0 }),
});

test('enricher: con AniList en pausa por rate limit no reintenta obra por obra', async () => {
  warnings.length = 0;
  const { client } = createFakeSupabase(seed());
  const config = baseConfig();
  const db = createDb(config, { client });
  await runNormalizer(db, config, silentLog);

  const result = await runEnricher(db, config, verboseLog, {
    anilist: blockedAniList(),
    kitsu: { byAniListId: async () => null, byMalId: async () => null, findBest: async () => null, stats: () => ({ throttles: 0, disabled: false }) },
    tmdb: {
      findBest: async () => null,
      externalIds: async () => ({ imdb_id: null, tvdb_id: null }),
      stats: () => ({ throttles: 0, disabled: false }),
    },
  });

  // 4 torrents → 2 obras distintas (3 episodios de Frieren + Chainsaw Man)
  assert.equal(result.groups, 2);
  assert.equal(result.lookedUp, 2);
  assert.equal(result.rateLimited, 2, 'las obras deben contarse como bloqueadas por rate limit');
  assert.equal(result.failures, 0, 'no son fallos del script: no se ensucia el resumen con errores');
  assert.equal(result.resolved, 0);

  // Un único aviso informativo, ni uno por obra
  const rateWarnings = warnings.filter((w) => /en pausa por rate limit/.test(w));
  assert.equal(rateWarnings.length, 1, `se esperaba 1 aviso, hubo ${rateWarnings.length}`);

  // Nada se escribe en la base de datos
  const rows = client.from('torrents').store.tables.torrents;
  assert.ok(rows.every((r) => r.anilist_id === null && r.mal_id === null), 'no debe inventar IDs');
  assert.equal(result.updated, 0);
});

test('enricher: un rate limit no quema ids_attempts', async () => {
  warnings.length = 0;
  const rows = seed().map((r) => ({ ...r, ids_checked_at: null, ids_attempts: 0, ids_source: null, ids_confidence: null }));
  const { client } = createFakeSupabase(rows);
  const config = baseConfig();
  config.enrich = { ...config.enrich, trackIdsColumns: true, recheckAfterDays: 14, maxAttempts: 3 };
  const db = createDb(config, { client });
  await runNormalizer(db, config, silentLog);
  await runEnricher(db, config, verboseLog, {
    anilist: blockedAniList(),
    kitsu: { byAniListId: async () => null, byMalId: async () => null, findBest: async () => null, stats: () => ({ throttles: 0, disabled: false }) },
    tmdb: { findBest: async () => null, externalIds: async () => ({ imdb_id: null }), stats: () => ({ throttles: 0, disabled: false }) },
  });
  const stored = client.from('torrents').store.tables.torrents;
  assert.ok(stored.every((r) => r.ids_attempts === 0 || r.ids_attempts == null), 'no debe contar un intento que no pudo consultar');
  assert.ok(stored.every((r) => r.ids_checked_at == null), 'no debe marcar la obra como revisada');
});
