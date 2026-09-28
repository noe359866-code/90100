/**
 * Normalizador de idiomas.
 *
 *  - `normalizeLanguageArray(arr)`  → limpia arrays `audio` / `subtitles`
 *  - `detectTitleLanguages(title)`  → infiere audio/subtítulos a partir del título
 *  - `classifyLanguage(...)`        → clasifica en grupos 'spanish' / 'english' para la deduplicación
 *
 * Etiquetas canónicas (minúsculas): spanish (castellano), latino, english,
 * japanese, french, german, italian, portuguese, russian, korean, chinese,
 * hindi, arabic, catalan, basque, galician, turkish, polish, dutch, swedish,
 * danish, norwegian, finnish, thai, vietnamese, indonesian, hebrew, greek,
 * czech, hungarian, romanian, ukrainian, filipino.
 */

/**
 * Reglas por idioma.
 *  - words:  regex (case-insensitive) para palabras completas en texto libre
 *  - codes:  códigos cortos que sólo se aceptan en MAYÚSCULAS dentro de un título
 *            (evita falsos positivos como "cast" en "Cast Away")
 *  - tokens: tokens exactos (minúsculas) aceptados dentro de los arrays audio/subtitles
 *
 * El orden importa: `latino` debe evaluarse antes que `spanish`.
 */
