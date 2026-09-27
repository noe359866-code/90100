import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAdultRegex, isAdultTitle } from '../src/steps/01-adultFilter.js';
import { buildNormalizationPatch } from '../src/steps/04-normalizer.js';
import { missingIdsFor } from '../src/steps/05-enricher.js';
import { scoreTorrent, selectSurvivors, episodeKey, workIdentifiers } from '../src/steps/06-deduplicator.js';
import { parseTitle } from '../src/parser/titleParser.js';
import { classifyLanguage, normalizeLanguageArray } from '../src/parser/languages.js';

// ---------------------------------------------------------------------------
// Paso 1 — filtro adulto
// ---------------------------------------------------------------------------
const adultRe = new RegExp(buildAdultRegex(), 'i');

test('adult: detecta contenido explícito', () => {
  for (const t of ['Brazzers - Hot MILF', 'Amateur XXX Porno Casero', 'Big Tits at School', 'Backdoor Sluts 9', 'Hentai Uncensored 01', '[NSFW] Collection']) {
    assert.equal(isAdultTitle(t, adultRe), true, t);
  }
});

test('adult: respeta títulos legítimos', () => {
  for (const t of ['Saving Private Ryan 1998', 'xXx: Return of Xander Cage (2017) 1080p', 'Sex Education S01E01', 'Analyze This 1999', 'The Naked Director S01', 'Hardcore Henry 2015', 'Sexo, pudor y lágrimas 1999', 'Canal Street', 'Dune 2021', 'Pussy Riot: A Punk Prayer']) {
    assert.equal(isAdultTitle(t, adultRe), false, t);
  }
});

test('adult: la lista blanca no salva palabras duras', () => {
  assert.equal(isAdultTitle('Sex Education XXX Parody Brazzers', adultRe), true);
});

test('adult: palabras extra por configuración', () => {
  const re = new RegExp(buildAdultRegex(['palabrarara']), 'i');
  assert.equal(isAdultTitle('Titulo palabrarara 2020', re), true);
});

// ---------------------------------------------------------------------------
// Paso 4/5 — normalizador
// ---------------------------------------------------------------------------
const cfg = {
  cleanTitleColumn: 'title_text',
  normalize: { overwriteType: false, overwriteEpisodes: false, mergeTitleLanguages: true, typeConfidence: 0.8 },
};

test('normalizer: rellena campos vacíos y limpia arrays', () => {
  const row = {
    id: 1, title: 'The.Mandalorian.S02E09.1080p.WEB-DL.DDP5.1.H.264-FLUX', title_text: null, type: null,
    season: null, episode: null, absolute_episode: null, codec: 'X264', quality: '1080P', audio: ['ENG', 'English', 'aac'], subtitles: null,
  };
  const patch = buildNormalizationPatch(row, cfg);
  assert.deepEqual(patch, {
    title_text: 'The Mandalorian', type: 'series', season: 2, episode: 9, codec: 'h264', quality: '1080p', audio: ['english'],
  });
});

test('normalizer: no toca lo que ya está bien', () => {
  const row = {
    id: 1, title: 'The.Mandalorian.S02E09.1080p.WEB-DL.H.264-FLUX', title_text: 'The Mandalorian', type: 'series',
    season: 2, episode: 9, absolute_episode: null, codec: 'h264', quality: '1080p', audio: [], subtitles: [],
  };
  assert.equal(buildNormalizationPatch(row, cfg), null);
});

test('normalizer: no sobrescribe type/episodios salvo configuración', () => {
  const row = { id: 1, title: '[SubsPlease] Frieren - 09 (1080p)', title_text: 'Frieren', type: 'series', season: 3, episode: 1, absolute_episode: null, codec: null, quality: '1080p', audio: ['japanese'], subtitles: ['english'] };
  const patch = buildNormalizationPatch(row, cfg);
  assert.deepEqual(patch, { absolute_episode: 9 });
  const patch2 = buildNormalizationPatch(row, { ...cfg, normalize: { ...cfg.normalize, overwriteType: true, overwriteEpisodes: true } });
  assert.equal(patch2.type, 'anime');
  assert.equal(patch2.episode, 9);
});

test('normalizer: fusiona idiomas del título con los de la BD', () => {
  const row = { id: 1, title: 'Pelicula 2020 1080p Castellano', title_text: 'Pelicula', type: 'movie', season: null, episode: null, absolute_episode: null, codec: null, quality: '1080p', audio: ['en'], subtitles: [] };
  const patch = buildNormalizationPatch(row, cfg);
  assert.deepEqual(patch.audio, ['english', 'spanish']);
});

// ---------------------------------------------------------------------------
// Paso 6 — enricher
// ---------------------------------------------------------------------------
test('enricher: missingIdsFor según tipo', () => {
  assert.deepEqual([...missingIdsFor('anime', { anilist_id: null, kitsu_id: 5, mal_id: null, tmdb_id: null, imdb_id: null }, { hasTmdb: false })], ['anilist_id', 'mal_id']);
  assert.deepEqual([...missingIdsFor('movie', { tmdb_id: null, imdb_id: null }, { hasTmdb: true })], ['tmdb_id', 'imdb_id']);
  assert.deepEqual([...missingIdsFor('movie', { tmdb_id: 1, imdb_id: 'tt1' }, { hasTmdb: true })], []);
  assert.deepEqual([...missingIdsFor('series', { tmdb_id: null }, { hasTmdb: false })], []);
});

