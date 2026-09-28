import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTitle, buildSearchVariants } from '../src/parser/titleParser.js';

const cases = [
  // --- Anime -------------------------------------------------------------
  { in: '[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCDEF12].mkv', type: 'anime', title: 'Sousou no Frieren', season: null, episode: 9, abs: 9, quality: '1080p', container: 'mkv', group: 'SubsPlease', audio: ['japanese'], subs: ['english'] },
  { in: '[Erai-raws] Jujutsu Kaisen 2nd Season - 05 [1080p][Multiple Subtitle][ENG][POR-BR][SPA-LA][SPA]', type: 'anime', title: 'Jujutsu Kaisen', season: 2, episode: 5, abs: null, subs: ['english', 'latino', 'portuguese', 'spanish'] },
  { in: '[Judas] Shingeki no Kyojin S04E28 - 87 [1080p][HEVC x265 10bit][Dual-Audio]', type: 'anime', title: 'Shingeki no Kyojin', season: 4, episode: 28, abs: 87, codec: 'hevc', bitDepth: 10 },
  { in: 'One Piece - 1085 [1080p]', type: 'anime', title: 'One Piece', episode: 1085, abs: 1085 },
  { in: '[PuyaSubs!] Boku no Hero Academia - 113 [1080p][A1B2C3D4].mkv', type: 'anime', title: 'Boku no Hero Academia', episode: 113, subs: ['spanish'] },
  { in: 'Kimetsu no Yaiba 第09話 (1080p)', type: 'anime', title: 'Kimetsu no Yaiba', episode: 9 },
  { in: '[Judas] Jujutsu Kaisen (Season 2) [1080p][HEVC x265 10bit][Multi-Subs]', type: 'anime', title: 'Jujutsu Kaisen', season: 2, episode: null, pack: true },
  { in: 'Spy x Family - 25 (1080p)', type: 'anime', title: 'Spy x Family', episode: 25 },
  { in: '[ASW] 86 - Eighty Six - 09 [1080p HEVC][AABBCCDD].mkv', type: 'anime', title: '86 - Eighty Six', episode: 9 },
  { in: 'Naruto Shippuden 297 [Latino]', title: 'Naruto Shippuden', episode: 297, abs: 297, audio: ['latino'] },
  { in: 'Attack on Titan S04E28 Episode 87 [Judas]', type: 'anime', title: 'Attack on Titan', season: 4, episode: 28, abs: 87 },

  // --- Series ------------------------------------------------------------
  { in: 'The.Mandalorian.S02E09.1080p.WEB-DL.DDP5.1.Atmos.H.264-FLUX', type: 'series', title: 'The Mandalorian', season: 2, episode: 9, quality: '1080p', source: 'web-dl', codec: 'h264', audioCodec: 'eac3' },
  { in: 'Breaking Bad 2x09 HDTV XviD Spanish', type: 'series', title: 'Breaking Bad', season: 2, episode: 9, codec: 'xvid', audio: ['spanish'] },
  { in: 'The Boys Season 2 Episode 9 1080p', type: 'series', title: 'The Boys', season: 2, episode: 9 },
  { in: 'Show Name 2 - 09 [720p]', type: 'series', title: 'Show Name', season: 2, episode: 9 },
  { in: 'La Casa de Papel - Temporada 2 [HDTV 720p][Cap.209][AC3 5.1 Castellano]', type: 'series', title: 'La Casa de Papel', season: 2, episode: 9, audio: ['spanish'] },
  { in: 'Vikingos 1x01 al 1x09 HDTV Castellano', season: 1, episode: 1, episodeEnd: 9, title: 'Vikingos' },
  { in: 'Show Name S01E01-E10 720p', season: 1, episode: 1, episodeEnd: 10 },
  { in: 'Show.Name.S01.COMPLETE.1080p.WEB.H264-CAKES', type: 'series', title: 'Show Name', season: 1, episode: null, pack: true, complete: true },
  { in: 'S.W.A.T. 2017 S07E10 720p HDTV x264-SYNCOPY', title: 'S.W.A.T', season: 7, episode: 10, year: 2017 },
  { in: 'Mr. Robot S01E01 1080p', title: 'Mr. Robot', season: 1, episode: 1 },
  { in: 'www.Torrenting.com - Chernobyl S01E05 1080p AMZN WEB-DL', title: 'Chernobyl', season: 1, episode: 5 },
  { in: 'The.Office.US.S01E01.720p', title: 'The Office US', season: 1, episode: 1 },
  { in: 'Stranger Things Temporada 4 Capitulo 9 1080p Latino', season: 4, episode: 9, audio: ['latino'] },
  { in: 'Los Simpson 34x05 Castellano HDTV', season: 34, episode: 5, title: 'Los Simpson' },
  { in: 'Show.Name.S02E09.10bit.1080p', season: 2, episode: 9, episodeEnd: null },
  { in: 'Solo Leveling S02E05 VOSTFR 1080p', subs: ['french'] },

  // --- Películas ---------------------------------------------------------
  { in: 'Dune Part Two (2024) 2160p WEB-DL DV HDR10+ HEVC Atmos-FLUX', type: 'movie', title: 'Dune Part Two', year: 2024, quality: '2160p', hdr: 'dv', codec: 'hevc' },
  { in: 'Movie.Name.2019.1080p.BluRay.x264-GROUP', type: 'movie', title: 'Movie Name', year: 2019, source: 'bluray' },
  { in: 'Blade.Runner.2049.2017.1080p.BluRay.x264', title: 'Blade Runner 2049', year: 2017 },
  { in: 'Blade Runner 2049 (2017) 4K UHD', title: 'Blade Runner 2049', year: 2017, quality: '2160p' },
  { in: '2001 A Space Odyssey 1968 1080p', title: '2001 A Space Odyssey', year: 1968 },
  { in: '1917 (2019) 1080p WEBRip Castellano', title: '1917', year: 2019, audio: ['spanish'] },
  { in: "Charlotte's Web (2006) 720p", title: "Charlotte's Web", year: 2006 },
  { in: 'Cast Away 2000 1080p BluRay', title: 'Cast Away', audio: [] },
  { in: 'The English Patient 1996 1080p', title: 'The English Patient', audio: [] },
  { in: 'Back.to.the.Future.1985.1080p', title: 'Back to the Future', year: 1985 },
  { in: 'Fight.Club.1999.1080p', title: 'Fight Club' },
  { in: 'Apollo 13 (1995) 1080p', title: 'Apollo 13', episode: null },
  { in: 'District 9 2009 1080p', title: 'District 9', episode: null },
  { in: 'Spider-Man: No Way Home (2021) [1080p] [Latino-Inglés]', title: 'Spider-Man: No Way Home', audio: ['english', 'latino'] },
  { in: 'Oppenheimer 2023 CAM Latino', source: 'cam', audio: ['latino'] },
  { in: 'Oppenheimer (2023) 1080p TS Castellano', source: 'telesync' },
  { in: 'Cam (2018) 1080p WEB-DL', title: 'Cam', source: 'web-dl' },
  { in: 'ver.pelicula.online.El.Conde.2023.1080p', title: 'El Conde', year: 2023 },
  { in: 'Toy Story 4 (2019) [BluRay Rip 1080p][DTS 5.1 Castellano DTS 5.1-Ingles+Subs][ES-EN]', title: 'Toy Story 4', audio: ['english', 'spanish'] },
  { in: 'Avatar The Way of Water 2022 2160p BluRay REMUX HEVC DTS-HD MA TrueHD 7.1 Atmos-FGT', title: 'Avatar The Way of Water', codec: 'hevc' },
  { in: 'Pelicula 2020 1080p Dual Castellano Ingles VOSE', audio: ['english', 'spanish'], subs: ['spanish'] },
  { in: 'A Complete Unknown (2024) 1080p BluRay', type: 'movie', title: 'A Complete Unknown', year: 2024, complete: false },
  { in: 'Show.Name.S01.Complete.1080p', type: 'series', title: 'Show Name', season: 1, pack: true, complete: true },
  { in: 'Cap.209 The Show', title: 'The Show', season: 2, episode: 9 },
  // Notaciones con separador múltiple ("Ep." + espacio) y "Temporada" abreviada.
  { in: 'Show Ep. 5 720p', title: 'Show', season: null, episode: 5, abs: 5 },
  { in: 'Show Cap. 5 1080p', title: 'Show', season: null, episode: 5, abs: 5 },
  { in: 'Show T01E05 1080p', title: 'Show', season: 1, episode: 5 },
  { in: 'Show T1 EP5 720p', title: 'Show', season: 1, episode: 5 },
  { in: 'Tokyo Revengers T2 E5', title: 'Tokyo Revengers', season: 2, episode: 5 },
  { in: 'Movie Name 1920x1080', title: 'Movie Name', year: null, quality: '1080p' },
  { in: '1920x1080 Movie Name', title: 'Movie Name', year: null, quality: '1080p' },
  { in: 'Anime Title - 01v2 [1080p]', type: 'anime', episode: 1 },
  { in: 'The Extended Cut 2020 1080p', title: 'The Extended Cut', year: 2020 },
  { in: 'Movie.Name.2020.EXTENDED.1080p.BluRay.x264', title: 'Movie Name', year: 2020 },
  { in: 'Movie.Name.2020.1080p.mkv.torrent', title: 'Movie Name', year: 2020, container: 'mkv' },
  { in: 'A Limited Series S01E01 1080p', title: 'A Limited Series', season: 1, episode: 1 },
  { in: 'Some Title', type: 'movie', title: 'Some Title' },
  { in: '', title: '' },

  // --- Grupos de release sin corchetes ------------------------------------
  { in: 'Anime Time One Piece 1080p', type: 'anime', title: 'One Piece', group: 'Anime Time', audio: ['english', 'japanese'], subs: ['english'] },
  { in: 'Anime Pahe: Jujutsu Kaisen Season 2 Episode 5', type: 'anime', title: 'Jujutsu Kaisen', season: 2, episode: 5, group: 'Anime Pahe', subs: ['english'] },
  { in: 'Erai-raws - One Piece - 1075 1080p', type: 'anime', title: 'One Piece', episode: 1075, group: 'Erai-raws' },
  // …pero las palabras que también son nombres de grupo y de uso común no se recortan:
  { in: 'Judas and the Black Messiah 2021 1080p', title: 'Judas and the Black Messiah', year: 2021 },
  // "T-34" y "9-1-1" no deben leerse como notación de temporada/episodio.
  { in: 'T-34 2018 1080p', type: 'movie', title: 'T-34', year: 2018 },
  { in: '9-1-1 S06E01 1080p', type: 'series', title: '9-1-1', season: 6, episode: 1 },
  { in: 'Edge of Tomorrow 2014 1080p', title: 'Edge of Tomorrow', year: 2014 },
  { in: 'Sam: A Saxon S01E01 1080p', title: 'Sam: A Saxon', season: 1, episode: 1 },
  { in: 'Yuri!!! on Ice - 01 1080p', title: 'Yuri!!! on Ice', episode: 1 },
  { in: 'Hakata Ramen Something 2020', title: 'Hakata Ramen Something', year: 2020 },
  { in: 'Anime Land 2020 1080p', title: 'Anime Land', year: 2020 },

  // --- Ruido de webs vs. palabras reales del título ----------------------
  { in: 'Free Guy 2021 1080p', title: 'Free Guy', year: 2021 },
  { in: 'Free Solo 2018 1080p', title: 'Free Solo', year: 2018 },
  { in: 'Free Birds 2013 1080p', title: 'Free Birds', year: 2013 },
  { in: 'Born Free 1966 1080p', title: 'Born Free', year: 1966 },
  { in: 'The Free 2015', title: 'The Free' },
  { in: 'Dual (2022) 1080p WEB-DL', title: 'Dual', year: 2022, source: 'web-dl' },
  { in: 'Dual 2022 1080p', title: 'Dual', year: 2022 },
  { in: 'Mi Pelicula 2020 1080p Latino', title: 'Mi Pelicula', year: 2020, audio: ['latino'] },
  { in: 'La Pelicula 2020 1080p', title: 'La Pelicula', year: 2020 },
  { in: 'Pelicula 2020 1080p', title: 'Pelicula', year: 2020 },
  // Recortar los dos extremos a la vez dejaría "X": se conserva y se quita sólo "Torrent".
  { in: 'Pelicula X Torrent', title: 'Pelicula X' },
  // …y el ruido de webs sigue eliminándose cuando el título sobrevive.
  { in: 'Descargar Pelicula Batman 2022 1080p', title: 'Batman', year: 2022 },
  { in: 'Batman Online 2022 1080p', title: 'Batman', year: 2022 },
  { in: 'Ver Online El Conde 2023 1080p', title: 'El Conde', year: 2023 },
  { in: 'Movie Name Torrent 2019 1080p', title: 'Movie Name', year: 2019 },
];

