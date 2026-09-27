/**
 * Configuración centralizada del script.
 *
 * Todo se lee de `process.env` para que en GitHub Actions las credenciales
 * viajen como "secrets" y los parámetros de comportamiento como "vars" o inputs.
 */

const env = process.env;

const toBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
};

const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const toFloat = (value, fallback) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

const MB = 1024 * 1024;

/** Orden canónico de ejecución de los pasos. */
export const ALL_STEPS = [
  'adult',
  'size',
  'dead',
  'normalize',
  'enrich',
  'dedupe',
];

const parseSteps = (raw) => {
  if (!raw || raw.trim().toLowerCase() === 'all') return [...ALL_STEPS];
  const wanted = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = wanted.filter((s) => !ALL_STEPS.includes(s));
  if (unknown.length) {
    throw new Error(`STEPS contiene pasos desconocidos: ${unknown.join(', ')}. Válidos: ${ALL_STEPS.join(', ')}`);
  }
  // Se respeta siempre el orden canónico, independientemente del orden indicado.
  return ALL_STEPS.filter((s) => wanted.includes(s));
};

export const config = Object.freeze({
  // --- Supabase -----------------------------------------------------------
  supabaseUrl: env.SUPABASE_URL || '',
  supabaseKey: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY || '',
  table: env.TABLE_NAME || 'torrents',
  /** Columna donde se guarda el título limpio generado por el parser. */
  cleanTitleColumn: env.CLEAN_TITLE_COLUMN || 'title_text',

  // --- Ejecución ----------------------------------------------------------
  dryRun: toBool(env.DRY_RUN, false),
  steps: parseSteps(env.STEPS),
  continueOnError: toBool(env.CONTINUE_ON_ERROR, true),
  logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
  pageSize: Math.min(Math.max(toInt(env.PAGE_SIZE, 1000), 50), 1000), // PostgREST limita a 1000 por defecto
  deleteChunkSize: Math.min(Math.max(toInt(env.DELETE_CHUNK_SIZE, 500), 10), 1000),
  updateConcurrency: Math.max(toInt(env.UPDATE_CONCURRENCY, 8), 1),
  /** Límite de seguridad: si un paso quiere borrar más de este % de las filas evaluadas, aborta. */
  maxDeleteRatio: toFloat(env.MAX_DELETE_RATIO, 0.95),

  // --- Paso 1: contenido adulto ------------------------------------------
  adult: {
    /** Palabras extra separadas por coma (se suman a la lista integrada). */
    extraKeywords: (env.ADULT_EXTRA_KEYWORDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  },

  // --- Paso 2: anti-fakes por tamaño --------------------------------------
  size: {
    minMovieBytes: toInt(env.MIN_MOVIE_MB, 150) * MB,
    minSeriesBytes: toInt(env.MIN_SERIES_MB, 30) * MB,
    /** Tratar también `anime` con el umbral de series. */
    applyToAnime: toBool(env.SIZE_FILTER_APPLY_TO_ANIME, true),
    /** Si `false`, se ignoran size_bytes = 0 (tamaño desconocido). */
    includeZero: toBool(env.SIZE_FILTER_INCLUDE_ZERO, false),
  },

  // --- Paso 3: torrents muertos -------------------------------------------
  dead: {
    afterDays: toInt(env.DEAD_AFTER_DAYS, 30),
    /** Si `true`, también purga seeders NULL (desconocidos). */
    includeNullSeeders: toBool(env.DEAD_INCLUDE_NULL_SEEDERS, false),
  },

  // --- Paso 4/5: normalización --------------------------------------------
  normalize: {
    /** Sobrescribir `type` aunque ya exista, si el parser está muy seguro. */
    overwriteType: toBool(env.NORMALIZE_OVERWRITE_TYPE, false),
    /** Sobrescribir season/episode/absolute_episode aunque existan. */
    overwriteEpisodes: toBool(env.NORMALIZE_OVERWRITE_EPISODES, false),
    /** Fusionar idiomas detectados en el título dentro de audio/subtitles. */
    mergeTitleLanguages: toBool(env.NORMALIZE_MERGE_TITLE_LANGUAGES, true),
    /** Confianza mínima del parser (0-1) para sobrescribir `type`. */
    typeConfidence: toFloat(env.NORMALIZE_TYPE_CONFIDENCE, 0.8),
  },

  // --- Paso 6: enriquecimiento --------------------------------------------
  enrich: {
    tmdbApiKey: env.TMDB_API_KEY || '',
    /** Máximo de obras distintas a resolver por ejecución (controla tiempo/rate-limits). */
    maxLookups: toInt(env.ENRICH_MAX_LOOKUPS, 300),
    /** Similitud mínima título↔resultado para aceptar un match (0-1). */
    minSimilarity: toFloat(env.ENRICH_MIN_SIMILARITY, 0.6),
    /** Buscar también anime en TMDB (para obtener tmdb_id/imdb_id útiles en Stremio). */
    tmdbForAnime: toBool(env.ENRICH_TMDB_FOR_ANIME, true),
    concurrency: Math.max(toInt(env.ENRICH_CONCURRENCY, 4), 1),
    anilistPerMinute: toInt(env.ANILIST_RPM, 28), // AniList opera degradado a 30 req/min
    kitsuPerMinute: toInt(env.KITSU_RPM, 90),
    tmdbPerSecond: toInt(env.TMDB_RPS, 20),
  },

  // --- Paso 7: deduplicación ----------------------------------------------
  dedupe: {
    /** Qué hacer con torrents que no son ni spanish ni english: `delete` | `keep`. */
    otherLanguagePolicy: (env.DEDUP_OTHER_LANGUAGE_POLICY || 'delete').toLowerCase(),
    /** Grupo al que se asignan torrents sin información de idioma: `english` | `spanish` | `keep`. */
    unknownLanguageAs: (env.DEDUP_UNKNOWN_LANGUAGE_AS || 'english').toLowerCase(),
    /** Agrupar también torrents sin IDs usando el título limpio + año. */
    fallbackTitleKey: toBool(env.DEDUP_FALLBACK_TITLE_KEY, false),
    /** Peso de los seeders en la puntuación (log2). */
    seederWeight: toFloat(env.DEDUP_SEEDER_WEIGHT, 20),
  },
});

/** Valida lo imprescindible antes de arrancar. Lanza si falta algo. */
export function validateConfig(cfg = config) {
  const problems = [];
  if (!cfg.supabaseUrl) problems.push('SUPABASE_URL es obligatoria');
  if (!cfg.supabaseKey) problems.push('SUPABASE_SERVICE_ROLE_KEY es obligatoria');
  if (!['delete', 'keep'].includes(cfg.dedupe.otherLanguagePolicy)) {
    problems.push('DEDUP_OTHER_LANGUAGE_POLICY debe ser delete|keep');
  }
  if (!['english', 'spanish', 'keep'].includes(cfg.dedupe.unknownLanguageAs)) {
    problems.push('DEDUP_UNKNOWN_LANGUAGE_AS debe ser english|spanish|keep');
  }
  if (problems.length) {
    throw new Error(`Configuración inválida:\n - ${problems.join('\n - ')}`);
  }
  return cfg;
}
