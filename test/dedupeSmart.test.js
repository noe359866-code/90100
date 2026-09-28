/**
 * Deduplicación: seguridad (no borrar cuando no se sabe el episodio) y desempate
 * entre doblaje y "sólo subtítulos".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeSupabase } from './helpers/fakeSupabase.js';
import { createDb } from '../src/db.js';
import { runDeduplicator, selectSurvivors, AUDIO_TIE_MARGIN } from '../src/steps/06-deduplicator.js';

const MB = 1024 * 1024;
const silentLog = { debug() {}, info() {}, warn() {}, error() {}, group() {}, groupEnd() {} };

const config = (over = {}) => ({
  table: 'torrents',
  cleanTitleColumn: 'title_text',
  dryRun: false,
  pageSize: 100,
  deleteChunkSize: 100,
  updateConcurrency: 4,
  maxDeleteRatio: 0.95,
  dedupe: { otherLanguagePolicy: 'delete', unknownLanguageAs: 'english', fallbackTitleKey: false, seederWeight: 20, ...over },
});

const row = (id, title, extra = {}) => ({
  id, title, title_text: null, type: 'series', season: null, episode: null, absolute_episode: null,
  imdb_id: 'tt1000', tmdb_id: null, anilist_id: null, kitsu_id: null, mal_id: null,
  size_bytes: 2000 * MB, seeders: 10, audio: null, subtitles: null, codec: null, quality: null,
  updated_at: '2026-01-01', ...extra,
});

const run = async (rows) => {
  const { client, store } = createFakeSupabase(rows.map((r) => ({ ...r })), { rpc: false });
  const db = createDb(config(), { client });
  const result = await runDeduplicator(db, config(), silentLog);
  return { result, quedan: store.tables.torrents.map((r) => r.id) };
};

// ---------------------------------------------------------------------------
// Seguridad: episodio no identificable
// ---------------------------------------------------------------------------
test('dedupe: sin episodio identificable NO se borra nada (pueden ser episodios distintos)', async () => {
  const { result, quedan } = await run([
    row(1, 'Mi Serie 1080p WEB-DL x264-GROUP', { seeders: 100 }),
    row(2, 'Mi Serie 720p HDTV XviD', { seeders: 5 }),
  ]);
  assert.equal(result.deleted, 0, 'no debe borrarse ninguno');
  assert.deepEqual(quedan.sort(), [1, 2]);
  assert.equal(result.skippedUnknownEpisode, 2, 'se informa de las filas protegidas');
});

test('dedupe: con episodio identificable sí se deduplica (control)', async () => {
  const { result, quedan } = await run([
    row(1, 'Mi Serie S01E05 1080p WEB-DL x264', { seeders: 100 }),
    row(2, 'Mi Serie S01E05 720p HDTV XviD', { seeders: 5 }),
  ]);
  assert.equal(result.deleted, 1);
  assert.deepEqual(quedan, [1]);
  assert.equal(result.skippedUnknownEpisode, 0);
});

test('dedupe: el COMPLETE explícito sí se agrupa (hay información suficiente)', async () => {
  const { result, quedan } = await run([
    row(1, 'Mi Serie COMPLETE 1080p WEB-DL x264', { seeders: 100 }),
    row(2, 'Mi Serie COMPLETE 720p HDTV XviD', { seeders: 5 }),
  ]);
  assert.equal(result.deleted, 1, 'dos packs completos de la misma obra son duplicados');
  assert.deepEqual(quedan, [1]);
});

// ---------------------------------------------------------------------------
// Desempate: doblaje vs sólo subtítulos
// ---------------------------------------------------------------------------
/** Candidato con `audio: true` cuando el idioma del grupo está en el AUDIO (doblaje). */
const cand = (id, title, { score, spanish = false, english = false, audio = false } = {}) => ({
  row: { id, title, seeders: 10, size_bytes: 1e9, updated_at: '2026-01-01' },
  score,
  lang: { spanish, english, other: false, unknown: false },
  spanishAudio: audio && spanish ? true : undefined,
  englishAudio: audio && english ? true : undefined,
});

test('dedupe: con puntuación casi empatada gana el doblaje al VOSE', () => {
  const doblaje = cand(1, 'Pelicula 2020 1080p Castellano', { score: 100, spanish: true, audio: true });
  const vose = cand(2, 'Pelicula 2020 1080p VOSE', { score: 108, spanish: true }); // +8: dentro del margen
  const { keep, remove } = selectSurvivors([vose, doblaje], config().dedupe);
  assert.deepEqual([...keep], [1], 'el doblaje gana el empate');
  assert.deepEqual(remove, [2]);
});

test('dedupe: si el VOSE tiene muchos más seeders, gana el VOSE (los seeders mandan)', () => {
  const doblaje = cand(1, 'Pelicula 2020 1080p Castellano', { score: 100, spanish: true, audio: true });
  const vose = cand(2, 'Pelicula 2020 1080p VOSE', { score: 100 + AUDIO_TIE_MARGIN + 5, spanish: true });
  const { keep } = selectSurvivors([doblaje, vose], config().dedupe);
  assert.deepEqual([...keep], [2], 'fuera del margen manda la puntuación');
});

test('dedupe: el desempate no cambia nada si el mejor ya es doblaje', () => {
  const doblaje = cand(1, 'Pelicula 2020 1080p Castellano', { score: 110, spanish: true, audio: true });
  const vose = cand(2, 'Pelicula 2020 1080p VOSE', { score: 100, spanish: true });
  const { keep, remove } = selectSurvivors([vose, doblaje], config().dedupe);
  assert.deepEqual([...keep], [1]);
  assert.deepEqual(remove, [2]);
});

test('dedupe: el desempate funciona igual en el grupo inglés', () => {
  const audioEn = cand(1, 'Movie 2020 1080p English', { score: 100, english: true, audio: true });
  const subsEn = cand(2, 'Movie 2020 1080p VOSTEN', { score: 105, english: true }); // sólo subtítulos
  const { keep } = selectSurvivors([subsEn, audioEn], config().dedupe);
  assert.deepEqual([...keep], [1]);
});

test('dedupe: sin información de audio (candidatos antiguos) no hay desempate', () => {
  const a = cand(1, 'Pelicula 2020 1080p Castellano', { score: 100, spanish: true });
  const b = cand(2, 'Pelicula 2020 1080p VOSE', { score: 105, spanish: true });
  const { keep } = selectSurvivors([a, b], config().dedupe);
  assert.deepEqual([...keep], [2], 'sin bandera de audio se conserva el de más puntuación');
});

test('dedupe (paso completo): el doblaje gana al VOSE casi empatado', async () => {
  const { result, quedan } = await run([
    row(1, 'Pelicula 2020 1080p BluRay x264 Castellano', { type: 'movie', seeders: 100, audio: ['spanish'] }),
    row(2, 'Pelicula 2020 1080p WEB-DL x264 VOSE', { type: 'movie', seeders: 120, subtitles: ['spanish'] }),
  ]);
  assert.equal(result.deleted, 1);
  assert.deepEqual(quedan, [1], 'se conserva el doblaje');
});