for (const c of cases) {
  test(`parseTitle: ${c.in || '(vacío)'}`, () => {
    const p = parseTitle(c.in);
    if ('type' in c) assert.equal(p.type, c.type, 'type');
    if ('title' in c) assert.equal(p.cleanTitle, c.title, 'cleanTitle');
    if ('season' in c) assert.equal(p.season, c.season, 'season');
    if ('episode' in c) assert.equal(p.episode, c.episode, 'episode');
    if ('episodeEnd' in c) assert.equal(p.episodeEnd, c.episodeEnd, 'episodeEnd');
    if ('abs' in c) assert.equal(p.absoluteEpisode, c.abs, 'absoluteEpisode');
    if ('pack' in c) assert.equal(p.isSeasonPack, c.pack, 'isSeasonPack');
    if ('complete' in c) assert.equal(p.isComplete, c.complete, 'isComplete');
    if ('year' in c) assert.equal(p.year, c.year, 'year');
    if ('quality' in c) assert.equal(p.quality, c.quality, 'quality');
    if ('source' in c) assert.equal(p.source, c.source, 'source');
    if ('codec' in c) assert.equal(p.codec, c.codec, 'codec');
    if ('audioCodec' in c) assert.equal(p.audioCodec, c.audioCodec, 'audioCodec');
    if ('container' in c) assert.equal(p.container, c.container, 'container');
    if ('hdr' in c) assert.equal(p.hdr, c.hdr, 'hdr');
    if ('bitDepth' in c) assert.equal(p.bitDepth, c.bitDepth, 'bitDepth');
    if ('group' in c) assert.equal(p.releaseGroup, c.group, 'releaseGroup');
    if ('audio' in c) assert.deepEqual(p.languages.audio, c.audio, 'audio');
    if ('subs' in c) assert.deepEqual(p.languages.subtitles, c.subs, 'subtitles');
  });
}