const RULES = [
  {
    lang: 'latino',
    words: /(?<![a-z])(?:latino|latina|latam|latin(?:o|a)?[ ._-]?(?:am[eé]rica|americano|american|spanish)|espa[ñn]ol[ ._-]?(?:latino|lat|mx|mexicano|neutro)|spanish[ ._-]?(?:latin|latino|la|mx)|es[-_]?(?:419|la|mx|lat|ar|cl|co|pe|ve|xl)|spa[-_ ]?(?:la|lat|419)|castellano[ ._-]?latino|audio[ ._-]?latino)(?![a-z])/i,
    codes: ['LAT', 'LATAM', 'SPA-LA', 'SPA-LAT', 'ES-LA', 'ES-MX', 'ES-419'],
    tokens: ['lat', 'latino', 'latina', 'latam', 'es-419', 'es_419', 'es419', 'es-la', 'es_la', 'esla', 'es-mx', 'es_mx', 'esmx', 'spa-la', 'spa-lat', 'spa_la', 'es-ar', 'es-cl', 'es-co', 'es-pe', 'es-ve', 'es-xl', 'spanish (latin america)', 'spanish latin america', 'latin spanish', 'latin american spanish', 'español latino', 'espanol latino'],
  },
  {
    lang: 'spanish',
    words: /(?<![a-z])(?:castellano|castilian|espa[ñn]ol(?:[ ._-]?(?:espa[ñn]a|castellano|europeo))?|spanish(?:[ ._-]?(?:spain|europe(?:an)?|castilian))?|es[-_]es|spa[-_]es|audio[ ._-]?(?:espa[ñn]ol|castellano))(?![a-z])/i,
    codes: ['SPA', 'ESP', 'CAST', 'CAS', 'SPA-ES', 'ES-ES'],
    tokens: ['es', 'spa', 'esp', 'cast', 'cas', 'es-es', 'es_es', 'eses', 'spa-es', 'spanish', 'español', 'espanol', 'castellano', 'castilian', 'spanish (spain)', 'spanish spain', 'european spanish', 'spanish (castilian)'],
  },
  {
    lang: 'english',
    words: /(?<![a-z])(?:english|ingl[eé]s|inglese|anglais|englisch|audio[ ._-]?(?:english|ingl[eé]s))(?![a-z])/i,
    codes: ['ENG', 'EN-US', 'EN-GB'],
    tokens: ['en', 'eng', 'english', 'en-us', 'en_us', 'en-gb', 'en_gb', 'enus', 'engb', 'ingles', 'inglés', 'inglese'],
  },
  {
    lang: 'japanese',
    words: /(?<![a-z])(?:japanese|japon[eé]s|japon[eê]s|nihongo|giapponese|japonais)(?![a-z])/i,
    codes: ['JAP', 'JPN', 'JA-JP'],
    tokens: ['ja', 'jp', 'jpn', 'jap', 'ja-jp', 'ja_jp', 'japanese', 'japones', 'japonés', 'japonês'],
  },
  {
    lang: 'french',
    words: /(?<![a-z])(?:french|franc[eé]s|fran[cç]ais|truefrench|vff|vfq|vfi|vf2)(?![a-z])/i,
    codes: ['FRE', 'FRA', 'VF', 'VFF', 'VFQ', 'FR-FR', 'FR-CA'],
    tokens: ['fr', 'fre', 'fra', 'fr-fr', 'fr-ca', 'french', 'frances', 'francés', 'français', 'francais', 'vff', 'vfq', 'vf', 'truefrench'],
  },
  {
    lang: 'german',
    words: /(?<![a-z])(?:german|alem[aá]n|deutsch)(?![a-z])/i,
    codes: ['GER', 'DEU', 'DE-DE'],
    tokens: ['de', 'ger', 'deu', 'de-de', 'german', 'aleman', 'alemán', 'deutsch'],
  },
  {
    lang: 'italian',
    words: /(?<![a-z])(?:italian|italiano)(?![a-z])/i,
    codes: ['ITA', 'IT-IT'],
    tokens: ['it', 'ita', 'it-it', 'italian', 'italiano'],
  },
  {
    lang: 'portuguese',
    words: /(?<![a-z])(?:portuguese|portugu[eê]s|brazilian|brasileiro|pt[-_]?(?:br|pt)|dublado|legendado)(?![a-z])/i,
    codes: ['POR', 'PTB', 'POR-BR', 'PT-BR', 'PT-PT'],
    tokens: ['pt', 'por', 'ptb', 'pt-br', 'pt_br', 'ptbr', 'pt-pt', 'pt_pt', 'ptpt', 'portuguese', 'portugues', 'português', 'brazilian', 'brasileiro', 'brazilian portuguese', 'portuguese (brazil)'],
  },
  {
    lang: 'russian',
    words: /(?<![a-z])(?:russian|ruso|русский)(?![a-z])/i,
    codes: ['RUS'],
    tokens: ['ru', 'rus', 'ru-ru', 'russian', 'ruso'],
  },
  {
    lang: 'korean',
    words: /(?<![a-z])(?:korean|coreano)(?![a-z])/i,
    codes: ['KOR'],
    tokens: ['ko', 'kor', 'ko-kr', 'korean', 'coreano'],
  },
  {
    lang: 'chinese',
    words: /(?<![a-z])(?:chinese|chino|mandarin|mandar[ií]n|cantonese|canton[eé]s)(?![a-z])/i,
    codes: ['CHI', 'ZHO', 'CHS', 'CHT', 'ZH-CN', 'ZH-TW', 'ZH-HK'],
    tokens: ['zh', 'chi', 'zho', 'chs', 'cht', 'zh-cn', 'zh-tw', 'zh-hk', 'zh-hans', 'zh-hant', 'chinese', 'chino', 'mandarin', 'cantonese'],
  },
  {
    lang: 'hindi',
    words: /(?<![a-z])(?:hindi)(?![a-z])/i,
    codes: ['HIN'],
    tokens: ['hi', 'hin', 'hindi'],
  },
  {
    lang: 'arabic',
    words: /(?<![a-z])(?:arabic|[aá]rabe)(?![a-z])/i,
    codes: ['ARA'],
    tokens: ['ar', 'ara', 'arabic', 'arabe', 'árabe'],
  },
  {
    lang: 'catalan',
    words: /(?<![a-z])(?:catal[aà]n?|valenci[aà])(?![a-z])/i,
    codes: ['CAT'],
    tokens: ['ca', 'cat', 'catalan', 'català', 'catalán', 'valencia', 'valencià'],
  },
  {
    lang: 'basque',
    words: /(?<![a-z])(?:euskera|euskara|basque|vasco)(?![a-z])/i,
    codes: ['EUS', 'BAQ'],
    tokens: ['eu', 'eus', 'baq', 'euskera', 'euskara', 'basque', 'vasco'],
  },
  {
    lang: 'galician',
    words: /(?<![a-z])(?:gallego|galego|galician)(?![a-z])/i,
    codes: ['GLG'],
    tokens: ['gl', 'glg', 'gallego', 'galego', 'galician'],
  },
  {
    lang: 'turkish',
    words: /(?<![a-z])(?:turkish|turco|türkçe)(?![a-z])/i,
    codes: ['TUR'],
    tokens: ['tr', 'tur', 'turkish', 'turco'],
  },
  {
    lang: 'polish',
    words: /(?<![a-z])(?:polish|polaco|polski)(?![a-z])/i,
    codes: ['POL'],
    tokens: ['pl', 'pol', 'polish', 'polaco', 'polski'],
  },
  {
    lang: 'dutch',
    words: /(?<![a-z])(?:dutch|holand[eé]s|nederlands|neerland[eé]s)(?![a-z])/i,
    codes: ['DUT', 'NLD'],
    tokens: ['nl', 'dut', 'nld', 'dutch', 'holandes', 'holandés', 'nederlands'],
  },
  {
    lang: 'swedish',
    words: /(?<![a-z])(?:swedish|sueco|svenska)(?![a-z])/i,
    codes: ['SWE'],
    tokens: ['sv', 'swe', 'swedish', 'sueco'],
  },
  {
    lang: 'danish',
    words: /(?<![a-z])(?:danish|dan[eé]s|dansk)(?![a-z])/i,
    codes: ['DAN'],
    tokens: ['da', 'dan', 'danish', 'danes', 'danés'],
  },
  {
    lang: 'norwegian',
    words: /(?<![a-z])(?:norwegian|noruego|norsk)(?![a-z])/i,
    codes: ['NOR'],
    tokens: ['no', 'nor', 'nob', 'norwegian', 'noruego'],
  },
  {
    lang: 'finnish',
    words: /(?<![a-z])(?:finnish|finland[eé]s|suomi)(?![a-z])/i,
    codes: [],
    tokens: ['fi', 'fin', 'finnish', 'finlandes', 'finlandés'],
  },
  {
    lang: 'thai',
    words: /(?<![a-z])(?:thai|tailand[eé]s)(?![a-z])/i,
    codes: ['THA'],
    tokens: ['th', 'tha', 'thai', 'tailandes', 'tailandés'],
  },
  {
    lang: 'vietnamese',
    words: /(?<![a-z])(?:vietnamese|vietnamita)(?![a-z])/i,
    codes: ['VIE'],
    tokens: ['vi', 'vie', 'vietnamese', 'vietnamita'],
  },
  {
    lang: 'indonesian',
    words: /(?<![a-z])(?:indonesian|indonesio|bahasa)(?![a-z])/i,
    codes: ['IND'],
    tokens: ['id', 'ind', 'indonesian', 'indonesio'],
  },
  {
    lang: 'hebrew',
    words: /(?<![a-z])(?:hebrew|hebreo)(?![a-z])/i,
    codes: ['HEB'],
    tokens: ['he', 'heb', 'hebrew', 'hebreo'],
  },
  {
    lang: 'greek',
    words: /(?<![a-z])(?:greek|griego)(?![a-z])/i,
    codes: ['GRE', 'ELL'],
    tokens: ['el', 'gre', 'ell', 'greek', 'griego'],
  },
  {
    lang: 'czech',
    words: /(?<![a-z])(?:czech|checo)(?![a-z])/i,
    codes: ['CZE', 'CES'],
    tokens: ['cs', 'cze', 'ces', 'czech', 'checo'],
  },
  {
    lang: 'hungarian',
    words: /(?<![a-z])(?:hungarian|h[uú]ngaro|magyar)(?![a-z])/i,
    codes: ['HUN'],
    tokens: ['hu', 'hun', 'hungarian', 'hungaro', 'húngaro'],
  },
  {
    lang: 'romanian',
    words: /(?<![a-z])(?:romanian|rumano)(?![a-z])/i,
    codes: ['RUM', 'RON'],
    tokens: ['ro', 'rum', 'ron', 'romanian', 'rumano'],
  },
  {
    lang: 'ukrainian',
    words: /(?<![a-z])(?:ukrainian|ucraniano)(?![a-z])/i,
    codes: ['UKR'],
    tokens: ['uk', 'ukr', 'ukrainian', 'ucraniano'],
  },
  {
    lang: 'filipino',
    words: /(?<![a-z])(?:filipino|tagalog)(?![a-z])/i,
    codes: ['FIL', 'TGL'],
    tokens: ['tl', 'fil', 'tgl', 'filipino', 'tagalog'],
  },
];

