/**
 * PASO 1 — FILTRO DE CONTENIDO ADULTO
 *
 * Elimina los registros cuyo `title` contenga palabras clave explícitas.
 *
 * Estrategia en dos fases para ser rápido y a la vez preciso:
 *   1. Servidor: PostgREST `imatch` (regex ~*) preselecciona candidatos.
 *   2. Cliente: una regex con límites de palabra + lista blanca descarta falsos
 *      positivos (p. ej. la película "xXx" de Vin Diesel, "Sex Education",
 *      "Boobs" dentro de "Booby Trap", etc.).
 */

/**
 * Palabras que por sí solas marcan contenido adulto (con límite de palabra).
 *
 * Se han excluido a propósito términos demasiado genéricos que aparecen en
 * títulos legítimos ("private", "naked", "adult", "sexy", "corrida", "zorra"…).
 * Amplía la lista con `ADULT_EXTRA_KEYWORDS="palabra1,palabra2"` si tu catálogo lo necesita.
 */
const ADULT_KEYWORDS = [
  // Genéricos / plataformas
  'porn', 'porno', 'pornos', 'pornhub', 'pornografia', 'pornografía', 'pornstar', 'porn star', 'xxx', 'nsfw', 'hentai', 'jav', 'javhd',
  'onlyfans', 'only fans', 'camgirl', 'cam girl', 'chaturbate', 'xvideos', 'xhamster', 'xnxx', 'redtube', 'youporn', 'spankbang', 'eporner', 'pornhd',
  // Estudios
  'brazzers', 'bangbros', 'naughty america', 'naughtyamerica', 'blacked', 'tushy', 'vixen', 'reality kings', 'realitykings',
  'evil angel', 'evilangel', 'sexmex', 'sex mex', 'mofos', 'digital playground', 'digitalplayground', 'marc dorcel', 'dorcel',
  'wicked pictures', 'legalporno', 'legal porno', 'analvids', 'anal vids', 'nubiles', 'nubile films', 'teamskeet', 'team skeet',
  'fakehub', 'fake taxi', 'faketaxi', 'public agent', 'publicagent', 'bratty sis', 'brattysis', 'family strokes', 'familystrokes',
  'sis loves me', 'sislovesme', 'pure taboo', 'puretaboo', 'adult time', 'adulttime', 'girlsway', 'twistys', 'babes network', 'met-art', 'metart',
  // Actos / etiquetas
  'blowjob', 'blow job', 'handjob', 'creampie', 'gangbang', 'gang bang', 'bukkake', 'milf', 'gilf', 'orgy', 'anal', 'cumshot', 'cum shot',
  'deepthroat', 'deep throat', 'squirting', 'bdsm', 'femdom', 'hardcore', 'softcore', 'erotic', 'erotica', 'erótico', 'erotico', 'erótica',
  'sex tape', 'sextape', 'shemale', 'tranny', 'futanari', 'ahegao', 'boobs', 'tits', 'titties', 'big ass', 'bigass', 'big tits', 'bigtits',
  'big boobs', 'pussy', 'slut', 'sluts', 'whore', 'whores', 'jerk off', 'jerkoff', 'masturbation', 'masturbating', 'fuck', 'fucked', 'fucking', 'fucks',
  '18+', '+18',
  // Español
  'sexo', 'follando', 'follar', 'putas', 'putita', 'putitas', 'tetas', 'tetonas', 'culona', 'culonas', 'pajas', 'mamada', 'mamadas',
  'incesto', 'guarras', 'cachonda', 'cachondas', 'xxx español', 'porno español', 'amateur español',
];

/**
 * Títulos legítimos que contienen una palabra clave (se comparan en minúsculas
 * contra el título completo). Si el título contiene alguno de estos fragmentos
 * NO se elimina, salvo que también contenga una palabra de la lista "dura".
 */
const WHITELIST = [
  'xxx: return of xander cage', 'xxx return of xander cage', 'xxx: state of the union', 'xxx state of the union', 'xxx (2002)', 'xxx 2002', 'xxx.2002', 'xxx.2005', 'xxx.2017', 'xxx 2005', 'xxx 2017',
  'sex education', 'sex and the city', 'sex/life', 'masters of sex', 'sex lives of college girls', 'sex, lies, and videotape', 'sex lies and videotape',
  'hardcore henry', 'hardcore (2015)', 'hardcore 2015', 'hardcore.2015',
  'fuck you goethe', 'fack ju göhte', 'what the fuck', 'fuck the police',
  'pussy riot', 'octopussy', 'pussycat', 'the pussycat dolls',
  'erotic stories', 'erotica (1994)', 'erotica 1994',
  'milf (2018)', 'milf 2018', 'milf.2018',
  'threesome (1994)', 'threesome 1994',
  'the whore of babylon', 'whore of babylon', 'slut in a good way',
  'big ass spider', 'fuck (2010)', 'fuck 2010', 'fuck.2010', 'fuck (2005)', 'fuck 2005', 'fuck.2005',
  'the fuck-it list', 'fuck-it list', 'el sexo de los ángeles', 'sexo de los ángeles',
  'sluts: the documentary', 'sluts the documentary',
  'tits (2013)', 'tetas y', 'tetas 2',
  'sexo, pudor y lágrimas', 'sexo pudor y lagrimas', 'sexo fácil', 'sexo facil', 'sexo con amor', 'sexo en nueva york', 'sexo en la ciudad', 'sexo por compasión', 'sexo por compasion', 'sexo, mentiras y', 'sexo mentiras y',
  'la mala educación', 'la mala educacion', 'todo sobre mi madre', 'la piel que habito',
  'anal fissure', 'canal', 'canales',
];