test('buildSearchVariants: anime con temporada prueba primero "2nd Season"', () => {
  const p = parseTitle('[Erai-raws] Jujutsu Kaisen 2nd Season - 05 [1080p]');
  const v = buildSearchVariants(p);
  assert.equal(v[0], 'Jujutsu Kaisen 2nd Season');
  assert.ok(v.includes('Jujutsu Kaisen'));
});

test('buildSearchVariants: recorta subtítulo tras ":"', () => {
  const v = buildSearchVariants(parseTitle('Frieren: Beyond Journey\'s End S01E09 1080p'));
  assert.deepEqual(v, ['Frieren: Beyond Journey\'s End', 'Frieren']);
});

test('parseTitle: searchKey normaliza acentos y artículos', () => {
  assert.equal(parseTitle('El Señor de los Anillos (2001) 1080p').searchKey, 'senor de anillos');
});

test('parseTitle: el título limpio nunca queda vacío ni mutilado', () => {
  // Regresión: la limpieza de ruido de webs recortaba títulos reales.
  const titles = [
    'Free Guy 2021 1080p', 'Dual (2022) 1080p', 'Mi Pelicula 2020 1080p', 'La Pelicula 2020 1080p',
    'Born Free 1966 1080p', 'The Free 2015', 'Pelicula 2020 1080p', 'Online 2018 1080p',
    'Torrent 2022 1080p', 'Gratis 2019 720p', 'Download 2020 1080p',
  ];
  for (const t of titles) {
    const p = parseTitle(t);
    assert.ok(p.cleanTitle.length >= 2, `"${t}" → cleanTitle vacío o de un solo carácter (${JSON.stringify(p.cleanTitle)})`);
  }
});

test('parseTitle: nunca lanza con basura', () => {
  for (const junk of [null, undefined, 123, '   ', '[[[', ')))', '....', '- - -', 'S01E', '1x', 'Cap.', '第話']) {
    assert.doesNotThrow(() => parseTitle(junk));
  }
});