// Índice rápido token → idioma (para arrays).
const TOKEN_INDEX = new Map();
for (const rule of RULES) {
  for (const t of rule.tokens) if (t) TOKEN_INDEX.set(t, rule.lang);
}

// Regex de códigos en mayúsculas (case-sensitive) por idioma, para títulos.
const CODE_REGEX = RULES.map((rule) => ({
  lang: rule.lang,
  re: rule.codes.length
    ? new RegExp(`(?<![A-Za-z0-9])(?:${rule.codes.map((c) => c.replace(/[-]/g, '[-_]')).join('|')})(?![A-Za-z0-9])`)
    : null,
}));

// Versiones GLOBALES precompiladas: la detección corre sobre cada título de la
// tabla y recompilar docenas de RegExp por llamada era el cuello de botella.
// OJO: al ser compartidas hay que resetear `lastIndex` antes de cada uso.
const WORDS_G = RULES.map((rule) => new RegExp(rule.words.source, rule.words.flags.includes('g') ? rule.words.flags : `${rule.words.flags}g`));
const CODES_G = CODE_REGEX.map((c) => (c.re ? new RegExp(c.re.source, 'g') : null));

export const CANONICAL_LANGUAGES = RULES.map((r) => r.lang);

/** Grupo "spanish" de la deduplicación: castellano + latino. */
export const SPANISH_GROUP = new Set(['spanish', 'latino']);
/** Grupo "english" de la deduplicación. */
export const ENGLISH_GROUP = new Set(['english']);

