/**
 * Tests de la telemetría de resolución de IDs (ids_checked_at / ids_source /
 * ids_confidence / ids_attempts): evita reintentar a diario las mismas obras
 * imposibles, que es lo que quema la cuota de AniList/TMDB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './helpers/fakeSupabase.js';
import { createDb } from '../src/db.js';
import { runNormalizer } from '../src/steps/04-normalizer.js';
import { runEnricher } from '../src/steps/05-enricher.js';

const MB = 1024 * 1024;

const makeLog = () => {
  const lines = { info: [], warn: [], debug: [] };
  return {
    lines,
    debug: (...a) => lines.debug.push(a.join(' ')),
    info: (...a) => lines.info.push(a.join(' ')),
    warn: (...a) => lines.warn.push(a.join(' ')),
    error: (...a) => lines.warn.push(a.join(' ')),
    group() {},
    groupEnd() {},
  };
};

const config = (overrides = {}) => ({
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
    trackIdsColumns: true,
    recheckAfterDays: 14,
    maxAttempts: 3,
  },
  dedupe: { otherLanguagePolicy: 'delete', unknownLanguageAs: 'english', fallbackTitleKey: false, seederWeight: 20 },
  ...overrides,
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

const noApis = () => ({
  anilist: { findBest: async () => null, stats: () => ({ throttles: 0, disabled: false }) },
  kitsu: { byAniListId: async () => null, byMalId: async () => null, findBest: async () => null, stats: () => ({ throttles: 0, disabled: false }) },
  tmdb: { findBest: async () => null, externalIds: async () => ({ imdb_id: null }), stats: () => ({ throttles: 0, disabled: false }) },
});

const run = async (rows, cfg, apis, log) => {
  const { client, store } = createFakeSupabase(rows);
  const db = createDb(cfg, { client });
  await runNormalizer(db, cfg, log);
  const result = await runEnricher(db, cfg, log, apis);
  return { rows: store.tables.torrents, result };
};

test('telemetría: una obra sin resolver deja constancia del intento', async () => {
  const log = makeLog();
  const { rows, result } = await run([animeRow(1, '[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv')], config(), noApis(), log);

  const row = rows[0];
  assert.equal(result.unresolved, 1);
  assert.ok(row.ids_checked_at, 'debe registrar la fecha de consulta');
  assert.equal(row.ids_attempts, 1, 'debe incrementar los intentos');
  assert.equal(row.ids_source, 'none', 'ninguna API acertó');
  assert.equal(row.ids_confidence, null);
  assert.equal(row.anilist_id, null);
});

test('telemetría: una obra resuelta guarda la API y la confianza del match', async () => {
  const log = makeLog();
  const apis = noApis();
  apis.anilist.findBest = async () => ({ anilist_id: 154587, mal_id: 52991, englishTitle: 'Frieren', title: 'Sousou no Frieren', year: 2023, score: 0.93 });
  apis.kitsu.byAniListId = async () => 46474;

  const { rows, result } = await run([animeRow(1, '[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv')], config(), apis, log);

  const row = rows[0];
  assert.equal(result.resolved, 1);
  assert.equal(row.anilist_id, 154587);
  assert.equal(row.kitsu_id, 46474);
  assert.equal(row.ids_source, 'anilist+kitsu');
  assert.equal(row.ids_confidence, 0.93);
  assert.equal(row.ids_attempts, 1);
});

test('telemetría: las obras consultadas hace poco se saltan', async () => {
  const log = makeLog();
  const reciente = new Date().toISOString();
  const { rows, result } = await run(
    [
      animeRow(1, '[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv', { ids_checked_at: reciente, ids_attempts: 1 }),
      animeRow(2, '[Erai-raws] Chainsaw Man - 01 [1080p]', { ids_checked_at: null, ids_attempts: 0 }),
    ],
    config(),
    noApis(),
    log,
  );

  // Sólo la obra nunca consultada entra en el escaneo
  assert.match(log.lines.info.join('\n'), /enricher: 1 torrents huérfanos/);
  assert.equal(result.scanned, 1);
  assert.equal(rows[0].ids_attempts, 1, 'la obra reciente no se vuelve a tocar');
  assert.equal(rows[1].ids_attempts, 1, 'la obra pendiente sí se consulta');
});

test('telemetría: una obra con demasiados intentos se abandona', async () => {
  const log = makeLog();
  const { rows, result } = await run(
    [animeRow(1, '[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv', { ids_checked_at: null, ids_attempts: 3 })],
    config(),
    noApis(),
    log,
  );

  assert.equal(result.scanned, 0, 'con 3 intentos ya no se consulta');
  assert.equal(rows[0].ids_attempts, 3, 'no se incrementa el contador');
});

test('telemetría: si la tabla no tiene las columnas, todo sigue funcionando', async () => {
  const log = makeLog();
  const { client, store } = createFakeSupabase([animeRow(1, '[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv')]);
  const originalFrom = client.from.bind(client);

  // Simula una tabla sin ids_checked_at: sólo falla el SELECT de sondeo
  const chainableError = () => {
    const p = {
      then: (res, rej) => Promise.resolve({ data: null, error: { code: '42703', message: 'column torrents.ids_checked_at does not exist' } }).then(res, rej),
      limit: () => p,
      select: () => p,
    };
    return p;
  };
  client.from = (table) => {
    const q = originalFrom(table);
    const originalSelect = q.select.bind(q);
    q.select = (columns = '*', opts = {}) => (String(columns).includes('ids_checked_at') ? chainableError() : originalSelect(columns, opts));
    return q;
  };

  const db = createDb(config(), { client });
  await runNormalizer(db, config(), log);
  const result = await runEnricher(db, config(), log, noApis());

  const row = store.tables.torrents[0];
  assert.equal(result.unresolved, 1, 'el enriquecimiento funciona igual');
  assert.equal(row.ids_attempts, 0, 'no se escribe telemetría');
  assert.ok(
    log.lines.info.some((l) => /no tiene ids_checked_at/.test(l)),
    'debe avisar de que no hay columnas de telemetría',
  );
});

test('telemetría: avisa si la RPC está obsoleta y no guarda las columnas ids_*', async () => {
  const log = makeLog();
  const { client, store } = createFakeSupabase([animeRow(1, '[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv')], { rpc: true });
  const originalFrom = client.from.bind(client);

  // RPC "antigua": ignora en silencio cualquier columna ids_* del patch
  client.rpc = async (name, args) => {
    if (name !== 'bulk_update_torrents') return { data: null, error: { code: 'PGRST202', message: 'not found' } };
    let n = 0;
    for (const { id, patch } of args.updates) {
      const row = store.tables.torrents.find((r) => String(r.id) === String(id));
      if (!row) continue;
      const { ids_checked_at, ids_source, ids_confidence, ids_attempts, ...resto } = patch;
      Object.assign(row, resto);
      if (Object.keys(resto).length) n += 1;
    }
    return { data: n, error: null };
  };
  client.from = (table) => {
    const q = originalFrom(table);
    const originalSelect = q.select.bind(q);
    q.select = (columns = '*', opts = {}) => (String(columns).includes('ids_checked_at') ? originalSelect(columns, opts) : originalSelect(columns, opts));
    return q;
  };

  const db = createDb(config(), { client });
  await runNormalizer(db, config(), log);
  const result = await runEnricher(db, config(), log, noApis());

  assert.equal(result.unresolved, 1);
  assert.ok(
    log.lines.warn.some((l) => /RPC bulk_update_torrents es antigua/.test(l)),
    'debe avisar de que hay que reejecutar sql/002_bulk_update_rpc.sql',
  );
});
