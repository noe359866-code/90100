/**
 * Enriquecimiento "inteligente": prioriza las vías exactas y baratas antes de
 * gastar cuota de búsqueda, y no cruza IDs entre temporadas distintas.
 *
 * Contexto de cuotas: AniList permite 20 req/min (3 s por consulta) y es el
 * recurso más escaso del job; Kitsu 90 req/min y TMDB 20 req/s. Cada llamada de
 * AniList que se puede sustituir por un mapping exacto de Kitsu o por un `/find`
 * de TMDB es tiempo de job que se recupera.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './helpers/fakeSupabase.js';
import { createDb } from '../src/db.js';
import { runEnricher } from '../src/steps/05-enricher.js';
import { buildSearchVariants, parseTitle } from '../src/parser/titleParser.js';

const MB = 1024 * 1024;
const silentLog = { debug() {}, info() {}, warn() {}, error() {}, group() {}, groupEnd() {} };

const config = () => ({
  table: 'torrents',
  cleanTitleColumn: 'title_text',
  dryRun: false,
  pageSize: 100,
  deleteChunkSize: 500,
  updateConcurrency: 8,
  updateChunkSize: 100,
  maxDeleteRatio: 0.95,
  adult: { extraKeywords: [] },
  size: { minMovieBytes: 150 * MB, minSeriesBytes: 30 * MB, applyToAnime: true, includeZero: false },
  dead: { afterDays: 30, includeNullSeeders: false },
  normalize: { overwriteType: false, overwriteEpisodes: false, mergeTitleLanguages: true, typeConfidence: 0.8 },
  enrich: {
    tmdbApiKey: 'fake', maxLookups: 300, minSimilarity: 0.6, tmdbForAnime: true, concurrency: 1,
    anilistPerMinute: 1000, kitsuPerMinute: 1000, tmdbPerSecond: 1000,
    anilistMinPerMinute: 5, kitsuMinPerMinute: 15,
    trackIdsColumns: false, recheckAfterDays: 14, maxAttempts: 3,
  },
  dedupe: { otherLanguagePolicy: 'delete', unknownLanguageAs: 'english', fallbackTitleKey: false, seederWeight: 20 },
});

const row = (id, title, extra = {}) => ({
  id, title, title_text: null, type: null, season: null, episode: null, absolute_episode: null,
  imdb_id: null, tmdb_id: null, anilist_id: null, kitsu_id: null, mal_id: null,
  size_bytes: 2000 * MB, seeders: 10, updated_at: new Date(Date.now() - 86_400_000).toISOString(),
  audio: null, subtitles: null, codec: null, quality: null, ...extra,
});

const statsStub = () => ({ throttles: 0, rate: 1, maxRate: 1, disabled: false });

test('variantes: las de temporada se separan del título pelado (AniList/Kitsu van por temporada)', () => {
  const parsed = parseTitle('Dandadan Season 2 - 03 [1080p]');
  assert.equal(parsed.season, 2);
  const todas = buildSearchVariants(parsed);
  const deTemporada = buildSearchVariants(parsed, { onlySeason: true });
  assert.deepEqual(deTemporada, ['Dandadan 2nd Season', 'Dandadan Season 2', 'Dandadan 2']);
  assert.ok(todas.includes('Dandadan'), 'la lista completa (TMDB) sí lleva el título pelado');
  // Una obra sin temporada no tiene variantes "de temporada" y no debe quedarse sin lista.
  const sinTemporada = parseTitle('Dandadan - 03 [1080p]');
  assert.deepEqual(buildSearchVariants(sinTemporada, { onlySeason: true }), ['Dandadan']);
});

test('temporadas: una obra de T2 no se queda con el ID de la T1', async () => {
  const { client, store } = createFakeSupabase([
    row(1, 'Dandadan - 03 [1080p]', { type: 'anime' }),
    row(2, 'Dandadan Season 2 - 03 [1080p]', { type: 'anime' }),
  ]);
  const db = createDb(config(), { client });

  const anilistQueries = [];
  const result = await runEnricher(db, config(), silentLog, {
    anilist: {
      // Sólo responde al título pelado: es la ficha de la TEMPORADA 1.
      findBest: async (variants) => {
        anilistQueries.push([...variants]);
        if (!variants.includes('Dandadan')) return null;
        return { anilist_id: 111111, mal_id: 222, title: 'Dandadan', englishTitle: 'Dandadan', year: 2024, score: 1 };
      },
      stats: statsStub,
    },
    kitsu: {
      byAniListId: async () => null, byMalId: async () => null, findBest: async () => null,
      externalIds: async () => ({ anilist_id: null, mal_id: null }), stats: statsStub,
    },
    tmdb: { findBest: async () => null, externalIds: async () => ({ imdb_id: null }), stats: statsStub },
  });

  const [t1, t2] = store.tables.torrents;
  assert.equal(t1.anilist_id, 111111, 'la T1 sí resuelve');
  assert.equal(t2.anilist_id, null, 'la T2 NO debe heredar el ID de la T1 (ficha equivocada)');
  assert.equal(result.resolved, 1);
  // Y a AniList nunca se le pregunta por la obra de T2 con el título pelado.
  assert.ok(anilistQueries.length >= 1);
  assert.ok(
    anilistQueries.every((v) => v.includes('Dandadan 2nd Season') || v.includes('Dandadan')),
    'AniList recibe variantes de temporada',
  );
});

test('temporadas: TMDB sí usa el título pelado (su id es por serie, no por temporada)', async () => {
  const { client, store } = createFakeSupabase([row(1, 'Dandadan Season 2 - 03 [1080p]', { type: 'anime' })]);
  const db = createDb(config(), { client });

  const tmdbQueries = [];
  await runEnricher(db, config(), silentLog, {
    anilist: { findBest: async () => null, stats: statsStub },
    kitsu: { byAniListId: async () => null, byMalId: async () => null, findBest: async () => null, externalIds: async () => ({ anilist_id: null, mal_id: null }), stats: statsStub },
    tmdb: {
      // La serie de TMDB se encuentra con el nombre pelado y da el id de la SERIE.
      findBest: async (kind, variants) => {
        tmdbQueries.push([...variants]);
        if (!variants.includes('Dandadan')) return null;
        return { tmdb_id: 240411, kind: 'tv', title: 'Dandadan', year: 2024, score: 0.95 };
      },
      externalIds: async () => ({ imdb_id: null }), stats: statsStub,
    },
  });

  assert.equal(store.tables.torrents[0].tmdb_id, 240411, 'TMDB resuelve la serie con el título pelado');
  assert.ok(tmdbQueries[0].includes('Dandadan'), 'la 1ª pasada de TMDB incluye el título pelado');
});

test('vía exacta: con mal_id conocido, los mappings de Kitsu resuelven sin gastar AniList', async () => {
  const { client, store } = createFakeSupabase([row(1, 'Dandadan - 01 [1080p]', { type: 'anime', mal_id: 52578 })]);
  const db = createDb(config(), { client });

  let anilistCalls = 0;
  const kitsuCalls = [];
  const result = await runEnricher(db, config(), silentLog, {
    anilist: { findBest: async () => { anilistCalls += 1; return null; }, stats: statsStub },
    kitsu: {
      byAniListId: async (id) => { kitsuCalls.push(`anilist:${id}`); return null; },
      byMalId: async (id) => { kitsuCalls.push(`mal:${id}`); return 46019; },
      findBest: async () => { kitsuCalls.push('search'); return null; },
      externalIds: async (kitsuId) => { kitsuCalls.push(`externalIds:${kitsuId}`); return { anilist_id: 178025, mal_id: 52578 }; },
      stats: statsStub,
    },
    tmdb: { findBest: async () => null, externalIds: async () => ({ imdb_id: null }), stats: statsStub },
  });

  const r = store.tables.torrents[0];
  assert.equal(r.kitsu_id, 46019);
  assert.equal(r.anilist_id, 178025, 'el mapping exacto aporta el anilist_id');
  assert.equal(r.mal_id, 52578);
  assert.equal(anilistCalls, 0, 'no se gasta una consulta de AniList (20 req/min) pudiendo usar el mapping');
  assert.equal(kitsuCalls.includes('search'), false, 'tampoco hace falta buscar por texto');
  assert.equal(result.resolved, 1);
});

test('vía exacta: sin ids conocidos sí se busca en AniList (orden de siempre)', async () => {
  const { client } = createFakeSupabase([row(1, 'Dandadan - 01 [1080p]', { type: 'anime' })]);
  const db = createDb(config(), { client });

  const orden = [];
  await runEnricher(db, config(), silentLog, {
    anilist: { findBest: async () => { orden.push('anilist'); return null; }, stats: statsStub },
    kitsu: {
      byAniListId: async () => { orden.push('kitsu-mapping'); return null; },
      byMalId: async () => { orden.push('kitsu-mapping'); return null; },
      findBest: async () => { orden.push('kitsu-search'); return null; },
      externalIds: async () => ({ anilist_id: null, mal_id: null }), stats: statsStub,
    },
    tmdb: { findBest: async () => null, externalIds: async () => ({ imdb_id: null }), stats: statsStub },
  });

  // Sin ids previos no hay mapping que valga: AniList busca primero y Kitsu después,
  // por texto (su mapping necesita un anilist_id/mal_id que aquí no existe).
  assert.deepEqual(orden, ['anilist', 'kitsu-search']);
});

test('vía exacta: con imdb_id, TMDB usa /find y no la búsqueda por texto', async () => {
  const { client, store } = createFakeSupabase([row(1, 'Some Movie 2019 1080p', { type: 'movie', imdb_id: 'tt0106062' })]);
  const db = createDb(config(), { client });

  let searches = 0;
  let finds = 0;
  const result = await runEnricher(db, config(), silentLog, {
    tmdb: {
      findByImdb: async (imdbId) => { finds += 1; assert.equal(imdbId, 'tt0106062'); return { tmdb_id: 301, kind: 'movie', title: 'Some Movie', year: 2019, score: 1 }; },
      findBest: async () => { searches += 1; return null; },
      externalIds: async () => ({ imdb_id: 'tt0106062' }),
      stats: statsStub,
    },
  });

  assert.equal(finds, 1, '/find se consulta una vez');
  assert.equal(searches, 0, 'no se hace búsqueda difusa pudiendo usar la referencia exacta');
  assert.equal(store.tables.torrents[0].tmdb_id, 301);
  assert.equal(result.resolved, 1);
});

test('vía exacta: un imdb_id con formato inválido no llama a /find', async () => {
  const { client } = createFakeSupabase([row(1, 'Some Movie 2019 1080p', { type: 'movie', imdb_id: 'nm0000123' })]);
  const db = createDb(config(), { client });

  let finds = 0;
  let searches = 0;
  await runEnricher(db, config(), silentLog, {
    tmdb: {
      findByImdb: async () => { finds += 1; return null; },
      findBest: async () => { searches += 1; return null; },
      externalIds: async () => ({ imdb_id: null }), stats: statsStub,
    },
  });

  assert.equal(finds, 0, 'nm… no es un id de película/serie');
  assert.equal(searches, 1, 'se cae a la búsqueda por texto');
});

test('vía exacta: si /find falla, se cae a la búsqueda por texto (no se pierde la obra)', async () => {
  const { client, store } = createFakeSupabase([row(1, 'Some Movie 2019 1080p', { type: 'movie', imdb_id: 'tt0106062' })]);
  const db = createDb(config(), { client });

  let searches = 0;
  const result = await runEnricher(db, config(), silentLog, {
    tmdb: {
      findByImdb: async () => { throw new Error('HTTP 500 → /find no disponible'); },
      findBest: async () => { searches += 1; return { tmdb_id: 999, kind: 'movie', title: 'Some Movie', year: 2019, score: 0.9 }; },
      externalIds: async () => ({ imdb_id: 'tt0106062' }), stats: statsStub,
    },
  });

  assert.equal(searches, 1, 'la búsqueda por texto sigue siendo el plan B');
  assert.equal(store.tables.torrents[0].tmdb_id, 999);
  assert.equal(result.resolved, 1);
});

test('vía exacta: el tipo que devuelve /find manda (película vs serie)', async () => {
  const { client, store } = createFakeSupabase([
    row(1, 'Some Show 2019 1080p', { type: 'series', imdb_id: 'tt0106063' }),
  ]);
  const db = createDb(config(), { client });

  const pedidos = [];
  await runEnricher(db, config(), silentLog, {
    tmdb: {
      // El grupo es "series": /find devuelve tv y así no hay que adivinar el tipo.
      findByImdb: async (id, opts) => { pedidos.push(opts?.preferKind ?? null); return { tmdb_id: 555, kind: 'tv', title: 'Some Show', year: 2019, score: 1 }; },
      findBest: async () => { throw new Error('no debería buscar por texto'); },
      externalIds: async () => ({ imdb_id: 'tt0106063' }), stats: statsStub,
    },
  });

  assert.deepEqual(pedidos, ['tv'], '/find sabe qué tipo preferir');
  assert.equal(store.tables.torrents[0].tmdb_id, 555);
});

test('prefiltro del enriquecedor: descubre IDs 0 y vacíos, también en filas sin tipo', async () => {
  const { client, store } = createFakeSupabase([
    row(1, '[SubsPlease] Sousou no Frieren - 09 [1080p]', {
      type: 'anime', tmdb_id: 209867, imdb_id: 'tt0123456', anilist_id: 154587, kitsu_id: 46474, mal_id: 0,
    }),
    row(2, '[Erai-raws] Chainsaw Man - 01 [1080p]', {
      type: null, tmdb_id: 114410, imdb_id: 'tt0123457', anilist_id: 126403, kitsu_id: 50026, mal_id: 0,
    }),
  ]);
  const db = createDb(config(), { client });
  const mappingCalls = [];
  const result = await runEnricher(db, config(), silentLog, {
    anilist: { findBest: async () => null, stats: statsStub },
    kitsu: {
      byAniListId: async () => null,
      byMalId: async () => null,
      findBest: async () => null,
      externalIds: async (id) => {
        mappingCalls.push(id);
        return { anilist_id: null, mal_id: id === 46474 ? 52991 : 44511 };
      },
      stats: statsStub,
    },
    tmdb: { findBest: async () => null, externalIds: async () => ({ imdb_id: null }), stats: statsStub },
  });

  assert.equal(result.scanned, 2, 'ambas las filas deben llegar al enriquecedor');
  assert.deepEqual(mappingCalls.sort((a, b) => a - b), [46474, 50026]);
  assert.equal(store.tables.torrents[0].mal_id, 52991, 'mal_id=0 se trata como ausente');
  assert.equal(store.tables.torrents[1].mal_id, 44511, 'la fila sin tipo también se selecciona por mal_id=0');
});

test('prefiltro del enriquecedor: una cadena imdb_id vacía se considera ausente', async () => {
  const { client, store } = createFakeSupabase([
    row(1, 'Dune Part Two (2024) 1080p', { type: 'movie', tmdb_id: 693134, imdb_id: '' }),
  ]);
  const db = createDb(config(), { client });
  const result = await runEnricher(db, config(), silentLog, {
    tmdb: {
      findBest: async () => null,
      externalIds: async () => ({ imdb_id: 'tt15239678' }),
      stats: statsStub,
    },
  });

  assert.equal(result.scanned, 1);
  assert.equal(store.tables.torrents[0].imdb_id, 'tt15239678');
});