const uniqueSorted = (arr) => [...new Set(arr)].sort();

/**
 * Detecta idiomas en un texto libre (una entrada de array o un título).
 * @param {string} text
 * @param {{ allowCodes?: boolean }} opts allowCodes: aceptar códigos MAYÚSCULAS (títulos)
 */
export function detectLanguagesInText(text, { allowCodes = true } = {}) {
  if (!text) return [];
  const found = new Set();
  // Las reglas se evalúan en orden y cada coincidencia se "consume" (se borra del
  // texto de trabajo) para que una regla más específica evaluada antes ("SPA-LA",
  // "Español Latino") no dispare también la genérica ("SPA", "Español").
  let work = String(text);
  const consume = (g) => {
    g.lastIndex = 0; // regex compartida: siempre desde el principio
    // OJO: `replace` con callback es más lento que `test` cuando (como aquí) la
    // mayoría de las 40 reglas no coinciden; medido 2,7× peor con una sola pasada.
    if (!g.test(work)) return false;
    work = work.replace(g, (m) => ' '.repeat(m.length));
    return true;
  };
  for (let i = 0; i < RULES.length; i += 1) {
    let hit = consume(WORDS_G[i]);
    if (allowCodes && CODES_G[i]) hit = consume(CODES_G[i]) || hit;
    if (hit) found.add(RULES[i].lang);
  }
  return uniqueSorted([...found]);
}

