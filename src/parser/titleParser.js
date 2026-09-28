/**
 * PARSER INTELIGENTE DE TÍTULOS DE TORRENTS
 * ==========================================
 *
 * Motor de expresiones regulares tolerante a fallos que, a partir del `title`
 * en bruto de un torrent, extrae:
 *
 *   - type / typeConfidence  → 'anime' | 'series' | 'movie' y confianza (0-1)
 *   - season / episode / episodeEnd / absoluteEpisode / isSeasonPack
 *   - year, quality (2160p/1080p/...), source (bluray/web-dl/...), codec,
 *     audioCodec, container, hdr, bitDepth, releaseGroup
 *   - languages { audio, subtitles } inferidos del título
 *   - cleanTitle → título limpio optimizado para consultar APIs externas
 *   - searchKey  → clave normalizada para agrupar/cachear
 *
 * Estrategia general (inspirada en parse-torrent-title, pero ampliada para
 * anime, nomenclatura española "Cap.209"/"Temporada 2" y episodios absolutos):
 *
 *   1. Se trabaja con dos vistas del título:
 *        `full`     → título sin extensión (metadatos dentro de [] y () incluidos)
 *        `stripped` → `full` sin los grupos [] () {} (para localizar el título)
 *   2. Los metadatos se extraen sobre `full`.
 *   3. El título limpio es lo que precede al PRIMER "token de corte" en `stripped`
 *      (episodio, temporada, año, resolución, fuente, códec, idioma inequívoco...).
 */

import { ANIME_GROUPS, lookupAnimeGroup } from './animeGroups.js';
import { detectTitleLanguages } from './languages.js';
import { normalizeKey } from '../utils/text.js';

const CURRENT_YEAR = new Date().getFullYear();

// ---------------------------------------------------------------------------
// Expresiones regulares base
// ---------------------------------------------------------------------------

const RE_EXTENSION = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts|m2ts|iso|rmvb|ogm)\s*$/i;
const RE_CRC = /[\[(][0-9A-Fa-f]{8}[\])]/;
const RE_LEADING_GROUP = /^\s*\[([^\]]{1,60})\]/;
/**
 * Prefijos de webs/trackers ("www.Site.com - ", "[www.newpct1.com]", "ver.pelicula.online.").
 * Sólo se elimina si empieza por "www." o si el dominio contiene una palabra
 * típica de tracker: así evitamos romper títulos como "Back.to.the.Future" o "The.Office.US".
 */
const SITE_TLDS = 'com|net|org|info|biz|xyz|online|site|club|tv|cc|ws|top|vip|pro|link|live|stream|zone|lol|fun|wtf|ninja|team|one|me|to|io|es|co|lat|mx|ar|cl|pe|pw|li|st|is|se|ag|ch|nl|ru|si|red|app';
const RE_SITE_PREFIX = new RegExp(
  `^[\\s[(]*(?:www\\.(?:[a-z0-9-]+\\.)+[a-z]{2,10}|(?:[a-z0-9-]+\\.)*[a-z0-9-]*(?:torrent|pct|divx|yts|yify|rarbg|1337x|eztv|ettv|tgx|estrenos?|descargas?|pelis?|pelicula|cine|dontorrent|mejortorrent|elitetorrent|todotorrents|hdolimpo|cinecalidad|pelisplus)[a-z0-9-]*\\.(?:${SITE_TLDS}))(?![a-z])[\\])]*[\\s\\-_.:]*`,
  'i',
);
const RE_BRACKET_GROUPS = /\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g;
const RE_JAPANESE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