/** Palabras "duras": si aparecen, la lista blanca no salva el título. */
const HARD_KEYWORDS = ['porn', 'porno', 'xxx porn', 'brazzers', 'bangbros', 'blacked', 'tushy', 'vixen', 'onlyfans', 'legalporno', 'analvids', 'pornhub', 'xvideos', 'xhamster', 'xnxx', 'nsfw', 'hentai', 'javhd', 'creampie', 'gangbang', 'bukkake', 'deepthroat', 'blowjob', 'handjob', 'cumshot'];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex compartida por servidor (PostgreSQL ~*) y cliente. Palabras con límite. */
export function buildAdultRegex(extra = []) {
  const words = [...new Set([...ADULT_KEYWORDS, ...extra])].map((w) => escapeRe(w).replace(/\s+/g, '[ ._-]?'));
  // Usamos alternancia de límites no alfanuméricos en lugar de \b: PostgreSQL y JS lo interpretan igual.
  return `(^|[^a-z0-9])(${words.join('|')})([^a-z0-9]|$)`;
}

const HARD_RE = new RegExp(`(^|[^a-z0-9])(${HARD_KEYWORDS.map(escapeRe).join('|')})([^a-z0-9]|$)`, 'i');

/**
 * Películas reales cuyo título contiene una palabra dura de estudio.
 * "Vixen" (1968, Russ Meyer) no es el estudio; "Vixen Angela White" sí.
 */
const HARD_EXCEPTIONS = ['vixen 1968', 'russ meyer s vixen', 'russ meyers vixen'];

/** Minúsculas, sin acentos ni separadores: "Big.Ass.Spider!" y "big ass spider" comparan igual. */
const fold = (s) => String(s ?? '')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const FOLDED_WHITELIST = WHITELIST.map(fold).filter(Boolean);
const hasPhrase = (foldedTitle, phrase) => {
  const p = fold(phrase);
  return Boolean(p) && ` ${foldedTitle} `.includes(` ${p} `);
};

/**
 * Decide en cliente si un título es adulto (precisión sobre el candidato del servidor).
 * @param {string} title
 * @param {RegExp} adultRe
 */
export function isAdultTitle(title, adultRe) {
  if (!title) return false;
  const t = title.toLowerCase();
  // Si el llamador pasa una regex global, test() avanza lastIndex y el siguiente título falla.
  adultRe.lastIndex = 0;
  if (!adultRe.test(t)) return false;
  const folded = fold(title);
  const hardHits = [...t.matchAll(new RegExp(HARD_RE.source, 'gi'))].map((m) => m[2]);
  if (hardHits.length) {
    const knownFilm = hardHits.every((h) => h === 'vixen') && HARD_EXCEPTIONS.some((w) => hasPhrase(folded, w));
    return !knownFilm;
  }
  return !FOLDED_WHITELIST.some((w) => hasPhrase(folded, w));
}

/**
 * @param {ReturnType<import('../db.js').createDb>} db
 * @param {import('../config.js').config} config
 */
export async function runAdultFilter(db, config, log) {
  const pattern = buildAdultRegex(config.adult.extraKeywords);
  const adultRe = new RegExp(pattern, 'i');

  const [pending, evaluated] = await Promise.all([
    db.countWhere((q) => q.filter('title', 'imatch', pattern), 'adult-filter pending'),
    db.countWhere((q) => q, 'adult-filter evaluated'),
  ]);
  if (evaluated > 0 && pending / evaluated > config.maxDeleteRatio) {
    const pct = ((pending / evaluated) * 100).toFixed(1);
    throw new Error(`adult-filter: el prefiltro marcaría ${pending} de ${evaluated} filas (${pct}%), por encima de MAX_DELETE_RATIO=${config.maxDeleteRatio}. Abortado por seguridad.`);
  }

  const deleted = await db.deleteWhere(
    (q) => q.filter('title', 'imatch', pattern),
    'adult-filter',
    { select: 'id,title', confirm: (row) => isAdultTitle(row.title, adultRe) },
  );

  log.info(`Filtro adulto: ${deleted} torrents eliminados`);
  return { deleted };
}