// ---------------------------------------------------------------------------
// Paso 7 — deduplicador
// ---------------------------------------------------------------------------
const mk = (id, title, { seeders = 10, audio = [], subtitles = [], type = 'series', season = null, episode = null, size = 2e9, codec = null, quality = null } = {}) => {
  const row = { id, title, seeders, audio, subtitles, type, season, episode, absolute_episode: null, size_bytes: size, codec, quality, updated_at: '2026-01-01' };
  const parsed = parseTitle(title);
  const a = [...new Set([...normalizeLanguageArray(audio), ...parsed.languages.audio])];
  const s = [...new Set([...normalizeLanguageArray(subtitles), ...parsed.languages.subtitles])];
  return { row, parsed, score: scoreTorrent(row, parsed).score, lang: classifyLanguage({ audio: a, subtitles: s }) };
};
const dedupeCfg = { otherLanguagePolicy: 'delete', unknownLanguageAs: 'english' };

test('dedupe: seeders mandan, pero CAM pierde frente a BluRay con seeders parecidos', () => {
  const cam = mk(1, 'Movie 2023 1080p CAM x264', { seeders: 120 });
  const blu = mk(2, 'Movie 2023 1080p BluRay x264', { seeders: 80 });
  assert.ok(blu.score > cam.score);
  const many = mk(3, 'Movie 2023 1080p CAM x264', { seeders: 5000 });
  assert.ok(many.score > blu.score, 'con muchísimos más seeders gana igualmente');
});

test('dedupe: H.264 > HEVC > AV1 a igualdad de seeders', () => {
  const h264 = mk(1, 'Movie 2023 1080p WEB-DL x264', { seeders: 50 });
  const hevc = mk(2, 'Movie 2023 1080p WEB-DL x265', { seeders: 50 });
  const av1 = mk(3, 'Movie 2023 1080p WEB-DL AV1', { seeders: 50 });
  assert.ok(h264.score > hevc.score && hevc.score > av1.score);
});

test('dedupe: conserva 1 spanish + 1 english y borra el resto', () => {
  const candidates = [
    mk(1, 'Movie 2023 1080p Castellano', { seeders: 50 }),
    mk(2, 'Movie 2023 720p Latino', { seeders: 200 }),
    mk(3, 'Movie 2023 1080p English', { audio: ['eng'], seeders: 30 }),
    mk(4, 'Movie 2023 2160p', { audio: ['en'], seeders: 300 }),
    mk(5, 'Movie 2023 1080p French', { audio: ['fr'], subtitles: ['fr'], seeders: 999 }),
  ];
  const { keep, remove } = selectSurvivors(candidates, dedupeCfg);
  assert.deepEqual([...keep].sort(), [2, 4]);
  assert.deepEqual(remove.sort(), [1, 3, 5]);
});

test('dedupe: un dual-audio puede ganar ambos grupos', () => {
  const candidates = [
    mk(1, 'Movie 2023 1080p Dual Castellano Ingles', { seeders: 500 }),
    mk(2, 'Movie 2023 1080p Castellano', { seeders: 50 }),
    mk(3, 'Movie 2023 1080p English', { audio: ['en'], seeders: 50 }),
  ];
  const { keep, remove } = selectSurvivors(candidates, dedupeCfg);
  assert.deepEqual([...keep], [1]);
  assert.deepEqual(remove.sort(), [2, 3]);
});

test('dedupe: sin idioma se trata como english (configurable) y otros idiomas se pueden conservar', () => {
  const candidates = [
    mk(1, 'Movie 2023 1080p', { seeders: 10 }),
    mk(2, 'Movie 2023 1080p', { seeders: 20 }),
    mk(3, 'Movie 2023 1080p', { audio: ['fr'], subtitles: ['fr'], seeders: 5 }),
  ];
  const a = selectSurvivors(candidates, dedupeCfg);
  assert.deepEqual([...a.keep], [2]);
  const b = selectSurvivors(candidates, { otherLanguagePolicy: 'keep', unknownLanguageAs: 'keep' });
  assert.deepEqual(b.remove, []);
});

test('dedupe: episodeKey y workIdentifiers', () => {
  const p = parseTitle('Show S02E09 1080p');
  assert.equal(episodeKey({ type: 'series', season: 2, episode: 9 }, p), 's2e9');
  assert.equal(episodeKey({ type: 'movie', season: null, episode: null }, parseTitle('Movie 2020')), 'movie');
  const pa = parseTitle('[SubsPlease] Show - 09 (1080p)');
  assert.equal(episodeKey({ type: 'anime', season: null, episode: 9 }, pa), 'e9');
  assert.equal(episodeKey({ type: 'anime', season: 1, episode: 9 }, pa), 'e9');
  assert.equal(episodeKey({ type: 'anime', season: null, episode: null }, pa), 'e9', 'usa el parser si la BD está vacía');
  assert.equal(episodeKey({ type: 'series', season: 1, episode: null }, parseTitle('Show S01 COMPLETE')), 's1pack');
  assert.deepEqual(workIdentifiers({ type: 'movie', imdb_id: 'TT123', tmdb_id: 5, anilist_id: null, kitsu_id: null }, p), ['imdb:tt123', 'tmdb:movie:5']);
  assert.deepEqual(workIdentifiers({ type: 'series', tmdb_id: 5 }, p), ['tmdb:tv:5']);
});