// --- Episodio con temporada ---------------------------------------------
const EPISODE_PATTERNS = [
  {
    kind: 'sxxexx', // S02E09, S2E9, S02.E09, S02E09E10, S02E09-E10, S02E09-10
    re: /(?<![A-Za-z0-9])S(\d{1,2})[ ._-]?E[Pp]?(\d{1,3})(?:(?:[ ._-]?E[Pp]?|-)(\d{1,3}))?(?![\dp])/i,
    map: (m) => ({ season: +m[1], episode: +m[2], episodeEnd: m[3] ? +m[3] : null }),
  },
  {
    kind: 'txxexx', // T01E05, T1 EP05, T2 E09-E10 (notación "Temporada" de muchos trackers en español)
    re: /(?<![A-Za-z0-9])T[ ._-]?(\d{1,2})[ ._-]*E[Pp]?[ ._-]*(\d{1,3})(?:(?:[ ._-]?E[Pp]?|-)[ ._-]?(\d{1,3}))?(?![\dp])/i,
    map: (m) => ({ season: +m[1], episode: +m[2], episodeEnd: m[3] ? +m[3] : null }),
  },
  {
    kind: 'season_episode_words', // Season 2 Episode 9, Temporada 2 Capítulo 9
    re: /(?<![A-Za-z0-9])(?:Season|Temporada|Saison|Stagione|Staffel|Temp)[ ._-]*(\d{1,2})[ ._-]*(?:Episode|Episodio|Cap[ií]tulo|Cap|Ep|E)[ ._-]*(\d{1,3})(?![\dp])/i,
    map: (m) => ({ season: +m[1], episode: +m[2], episodeEnd: null }),
  },
  {
    kind: 'nxnn', // 2x09, 1x01-1x10, 1x01 al 1x10
    re: /(?<![A-Za-z0-9])(\d{1,2})[xX](\d{1,3})(?:[ ._-]*(?:al|a|to|-)[ ._-]*(?:\d{1,2}[xX])?(\d{1,3}))?(?![\dp])/,
    map: (m) => ({ season: +m[1], episode: +m[2], episodeEnd: m[3] ? +m[3] : null }),
  },
  {
    kind: 'cap_spanish', // Cap.209 (S02E09), Cap.1005 (S10E05), Cap.201_204
    re: /(?<![A-Za-z0-9])Cap(?:[ií]tulos?)?[ ._-]*(\d{1,2})(\d{2})(?:[ ._-]*(?:al|a|-|_|y)[ ._-]*(?:\d{1,2})?(\d{2}))?(?!\d)/i,
    map: (m) => ({ season: +m[1], episode: +m[2], episodeEnd: m[3] ? +m[3] : null }),
  },
  {
    kind: 'dash_season_episode', // "Show 2 - 09" (temporada 2, episodio 9)
    re: /(?<![A-Za-z0-9\-–—#])(\d{1,2})[ ._]+[-–—][ ._]+(\d{1,3})(?:v\d)?(?![\dp.])/,
    map: (m) => ({ season: +m[1], episode: +m[2], episodeEnd: null }),
    requireLettersBefore: true,
  },
];

// --- Episodio absoluto (sin temporada) ------------------------------------
const ABSOLUTE_PATTERNS = [
  {
    kind: 'dash', // "Frieren - 09", "One Piece - 1085", "- 09v2"
    re: /[ ._]+[-–—][ ._]+(\d{1,4})(?:v\d)?(?=[ ._[(\-–—]|$)(?!\.\d)/g,
  },
  {
    kind: 'word', // E09, Ep. 9, Ep 9, Episode 9, Episodio 9, Capítulo 9, Cap. 9
    // Separadores con `*` (y no `?`): "Ep. 5" y "Cap. 5" llevan punto Y espacio,
    // y con un solo carácter no se reconocían (el marcador quedaba en el título).
    re: /(?<![A-Za-z0-9])(?:Episode|Episodio|Ep|E|Cap[ií]tulo|Cap|Chapter|Folge)[ ._-]*(\d{1,4})(?:v\d)?(?![\dp])/gi,
  },
  { kind: 'cjk', re: /第(\d{1,4})[話话集]/g }, // 第09話
  { kind: 'hash', re: /#(\d{1,4})(?![\dp])/g }, // #09
  { kind: 'bracket', re: /\[(\d{1,3})(?:v\d)?\]/g }, // [09]
];

// --- Temporada sin episodio (packs) ---------------------------------------
const SEASON_PATTERNS = [
  {
    kind: 'sxx', // S02, S01-S03, S01-03
    re: /(?<![A-Za-z0-9])S(\d{1,2})(?:[ ._-]*(?:-|to|a|al)[ ._-]*S?(\d{1,2}))?(?![A-Za-z0-9])/i,
  },
  {
    kind: 'word', // Season 2, Temporada 2, Season 1-3, Temporadas 1 a 3
    re: /(?<![A-Za-z0-9])(?:Seasons?|Temporadas?|Saisons?|Stagione|Staffel|Temp|Sezon)[ ._-]*(\d{1,2})(?:[ ._-]*(?:-|to|a|al|&|\+|~)[ ._-]*(\d{1,2}))?(?!\d)/i,
  },
  {
    kind: 'ordinal', // 2nd Season, 3ª Temporada
    re: /(?<![A-Za-z0-9])(\d{1,2})(?:st|nd|rd|th|ª|°|º|a)[ ._-]*(?:Season|Temporada)/i,
  },
];

// --- Metadatos técnicos -----------------------------------------------------
// `x\d` evita leer el año 1920 dentro de "1920x1080".
const RE_YEAR_GLOBAL = /(?<!\d)((?:19|20)\d{2})(?![\dp]|x\d)/g;
const RE_YEAR_BRACKETED = /[[(]\s*((?:19|20)\d{2})\s*[\])]/;

const RE_QUALITY = /(?<![A-Za-z0-9])(2160p|1080p|1080i|720p|576p|480p|360p|4K|UHD|FHD|3840x2160|1920x1080|1280x720)(?![A-Za-z0-9])/i;
const QUALITY_MAP = { '4k': '2160p', uhd: '2160p', '3840x2160': '2160p', fhd: '1080p', '1920x1080': '1080p', '1080i': '1080p', '1280x720': '720p' };

const RE_SOURCE = /(?<![A-Za-z0-9])(BDRemux|BD-?Rip|BRRip|Blu-?Ray|UHD-?Rip|UHD-?BD|REMUX|WEB-?DL|WEBRip|WEB-?Cap|HDTVRip|HDTV|HDRip|DVDRip|DVDScr|DVDR|DVD|HDCAM|HDTS|HDTC|TELESYNC|TELECINE|PDTV|SATRip|VHSRip|MicroHD|AMZN|DSNP|HMAX|ATVP)(?![A-Za-z0-9])/i;
const RE_SOURCE_CS = /(?<![A-Za-z0-9])(CAM|TS|TC|SCR|R5|WEB|BD|NF)(?![A-Za-z0-9])/; // sólo en mayúsculas (evita "Charlotte's Web")
const SOURCE_MAP = {
  bdremux: 'remux', remux: 'remux', bdrip: 'bluray', 'bd-rip': 'bluray', brrip: 'bluray', bluray: 'bluray', 'blu-ray': 'bluray', bd: 'bluray', uhdrip: 'bluray', 'uhd-rip': 'bluray', uhdbd: 'bluray', 'uhd-bd': 'bluray',
  'web-dl': 'web-dl', webdl: 'web-dl', webrip: 'webrip', web: 'web-dl', webcap: 'webrip', 'web-cap': 'webrip', amzn: 'web-dl', nf: 'web-dl', dsnp: 'web-dl', hmax: 'web-dl', atvp: 'web-dl',
  hdtv: 'hdtv', hdtvrip: 'hdtv', pdtv: 'hdtv', satrip: 'hdtv', hdrip: 'hdrip', microhd: 'bluray',
  dvdrip: 'dvdrip', dvdr: 'dvd', dvd: 'dvd', dvdscr: 'screener', scr: 'screener', r5: 'screener', vhsrip: 'vhs',
  cam: 'cam', hdcam: 'cam', ts: 'telesync', hdts: 'telesync', telesync: 'telesync', tc: 'telecine', hdtc: 'telecine', telecine: 'telecine',
};

const RE_CODEC = /(?<![A-Za-z0-9])(?:(x\.?264|h\.?264|AVC)|(x\.?265|h\.?265|HEVC)|(AV1)|(XviD|DivX)|(VP9)|(MPEG-?2)|(VC-?1))(?![A-Za-z0-9])/i;
const CODEC_NAMES = ['h264', 'hevc', 'av1', 'xvid', 'vp9', 'mpeg2', 'vc1'];

const RE_AUDIO_CODEC = /(?<![A-Za-z0-9])(?:(DDP|DD\+|E-?AC-?3)|(AC-?3|DD)|(AAC)|(DTS-?HD(?:[ .]?MA)?|DTS-?X|DTS)|(TrueHD)|(Atmos)|(FLAC)|(Opus)|(MP3)|(L?PCM))(?:[ .]?\d\.\d)?(?![A-Za-z0-9])/i;
const AUDIO_CODEC_NAMES = ['eac3', 'ac3', 'aac', 'dts', 'truehd', 'atmos', 'flac', 'opus', 'mp3', 'pcm'];
const RE_CHANNELS = /(?<![A-Za-z0-9.])(2\.0|5\.1|7\.1)(?![A-Za-z0-9])/;

const RE_HDR = /(?<![A-Za-z0-9])(HDR10\+|HDR10Plus|HDR10|HDR|DV|DoVi|Dolby[ .]?Vision|HLG|SDR)(?![A-Za-z0-9])/i;
const RE_BIT_DEPTH = /(?<![A-Za-z0-9])(?:(10|8)[ -]?bits?|Hi10P?)(?![A-Za-z0-9])/i;

const RE_COMPLETE = /(?<![A-Za-z0-9])(COMPLETE|COMPLETA|COMPLETO|Batch|Int[eé]grale|Full[ .-]?(?:Season|Series)|Serie[ .-]Completa|Temporada[ .-]Completa|Complete[ .-]Series)(?![A-Za-z0-9])/i;
const RE_FLAGS = /(?<![A-Za-z0-9])(REPACK|PROPER|RERIP|iNTERNAL|INTERNAL|LIMITED|EXTENDED|UNRATED|Directors?(?:'s)?[ ._-]?Cut|Theatrical(?:[ ._-]?Cut)?|IMAX|REMASTERED|Uncut|UNCENSORED|Censored|HC|HardSub(?:bed)?|SoftSub(?:bed)?|Dubbed|Subbed)(?![A-Za-z0-9])/i;
const RE_ANIME_EXTRA = /(?<![A-Za-z0-9])(OVA|ONA|OAD|NCOP|NCED|BDMV)(?![A-Za-z0-9])/i;
const RE_DUAL_MULTI = /(?<![A-Za-z0-9])(Dual[ ._-]?(?:Audio|Áudio|Lang)?|Multi[ ._-]?(?:Audio|Lang(?:uage)?s?)?|Multi[ ._-]?Subs?|Multiple[ ._-]?Subtitles?|MultiSub|Tri[ ._-]?Audio)(?![A-Za-z0-9])/i;

/** Tokens de idioma inequívocos (seguros como punto de corte del título). */
const RE_LANG_CUT = /(?<![A-Za-z0-9])(Castellano|Latino|Espa[ñn]ol|VOSE|VOSI|Subtitulad[oa]s?|Sub[ ._-]?Esp(?:a[ñn]ol)?|Subs?[ ._-]?(?:Eng|Es|Spa|Lat)|Audio[ ._-]?(?:Latino|Espa[ñn]ol|Castellano|Ingl[eé]s)|Doblad[oa]|SPA|ENG|LAT|CAST|ESP|JAP|JPN|ITA|GER|FRE|POR|RUS)(?![A-Za-z0-9])/;
/** Tokens de idioma que sólo se eliminan si están AL FINAL del título ya cortado. */
const RE_LANG_TRAILING = /(?:(?:^|[\s\-–—_.]+)(?:Spanish|English|Japanese|Ingl[eé]s|French|German|Italian|Portuguese|Dubbed|Subbed|Dual|Multi|Latino|Castellano|Espa[ñn]ol|VOSE|VO|HD|HQ|Torrent|Descargar|Download|Online|Gratis|Free))+\s*$/i;

const RE_MISC_NOISE = /(?<![A-Za-z0-9])(?:Descargar|Download|Torrent|Estreno|Ver[ ._]Online|Online|Gratis|Free|Peliculas?|Pel[ií]culas?|Series?[ ._]Completa)(?![A-Za-z0-9])/i;
/** Variantes "al inicio"/"al final" de RE_MISC_NOISE, precompiladas (polishTitle corre por cada fila). */
const RE_MISC_NOISE_LEAD = new RegExp(`^(?:\\s*${RE_MISC_NOISE.source}[\\s._-]*)+`, 'i');
const RE_MISC_NOISE_TRAIL = new RegExp(`(?:[\\s._-]*${RE_MISC_NOISE.source}\\s*)+$`, 'i');

/**
 * Palabras de ruido que TAMBIÉN son palabras normales de un título: "Free Guy",
 * "Free Solo", "La Pelicula", "Born Free". Cuando la limpieza toca una de ellas
 * se exige que lo que queda siga pareciendo un título.
 */
const NOISE_AMBIGUOUS_RE = /(?<![A-Za-z0-9])(?:Free|Online|Estreno|Pel[ií]culas?)(?![A-Za-z0-9])/i;

/**
 * ¿El texto restante sigue pareciendo un título? Evita recortes destructivos:
 * "Free Guy" → "Guy", "Mi Pelicula" → "Mi", "Dual" → "".
 * Una sola palabra muy corta es casi siempre un resto.
 */
export function isPlausibleTitle(text) {
  const t = String(text ?? '').trim();
  if (t.length < 2) return false;
  if (/\s/.test(t)) return true; // dos o más palabras
  return t.length >= 6; // una sola palabra: que no sea un resto ("Guy", "Mi", "La")
}

/** Quita `RE_LANG_TRAILING` sólo si el título sobrevive al recorte. */
function stripTrailingLanguage(text) {
  const m = RE_LANG_TRAILING.exec(text);
  if (!m) return text;
  const rest = text.slice(0, m.index);
  return isPlausibleTitle(rest) ? rest : text;
}

/**
 * Quita ruido de webs en los extremos. Ambos extremos se deciden en bloque:
 * recortar sólo el principio puede dejar un resto peor que el original
 * ("Pelicula X Torrent" → "X Torrent"); así se conserva y es `RE_LANG_TRAILING`
 * la que retira después " Torrent" → "Pelicula X".
 */
function stripEdgeNoise(text) {
  const lead = RE_MISC_NOISE_LEAD.exec(text);
  const afterLead = lead ? text.slice(lead[0].length) : text;
  const trail = RE_MISC_NOISE_TRAIL.exec(afterLead);
  if (!lead && !trail) return text;
  const rest = (trail ? afterLead.slice(0, trail.index) : afterLead).trim();
  // Palabras ambiguas ("Free Guy", "Mi Pelicula") o recortar los dos extremos a
  // la vez exigen que el resto siga pareciendo un título; con ruido inequívoco
  // ("Descargar Pelicula Batman") basta con que no quede vacío.
  const ambiguous = Boolean(lead && trail)
    || Boolean(lead && NOISE_AMBIGUOUS_RE.test(lead[0]))
    || Boolean(trail && NOISE_AMBIGUOUS_RE.test(trail[0]));
  const acceptable = ambiguous ? isPlausibleTitle(rest) : rest.length >= 2;
  return acceptable ? rest : text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isYearLike = (numStr) => {
  if (numStr.length !== 4) return false;
  const n = +numStr;
  return n >= 1900 && n <= CURRENT_YEAR + 1;
};

// ---------------------------------------------------------------------------
// Grupo de release pegado al principio, sin corchetes
// ---------------------------------------------------------------------------

/** Señales de que la cadena es un release (calidad, corchetes, " - 05", "01v2"…). */
const RE_RELEASE_SIGNAL = /(?<![A-Za-z0-9])(?:2160p|1080p|1080i|720p|576p|480p|360p|4K|UHD|FHD|WEB-?DL|WEBRip|BRRip|BD(?:Rip|Remux)|Blu-?Ray|HDTV|HEVC|AVC|x26[45]|10bit|AAC|AC3|EAC3|DTS|FLAC|Opus)(?![A-Za-z0-9])|\[[^\]]{1,80}\]|(?<![A-Za-z0-9])S\d{1,2}E\d{1,3}(?![A-Za-z0-9])|(?<![A-Za-z0-9])\d{1,4}v\d(?![A-Za-z0-9])|\s[-–—]\s*\d{1,4}(?=\s|$|[[(])/i;
/** Palabras que por sí solas no son un título ("Season 2", "Dual Audio"). */
const RE_META_WORDS = /(?<![A-Za-z0-9])(?:Season|Temporada|Episode|Episodio|Cap[ií]tulos?|Cap|Complete|Completa|Completo|Pack|Batch|Dual|Multi(?:ple)?|Subtitles?|Subs?|Audio|Lang(?:uage)?s?|Full)(?![A-Za-z0-9])/gi;
const hasTitleWord = (text) => /[A-Za-z\u00C0-\u024F\u3040-\u9fff]{2}/.test(text.replace(RE_META_WORDS, ' ').replace(/\d+/g, ' '));

/**
 * Índice de nombres de grupo "inequívocos" (con espacio, guion o dígito) por su
 * primera palabra. Los de una sola palabra ("judas", "edge", "sam", "yuri") son
 * también palabras normales de un título y quedan fuera: reconocerlos como
 * prefijo mutilaría "Judas and the Black Messiah", "Edge of Tomorrow" o
 * "Yuri!!! on Ice". El índice hace que el caso normal (primera palabra desconocida)
 * sea un simple fallo de Map, sin recorrer los 128 grupos en cada título.
 */
const BARE_GROUP_BY_FIRST_WORD = (() => {
  const index = new Map();
  for (const key of ANIME_GROUPS.keys()) {
    if (!/[\s\-_0-9]/.test(key)) continue;
    const first = key.split(' ')[0];
    if (!index.has(first)) index.set(first, []);
    index.get(first).push(key);
  }
  for (const list of index.values()) list.sort((a, b) => b.length - a.length);
  return index;
})();

/**
 * Grupo de release pegado al principio SIN corchetes: "Anime Time One Piece
 * 1080p", "Erai-raws - Show 01", "Anime Pahe: Show". Si no hay un separador
 * explícito se exige alguna señal de release (calidad, corchetes, " - 05"…) y
 * que lo que queda tenga pinta de título.
 *
 * @returns {{name: string, profile: object, length: number}|null}
 */
function matchBareLeadingGroup(text) {
  const sp = text.indexOf(' ');
  const first = (sp === -1 ? text : text.slice(0, sp)).toLowerCase();
  const candidates = BARE_GROUP_BY_FIRST_WORD.get(first);
  if (!candidates) return null;
  const lower = text.toLowerCase();
  for (const key of candidates) {
    if (!lower.startsWith(key)) continue;
    const rest = text.slice(key.length);
    const sep = /^(?:\s*[:|–—]\s*|\s+-\s+|\s+)/.exec(rest);
    if (!sep) continue;
    const explicit = /[:|–—]/.test(sep[0]) || /\s-\s/.test(sep[0]);
    if (!explicit && !RE_RELEASE_SIGNAL.test(text)) continue;
    const tail = rest.slice(sep[0].length);
    if (!/^[A-Za-z\u00C0-\u024F\u3040-\u9fff]/.test(tail) || !hasTitleWord(tail)) continue;
    return { name: text.slice(0, key.length), profile: { name: key, ...ANIME_GROUPS.get(key) }, length: key.length + sep[0].length };
  }
  return null;
}

const hasLettersBefore = (text, index) => /[A-Za-z\u00C0-\u024F\u3040-\u9fff]/.test(text.slice(0, index));

/**
 * Versión global cacheada de una RegExp. `parseTitle` se ejecuta sobre cada fila
 * de la tabla y recompilar las mismas decenas de RegExp por llamada era un coste
 * innecesario. El caché es un WeakMap con la propia RegExp como clave: construir
 * la clave (source + flags) y buscarla en un Map costaba ~200 ns por llamada
 * (unas 50 por título), frente a ~10 ns del WeakMap.
 *
 * Al ser compartidas SIEMPRE se resetea `lastIndex` al obtenerlas; los bucles
 * `exec` son síncronos y no anidados sobre la misma regex, así que no hay riesgo
 * de interferencia.
 */
const globalRegexCache = new WeakMap();
function globalRegex(re) {
  let g = globalRegexCache.get(re);
  if (!g) {
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    g = new RegExp(re.source, flags);
    globalRegexCache.set(re, g);
  }
  g.lastIndex = 0;
  return g;
}

/** Ejecuta `re` sobre `text` y devuelve el match más temprano con índice > 0 (o >= 0 si allowZero). */
function firstMatch(re, text, { allowZero = false } = {}) {
  const g = globalRegex(re);
  let m;
  while ((m = g.exec(text)) !== null) {
    if (m.index > 0 || allowZero) return m;
    if (m[0].length === 0) g.lastIndex += 1;
  }
  return null;
}

/** Extrae temporada/episodio de las nomenclaturas con temporada. */
function extractSeasonEpisode(text) {
  for (const pat of EPISODE_PATTERNS) {
    const g = globalRegex(pat.re);
    let m;
    while ((m = g.exec(text)) !== null) {
      if (pat.requireLettersBefore && !hasLettersBefore(text, m.index)) continue;
      const info = pat.map(m);
      // Descartes de seguridad: temporadas > 60 o episodios > 999 no son realistas.
      if (info.season > 60 || info.episode > 999) continue;
      if (pat.kind === 'cap_spanish' && info.episode === 0) continue;
      return { ...info, kind: pat.kind, index: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}

/** Extrae un episodio absoluto (sin temporada). `from` permite buscar sólo tras cierto índice. */
function extractAbsoluteEpisode(text, from = 0) {
  const slice = text.slice(from);
  let best = null;
  for (const pat of ABSOLUTE_PATTERNS) {
    const g = globalRegex(pat.re);
    let m;
    while ((m = g.exec(slice)) !== null) {
      const num = m[1];
      if (isYearLike(num)) continue; // "Show - 2019" es un año, no un episodio
      const candidate = { episode: +num, kind: pat.kind, bareE: /^E\d/i.test(m[0]), index: from + m.index, end: from + m.index + m[0].length };
      if (!best || candidate.index < best.index) best = candidate;
      break; // primer match de este patrón; comparamos entre patrones por posición
    }
  }
  return best;
}

/** Extrae temporada (packs o "2nd Season"). */
function extractSeasonOnly(text) {
  let best = null;
  for (const pat of SEASON_PATTERNS) {
    const m = firstMatch(pat.re, text, { allowZero: true });
    if (!m) continue;
    const season = +m[1];
    const seasonEnd = m[2] ? +m[2] : null;
    if (season > 60) continue;
    const candidate = { season, seasonEnd, kind: pat.kind, index: m.index, end: m.index + m[0].length };
    if (!best || candidate.index < best.index) best = candidate;
  }
  return best;
}

/** Selecciona el año: prioriza (2019)/[2019]; si no, el último año que no esté al inicio. */
function extractYear(full, stripped) {
  const bracketed = RE_YEAR_BRACKETED.exec(full);
  if (bracketed) return { year: +bracketed[1], index: null };
  let last = null;
  for (const m of stripped.matchAll(RE_YEAR_GLOBAL)) {
    if (m.index === 0) continue;
    if (+m[1] > CURRENT_YEAR + 1) continue;
    last = { year: +m[1], index: m.index };
  }
  if (last) return last;
  // Año al inicio y nada más ("2012 1080p") → lo aceptamos como año sólo si hay otro token detrás.
  const lead = /^((?:19|20)\d{2})(?![\dp]|x\d)/.exec(stripped);
  if (lead && /\d{3,4}p|bluray|web|hdtv|x26[45]|hevc/i.test(stripped)) return { year: +lead[1], index: -1 };
  return null;
}

function groupIndex(m, names) {
  for (let i = 1; i < m.length; i += 1) if (m[i]) return names[i - 1];
  return null;
}

/**
 * ¿Este match es metadato de release y no parte del título?
 * "COMPLETE" / "EXTENDED" en mayúsculas (scene) sí; "A Complete Unknown" o
 * "The Extended Cut" no. Las frases ("Temporada Completa", "Director's Cut") sí.
 */
const ALWAYS_METADATA_TAG = /^(?:repack|proper|rerip|internal|remastered|uncensored|hardsub(?:bed)?|softsub(?:bed)?|dubbed|subbed|hc|director'?s?(?:[ ._-]cut)?|theatrical(?:[ ._-]cut)?|batch|intégrale|integrale)$/i;
const PHRASE_METADATA = /(?:temporada|serie|season|series|batch|full|intégrale|integrale)/i;

function matchIsMetadataTag(text, match) {
  const raw = match[0];
  const word = match[1] || raw;
  if (ALWAYS_METADATA_TAG.test(word) || ALWAYS_METADATA_TAG.test(raw)) return true;
  if (PHRASE_METADATA.test(raw) && raw.length > 8) return true;
  if (raw === raw.toUpperCase() && /[A-Z]/.test(raw)) return true;
  const after = text.slice(match.index + raw.length);
  // El separador puede ser espacio o punto scene ("Complete.1080p", "EXTENDED.1080p").
  return /^[ ._-]*(?:\d{3,4}p\b|bluray|brrip|web-?dl|webrip|web\b|hdtv|x26[45]|hevc|h\.?26[45])/i.test(after);
}

function replaceMetadataTags(text, re) {
  const g = globalRegex(re);
  return text.replace(g, (m, ...rest) => {
    const index = rest[rest.length - 2];
    const groups = rest.slice(0, -2);
    const fake = [m, ...groups];
    fake.index = index;
    return matchIsMetadataTag(text, fake) ? ' ' : m;
  });
}

/** Quita "Extended Cut" / "Director's Cut" finales sólo si queda título de verdad. */
function stripTrailingEdition(t) {
  const next = t.replace(/(?:\s+(?:extended|director'?s|theatrical|final|unrated)\s+cut|\s+remastered|\s+imax)+$/i, '').trim();
  if (!next || next === t) return t;
  if (next.length >= 8 || next.split(/\s+/).filter(Boolean).length >= 2) return next;
  return t;
}

/** Post-procesado del título limpio. */
function polishTitle(raw) {
  let t = raw;
  t = t.replace(RE_SITE_PREFIX, '');
  t = t.replace(/\bAKA\b.*$/, ''); // "Título AKA Otro título" → nos quedamos con el primero
  t = t.replace(/_/g, ' ');
  // Nomenclatura scene: si no hay espacios y hay puntos entre palabras (no siglas tipo S.W.A.T.), los puntos separan palabras.
  if (!/\s/.test(t.trim()) && /[A-Za-z0-9]{2}\.[A-Za-z0-9]/.test(t)) t = t.replace(/\./g, ' ');
  // Puntos sueltos entre palabras ("Movie.Name 2019") → espacio, respetando siglas (S.W.A.T.) y "Mr."
  t = t.replace(/(?<=[a-z0-9]{2})\.(?=[A-Za-z0-9])/g, ' ');
  t = t.replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, ' ');
  // Ruido de webs sólo en los extremos ("Descargar Pelicula X", "X Torrent"); si
  // vaciase o mutilase el título ("Mi Pelicula" → "Mi"), se conserva el original.
  t = stripEdgeNoise(t);
  t = stripTrailingLanguage(t);
  t = t.replace(/^(?:2160p|1080p|1080i|720p|576p|480p|360p|4k|uhd|fhd|3840x2160|1920x1080|1280x720)[ ._-]+/i, '');
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/^[\s\-–—_.:,;!?)\]}]+|[\s\-–—_.:,;([{]+$/g, '');
  t = t.replace(/\s+([,;:!?])/g, '$1');
  // Un título terminado en " -" o "- " residual
  t = t.replace(/\s[-–—]\s*$/, '').trim();
  t = stripTrailingEdition(t);
  return t;
}

/** Título de respaldo: elimina todos los tokens de metadatos en lugar de cortar. */
function fallbackTitle(stripped) {
  let t = stripped;
  const removers = [
    ...EPISODE_PATTERNS.map((p) => p.re),
    ...SEASON_PATTERNS.map((p) => p.re),
    RE_QUALITY, RE_SOURCE, RE_SOURCE_CS, RE_CODEC, RE_AUDIO_CODEC, RE_CHANNELS, RE_HDR, RE_BIT_DEPTH,
    RE_COMPLETE, RE_FLAGS, RE_ANIME_EXTRA, RE_DUAL_MULTI, RE_LANG_CUT, RE_YEAR_GLOBAL,
  ];
  for (const re of removers) {
    if (re === RE_COMPLETE || re === RE_FLAGS) {
      t = replaceMetadataTags(t, re);
      continue;
    }
    t = t.replace(globalRegex(re), ' ');
  }
  return polishTitle(t);
}

// ---------------------------------------------------------------------------
// API principal
// ---------------------------------------------------------------------------

/**
 * Analiza un título de torrent.
 * @param {string} rawTitle
 * @returns {ParsedTitle}
 */
export function parseTitle(rawTitle) {
  const raw = String(rawTitle ?? '').trim();

  /** @type {ParsedTitle} */
  const result = {
    raw,
    cleanTitle: '',
    searchKey: '',
    type: 'movie',
    typeConfidence: 0.3,
    isAnime: false,
    season: null,
    seasonEnd: null,
    episode: null,
    episodeEnd: null,
    absoluteEpisode: null,
    isSeasonPack: false,
    isComplete: false,
    year: null,
    quality: null,
    source: null,
    codec: null,
    audioCodec: null,
    channels: null,
    container: null,
    hdr: null,
    bitDepth: null,
    releaseGroup: null,
    releaseGroupProfile: null,
    languages: { audio: [], subtitles: [], dual: false, multiSubs: false, original: false },
    flags: [],
    hasCrc: false,
  };
  if (!raw) return result;

  // --- 1. Preprocesado --------------------------------------------------------
  let full = raw.replace(/\.torrent$/i, '');
  const ext = RE_EXTENSION.exec(full);
  if (ext) {
    result.container = ext[1].toLowerCase();
    full = full.slice(0, ext.index);
  }
  full = full.replace(RE_SITE_PREFIX, '');

  if (RE_CRC.test(full)) {
    result.hasCrc = true;
    full = full.replace(RE_CRC, ' ');
  }

  const leadGroup = RE_LEADING_GROUP.exec(full);
  if (leadGroup) {
    result.releaseGroup = leadGroup[1].trim();
    result.releaseGroupProfile = lookupAnimeGroup(result.releaseGroup);
    full = full.slice(leadGroup.index + leadGroup[0].length);
  }
  full = full.replace(/\s+/g, ' ').trim();

  // Mismo grupo, pero sin corchetes: "Anime Time One Piece 1080p".
  if (!result.releaseGroup) {
    const bare = matchBareLeadingGroup(full);
    if (bare) {
      result.releaseGroup = bare.name;
      result.releaseGroupProfile = bare.profile;
      full = full.slice(bare.length).trim();
    }
  }

  // Contenido de todos los grupos [] () {} (metadatos) y vista sin ellos para localizar el título.
  const bracketContents = [...full.matchAll(RE_BRACKET_GROUPS)].map((m) => m[0].slice(1, -1).trim());
  const stripped = full.replace(RE_BRACKET_GROUPS, ' ').replace(/\s+/g, ' ').trim();

  // Grupo de anime en cualquier posición: "Attack on Titan S04E28 [Judas]"
  if (!result.releaseGroupProfile) {
    for (const content of bracketContents) {
      const profile = lookupAnimeGroup(content);
      if (profile) {
        result.releaseGroup = result.releaseGroup || content;
        result.releaseGroupProfile = profile;
        break;
      }
    }
  }

  // --- 2. Temporada / episodio ------------------------------------------------
  const cutCandidates = []; // índices de corte en `stripped`
  let leadingSkip = 0; // "Cap.209 Título" empieza por el marcador: se quita, no se usa como corte
  const noteLeading = (info) => {
    if (info && info.index === 0 && info.end > leadingSkip) leadingSkip = info.end;
  };

  const se = extractSeasonEpisode(full);
  const seStripped = extractSeasonEpisode(stripped);
  if (se) {
    result.season = se.season;
    result.episode = se.episode;
    result.episodeEnd = se.episodeEnd;
  }
  if (seStripped && seStripped.index > 0) cutCandidates.push(seStripped.index);
  else noteLeading(seStripped);

  const seasonOnly = extractSeasonOnly(full);
  const seasonOnlyStripped = extractSeasonOnly(stripped);
  if (seasonOnly && result.season === null) {
    result.season = seasonOnly.season;
    result.seasonEnd = seasonOnly.seasonEnd;
  }
  if (seasonOnlyStripped && seasonOnlyStripped.index > 0) cutCandidates.push(seasonOnlyStripped.index);
  else noteLeading(seasonOnlyStripped);

  // Episodio absoluto: cuando no hay SxxEyy, o como complemento ("S04E28 - 87").
  const absFrom = se ? se.end : 0;
  const abs = extractAbsoluteEpisode(full, absFrom);
  if (abs) {
    if (result.episode === null) {
      result.episode = abs.episode;
      // Sin temporada explícita → es un episodio absoluto.
      if (result.season === null) result.absoluteEpisode = abs.episode;
    } else if (abs.episode !== result.episode && !abs.bareE) {
      // "S04E28 - 87" / "S04E28 Episode 87": el segundo número es el absoluto.
      result.absoluteEpisode = abs.episode;
    }
  }
  const absStripped = extractAbsoluteEpisode(stripped, seStripped ? seStripped.end : 0);
  if (absStripped && absStripped.index > 0) cutCandidates.push(absStripped.index);

  const completeTag = (() => {
    const g = globalRegex(RE_COMPLETE);
    let m;
    while ((m = g.exec(full)) !== null) {
      if (matchIsMetadataTag(full, m)) return m;
      if (m[0].length === 0) g.lastIndex += 1;
    }
    return null;
  })();
  if (completeTag) {
    result.isComplete = true;
    result.flags.push('complete');
  }
  if (result.season !== null && result.episode === null) result.isSeasonPack = true;

  // --- 3. Año -----------------------------------------------------------------
  const year = extractYear(full, stripped);
  if (year) {
    result.year = year.year;
    if (year.index !== null && year.index > 0) cutCandidates.push(year.index);
  }

  // --- 4. Metadatos técnicos --------------------------------------------------
  const q = RE_QUALITY.exec(full);
  if (q) {
    const key = q[1].toLowerCase();
    result.quality = QUALITY_MAP[key] || key;
  }

  const src = RE_SOURCE.exec(full) || RE_SOURCE_CS.exec(full);
  if (src) result.source = SOURCE_MAP[src[1].toLowerCase().replace(/\s/g, '')] || src[1].toLowerCase();

  const codec = RE_CODEC.exec(full);
  if (codec) result.codec = groupIndex(codec, CODEC_NAMES);

  const ac = RE_AUDIO_CODEC.exec(full);
  if (ac) result.audioCodec = groupIndex(ac, AUDIO_CODEC_NAMES);
  const ch = RE_CHANNELS.exec(full);
  if (ch) result.channels = ch[1];

  const hdr = RE_HDR.exec(full);
  if (hdr) {
    const h = hdr[1].toLowerCase().replace(/[ .]/g, '');
    result.hdr = h === 'dv' || h === 'dovi' || h === 'dolbyvision' ? 'dv' : h === 'hdr10plus' ? 'hdr10+' : h;
    // Un título puede llevar DV y HDR10 a la vez → nos quedamos con dv (más restrictivo)
    if (/(?<![A-Za-z0-9])(DV|DoVi|Dolby[ .]?Vision)(?![A-Za-z0-9])/.test(full)) result.hdr = 'dv';
  }

  const bd = RE_BIT_DEPTH.exec(full);
  if (bd) result.bitDepth = bd[1] ? +bd[1] : 10;

  for (const m of full.matchAll(globalRegex(RE_FLAGS))) {
    if (matchIsMetadataTag(full, m)) result.flags.push(m[1].toLowerCase());
  }
  const dualMulti = RE_DUAL_MULTI.exec(full);
  if (dualMulti) result.flags.push(dualMulti[1].toLowerCase().replace(/[ ._-]/g, ''));
  result.flags = [...new Set(result.flags)];

  // --- 5. Título limpio -------------------------------------------------------
  for (const re of [RE_QUALITY, RE_SOURCE, RE_SOURCE_CS, RE_CODEC, RE_AUDIO_CODEC, RE_CHANNELS, RE_HDR, RE_BIT_DEPTH, RE_ANIME_EXTRA, RE_DUAL_MULTI, RE_LANG_CUT]) {
    const m = firstMatch(re, stripped);
    if (m) cutCandidates.push(m.index);
  }
  for (const re of [RE_COMPLETE, RE_FLAGS]) {
    const g = globalRegex(re);
    let m;
    while ((m = g.exec(stripped)) !== null) {
      if (m.index > 0 && matchIsMetadataTag(stripped, m)) cutCandidates.push(m.index);
      if (m[0].length === 0) g.lastIndex += 1;
    }
  }

  let titleRaw;
  const cuts = cutCandidates.filter((i) => i > leadingSkip);
  if (cuts.length) {
    titleRaw = stripped.slice(leadingSkip, Math.min(...cuts));
  } else {
    // Sin ningún token: quitamos un posible grupo scene final ("Movie Name-GROUP") sólo si hay guion sin espacios
    titleRaw = stripped.slice(leadingSkip).replace(/(?<=\S)-[A-Za-z0-9]{2,12}$/, '');
  }

  // Número suelto al final de la zona de título ("Naruto Shippuden 297", "Show 09") → episodio absoluto.
  // Sólo con cero inicial o >= 100 (y < 1900) para no romper "Apollo 13", "District 9" o "Blade Runner 2049".
  if (result.episode === null && !result.isSeasonPack && result.year === null) {
    const trailing = /(?<=[A-Za-z\u00C0-\u024F)\]!?])[ ._]+(0\d{1,3}|[1-9]\d{2}|1[0-8]\d{2})(?:v\d)?\s*$/.exec(titleRaw);
    if (trailing) {
      result.episode = +trailing[1];
      result.absoluteEpisode = +trailing[1];
      titleRaw = titleRaw.slice(0, trailing.index);
      result.flags.push('trailing-number-episode');
    }
  }

  let title = polishTitle(titleRaw);
  if (title.length < 2) title = fallbackTitle(stripped);
  if (title.length < 2 && result.releaseGroup && !result.releaseGroupProfile) title = polishTitle(result.releaseGroup); // "[Título del anime]" sin más
  result.cleanTitle = title;
  result.searchKey = normalizeKey(title);

  // --- 6. Idiomas -------------------------------------------------------------
  // Se analiza SÓLO la zona de metadatos (todo lo que no es el título) para no
  // confundir "The English Patient" o "Spanish Affair" con pistas de idioma.
  const titleZone = titleRaw.trim();
  const metaText = titleZone && full.startsWith(titleZone)
    ? full.slice(titleZone.length)
    : `${bracketContents.join(' ')} ${cutCandidates.length ? stripped.slice(Math.min(...cutCandidates)) : ''}`;
  result.languages = detectTitleLanguages(metaText, result.releaseGroupProfile);

  // --- 7. Tipo ----------------------------------------------------------------
  let animeScore = 0;
  if (result.releaseGroupProfile) animeScore += 60;
  else if (result.releaseGroup && (abs || result.hasCrc)) animeScore += 25;
  if (result.hasCrc) animeScore += 25;
  if (abs && abs.kind === 'dash' && !se) animeScore += 30;
  if (/\(\s*(?:2160p|1080p|720p|480p)\s*\)/i.test(full)) animeScore += 10; // "(1080p)" estilo fansub
  if (abs && ['cjk', 'hash', 'bracket'].includes(abs.kind)) animeScore += 15;
  if (RE_JAPANESE.test(raw)) animeScore += 35;
  if (RE_ANIME_EXTRA.test(full)) animeScore += 20;
  if (/(?:^|[^A-Za-z0-9])\d{1,4}v\d(?![A-Za-z0-9])/i.test(full)) animeScore += 25; // "01v2" es de fansub
  if (result.bitDepth === 10) animeScore += 5;
  if (result.languages.audio.includes('japanese')) animeScore += 15;
  if (/(?<![A-Za-z])(?:no|wo|ga|ni|to|wa)(?![A-Za-z])/.test(title) && /[A-Za-z]/.test(title)) animeScore += 10; // partículas romaji
  if (/(?<![A-Za-z])(?:shippuden|kaisen|slayer|hero academia|isekai|senpai|sensei|shoujo|shounen|gakuen|monogatari|densetsu|no kyoujin)(?![A-Za-z])/i.test(title)) animeScore += 15;
  if (result.episode !== null && result.season === null && result.episode > 60) animeScore += 15; // episodios altos → absolutos

  const hasEpisodeInfo = result.episode !== null || result.season !== null || result.isSeasonPack;

  if (animeScore >= 40) {
    result.type = 'anime';
    result.isAnime = true;
    result.typeConfidence = Math.min(1, 0.5 + animeScore / 200);
  } else if (hasEpisodeInfo) {
    result.type = 'series';
    result.typeConfidence = se ? 0.9 : abs ? 0.7 : 0.75;
  } else {
    result.type = 'movie';
    result.typeConfidence = result.year ? 0.8 : 0.5;
  }

  // Para anime: un episodio sin temporada explícita es un episodio absoluto.
  if (result.isAnime && result.episode !== null && result.season === null) {
    result.absoluteEpisode = result.episode;
  }

  return result;
}

/**
 * Variantes de título para consultar APIs (de más específica a más genérica).
 * Para anime con temporada > 1 se prueba "Título 2nd Season" antes que "Título".
 *
 * @param {object} parsed
 * @param {{ onlySeason?: boolean }} [opts] `onlySeason`: devolver SÓLO las
 *   variantes que identifican la temporada. Necesario en APIs con ficha **por
 *   temporada** (AniList, Kitsu, MAL): preguntar por el título pelado en una obra
 *   de temporada 2 devuelve la ficha de la temporada 1 (título idéntico, año sin
 *   penalización suficiente) y el ID equivocado acaba en la BD —y en la
 *   deduplicación, que agrupa por ese ID—. TMDB no lo usa porque su `tmdb_id` es
 *   por SERIE y ahí el título pelado es justo el acierto correcto.
 *   Si no hay variantes de temporada, se devuelve la lista normal (nunca vacía).
 */
export function buildSearchVariants(parsed, { onlySeason = false } = {}) {
  const variants = [];
  const t = parsed.cleanTitle;
  if (!t) return variants;
  // Con `onlySeason` no miramos `isAnime`: quien pide variantes de temporada es
  // AniList/Kitsu (sólo se usan con obras de tipo anime) y el parser no siempre
  // marca `isAnime` en un título de temporada sin tag de fansub ("Show Season 2").
  const seasonal = [];
  if (parsed.season && parsed.season > 1 && (onlySeason || parsed.isAnime)) {
    const ord = ['', '', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th'][parsed.season] || `${parsed.season}th`;
    seasonal.push(`${t} ${ord} Season`);
    seasonal.push(`${t} Season ${parsed.season}`);
    seasonal.push(`${t} ${parsed.season}`);
  }
  if (onlySeason && seasonal.length) return [...new Set(seasonal)];
  variants.push(...seasonal);
  variants.push(t);
  // Sin subtítulo tras ":" o " - " (p. ej. "Frieren: Beyond Journey's End" → "Frieren")
  const short = t.split(/\s[:\-–—]\s|:\s/)[0].trim();
  if (short && short !== t && short.length >= 3) variants.push(short);
  return [...new Set(variants)];
}

/**
 * @typedef {object} ParsedTitle
 * @property {string} raw
 * @property {string} cleanTitle
 * @property {string} searchKey
 * @property {'anime'|'series'|'movie'} type
 * @property {number} typeConfidence
 * @property {boolean} isAnime
 * @property {number|null} season
 * @property {number|null} seasonEnd
 * @property {number|null} episode
 * @property {number|null} episodeEnd
 * @property {number|null} absoluteEpisode
 * @property {boolean} isSeasonPack
 * @property {boolean} isComplete
 * @property {number|null} year
 * @property {string|null} quality
 * @property {string|null} source
 * @property {string|null} codec
 * @property {string|null} audioCodec
 * @property {string|null} channels
 * @property {string|null} container
 * @property {string|null} hdr
 * @property {number|null} bitDepth
 * @property {string|null} releaseGroup
 * @property {object|null} releaseGroupProfile
 * @property {{audio: string[], subtitles: string[], dual: boolean, multiSubs: boolean, original: boolean}} languages
 * @property {string[]} flags
 * @property {boolean} hasCrc
 */