/**
 * Normaliza una entrada individual de un array de idiomas.
 * "Spanish (Latin America)" → ['latino'], "AC3 5.1" → [], "es" → ['spanish']
 */
function normalizeLanguageEntry(entry) {
  if (entry === null || entry === undefined) return [];
  const raw = String(entry).trim().toLowerCase();
  if (!raw) return [];

  // 1) Token exacto ("es", "eng", "pt-br"...)
  const stripped = raw.replace(/^[\s"'`[\]{}().:;,-]+|[\s"'`[\]{}().:;,-]+$/g, '');
  if (TOKEN_INDEX.has(stripped)) return [TOKEN_INDEX.get(stripped)];

  // 2) Entradas compuestas ("es/en", "spa, eng", "english+spanish")
  const parts = stripped.split(/[\/,|+&;]+|\s+y\s+|\s+and\s+/).map((p) => p.trim()).filter(Boolean);
  const out = new Set();
  if (parts.length > 1) {
    for (const p of parts) {
      if (TOKEN_INDEX.has(p)) out.add(TOKEN_INDEX.get(p));
      else for (const l of detectLanguagesInText(p, { allowCodes: false })) out.add(l);
    }
    if (out.size) return [...out];
  }

  // 3) Texto libre ("Español Latino", "Audio: Castellano")
  for (const l of detectLanguagesInText(stripped, { allowCodes: false })) out.add(l);
  return [...out];
}

/**
 * Limpia y estandariza un array `audio` / `subtitles`:
 * minúsculas, etiquetas canónicas, sin duplicados ni basura de scrapers.
 * Devuelve siempre un array (vacío si no hay nada útil), ordenado.
 */
export function normalizeLanguageArray(value) {
  let items = value;
  if (typeof value === 'string') {
    // Puede venir serializado: '{es,en}', '["es","en"]', 'es, en'
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try { items = JSON.parse(trimmed); } catch { items = trimmed.replace(/^\[|\]$/g, '').split(','); }
    } else if (trimmed.startsWith('{')) {
      items = trimmed.replace(/^\{|\}$/g, '').split(',');
    } else {
      items = trimmed.split(/[,;|]/);
    }
  }
  if (!Array.isArray(items)) return [];
  const out = new Set();
  for (const entry of items) {
    for (const l of normalizeLanguageEntry(entry)) out.add(l);
  }
  return uniqueSorted([...out]);
}

/** Compara dos arrays normalizados. */
export function sameLanguageArray(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

// --- Detección en títulos ---------------------------------------------------

const RE_SUBS_MARKER = /(?<![A-Za-z])(?:multi[ ._-]?subs?|multiple[ ._-]?subtitles?|multi[ ._-]?subtitles?|multisub|subs?[ ._-]?multi|subtitles?|subt[ií]tulos?|subtitulad[oa]s?|legendado|softsubs?|hardsubs?|sub(?:s|bed)?)(?![A-Za-z])/i;
const RE_DUAL_MARKER = /(?<![A-Za-z])(?:dual[ ._-]?(?:audio|áudio|lang(?:uage)?)?|multi[ ._-]?(?:audio|lang(?:uage)?s?)|tri[ ._-]?audio|doble[ ._-]?audio)(?![A-Za-z])/i;
const RE_VOSE = /(?<![A-Za-z])VOSE(?![A-Za-z])/i;
const RE_VOSI = /(?<![A-Za-z])VOSI(?![A-Za-z])/i;
const RE_VOSTFR = /(?<![A-Za-z])VOSTFR(?![A-Za-z])/i;
const RE_VOSTA = /(?<![A-Za-z])VOSTA(?![A-Za-z])/i;
const RE_VO = /(?<![A-Za-z])V\.?O\.?(?:S\.?)?(?![A-Za-z])/;
const RE_SUB_SPANISH = /(?<![A-Za-z])(?:sub(?:s|t[ií]tulos?|titulad[oa]s?|titles?)?[ ._:-]*(?:en[ ._])?(?:esp(?:a[ñn]ol)?|espa[ñn]ol|castellano|spanish|latino|lat|cast|es)(?![A-Za-z])|(?:esp(?:a[ñn]ol)?|espa[ñn]ol|castellano|spanish|latino)[ ._-]*sub(?:s|t[ií]tulos?|titulad[oa]s?|titles?|bed)?(?![A-Za-z]))/i;
const RE_SUB_ENGLISH = /(?<![A-Za-z])(?:sub(?:s|titles?|bed)?[ ._:-]*(?:eng(?:lish)?|ingl[eé]s|en)(?![A-Za-z])|(?:eng(?:lish)?|ingl[eé]s)[ ._-]*sub(?:s|titles?|bed)?(?![A-Za-z]))/i;

/**
 * Códigos cortos en minúsculas sólo si van entre separadores de release
 * (".spa.", "[eng]"). Con espacios, "the spa" o "the cast" no son idiomas.
 */
const SCENE_LANG = {
  'spa-la': 'latino', 'spa-lat': 'latino', 'es-la': 'latino', 'es-mx': 'latino', 'es-419': 'latino',
  'spa-es': 'spanish', 'es-es': 'spanish',
  'por-br': 'portuguese', 'pt-br': 'portuguese',
  spa: 'spanish', esp: 'spanish', cast: 'spanish', cas: 'spanish',
  lat: 'latino', latam: 'latino',
  eng: 'english', jap: 'japanese', jpn: 'japanese',
  fre: 'french', fra: 'french', ger: 'german', ita: 'italian',
  por: 'portuguese', rus: 'russian', kor: 'korean', chi: 'chinese',
};
// El código tiene que terminar de verdad: si no, "SPA-LA" se leía como "SPA".
const SCENE_CODE_RE = /(?:^|[.[\]_{}()-])(spa-la|spa-lat|es-la|es-mx|es-419|spa-es|es-es|por-br|pt-br|latam|spa|esp|cast|cas|lat|eng|jap|jpn|fre|fra|ger|ita|por|rus|kor|chi)(?![A-Za-z0-9-])/gi;

function addSceneCodes(text, bucket) {
  if (!text) return;
  // matchAll clona la regex empezando en su lastIndex: se resetea por seguridad.
  SCENE_CODE_RE.lastIndex = 0;
  for (const m of text.matchAll(SCENE_CODE_RE)) {
    const lang = SCENE_LANG[m[1].toLowerCase()];
    if (lang) bucket.add(lang);
  }
}

/**
 * Infiere idiomas de audio y subtítulos a partir del título original.
 *
 * Heurística:
 *  1. Marcadores explícitos de subtítulos (VOSE, "Sub Esp", "Multi-Subs")
 *  2. Si hay un marcador tipo "Multi-Subs"/"Multiple Subtitle", los códigos de
 *     idioma que aparecen DESPUÉS de él se consideran subtítulos.
 *  3. El resto de idiomas se consideran audio.
 *  4. Si no se detecta nada y el grupo de release es conocido, se aplica su perfil.
 *
 * @returns {{ audio: string[], subtitles: string[], dual: boolean, multiSubs: boolean, original: boolean }}
 */
export function detectTitleLanguages(title, groupProfile = null) {
  const audio = new Set();
  const subtitles = new Set();
  const text = title || '';

  const dual = RE_DUAL_MARKER.test(text);
  const subsMarker = RE_SUBS_MARKER.exec(text);
  const multiSubs = !!subsMarker && /multi/i.test(subsMarker[0]);
  const original = RE_VO.test(text) || RE_VOSE.test(text) || RE_VOSI.test(text) || RE_VOSTFR.test(text) || RE_VOSTA.test(text);

  // 1) Subtítulos explícitos en español/inglés.
  if (RE_VOSE.test(text)) subtitles.add('spanish');
  if (RE_VOSI.test(text) || RE_VOSTA.test(text)) subtitles.add('english');
  if (RE_VOSTFR.test(text)) subtitles.add('french');
  const subEs = RE_SUB_SPANISH.exec(text);
  if (subEs) subtitles.add(/latino|lat\b/i.test(subEs[0]) ? 'latino' : 'spanish');
  if (RE_SUB_ENGLISH.test(text)) subtitles.add('english');

  // 2) Segmentación en zona "audio" / zona "subtítulos".
  let audioZone = text;
  let subsZone = '';
  if (subsMarker) {
    audioZone = text.slice(0, subsMarker.index);
    subsZone = text.slice(subsMarker.index + subsMarker[0].length);
    // Si el marcador es genérico ("Subs") y no hay nada detrás, lo que sigue
    // en la misma etiqueta suele ser el idioma de los subtítulos.
  }

  // Quitamos las expresiones de subtítulos ya procesadas para no contarlas como audio.
  const audioText = audioZone
    .replace(RE_SUB_SPANISH, ' ')
    .replace(RE_SUB_ENGLISH, ' ')
    .replace(RE_VOSE, ' ')
    .replace(RE_VOSI, ' ')
    .replace(RE_VOSTFR, ' ')
    .replace(RE_VOSTA, ' ');

  for (const l of detectLanguagesInText(audioText)) audio.add(l);
  for (const l of detectLanguagesInText(subsZone)) subtitles.add(l);
  addSceneCodes(audioText, audio);
  addSceneCodes(subsZone, subtitles);

  // Los idiomas anteriores a un marcador tipo "Spanish Sub" ya fueron capturados
  // por RE_SUB_SPANISH/RE_SUB_ENGLISH y eliminados de la zona de audio.

  // "VOSE" / "VO": el audio es el original → si no se detectó audio, lo dejamos vacío
  // (desconocido) salvo que el perfil de grupo lo indique.
  // Doblaje explícito ("Latino Dubbed") no cambia nada: el idioma ya cuenta como audio.

  // 4) Perfil del grupo de release (anime) como valor por defecto.
  if (groupProfile) {
    if (audio.size === 0) for (const l of groupProfile.audio || []) audio.add(l);
    if (subtitles.size === 0 && !original) for (const l of groupProfile.subtitles || []) subtitles.add(l);
  }

  return {
    audio: uniqueSorted([...audio]),
    subtitles: uniqueSorted([...subtitles]),
    dual,
    multiSubs,
    original,
  };
}

/**
 * Clasifica un torrent en grupos de idioma para la deduplicación.
 *
 * @param {object} p
 * @param {string[]} p.audio      audio normalizado (BD + título)
 * @param {string[]} p.subtitles  subtítulos normalizados (BD + título)
 * @returns {{ spanish: boolean, english: boolean, other: boolean, unknown: boolean }}
 *
 *  - spanish: audio castellano/latino, o subtítulos en español (VOSE, fansubs...)
 *  - english: audio inglés o subtítulos en inglés
 *  - unknown: sin señal es/en y sin información de subtítulos → no podemos saberlo
 *  - other:   audio explícito en otro idioma y subtítulos conocidos que no son es/en
 */
export function classifyLanguage({ audio = [], subtitles = [] }) {
  const hasES = audio.some((l) => SPANISH_GROUP.has(l)) || subtitles.some((l) => SPANISH_GROUP.has(l));
  const hasEN = audio.some((l) => ENGLISH_GROUP.has(l)) || subtitles.some((l) => ENGLISH_GROUP.has(l));
  if (hasES || hasEN) return { spanish: hasES, english: hasEN, other: false, unknown: false };
  const other = audio.length > 0 && subtitles.length > 0;
  return { spanish: false, english: false, other, unknown: !other };
}
