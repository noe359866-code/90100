/**
 * Configuración centralizada del script.
 *
 * Todo se lee de `process.env` para que en GitHub Actions las credenciales
 * viajen como "secrets" y los parámetros de comportamiento como "vars" o inputs.
 * En local, si existe `.env` en el directorio de trabajo (o junto al repo), se
 * carga sin pisar variables que ya vengan del entorno.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadDotEnv() {
  const candidates = [
    join(process.cwd(), '.env'),
    join(dirname(fileURLToPath(import.meta.url)), '..', '.env'),
  ];
  const seen = new Set();
  for (const path of candidates) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (process.env[key] !== undefined) continue;
      let value = trimmed.slice(eq + 1).trim();
      const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
      if (quoted) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '').trim();
      process.env[key] = value;
    }
  }
}

loadDotEnv();

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

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** 0.95 o 95 (porcentaje) → fracción 0-1. Negativos vuelven al defecto. */
const toRatio = (value, fallback) => {
  const n = toFloat(value, fallback);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return clamp(n > 1 ? n / 100 : n, 0, 1);
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const MB = 1024 * 1024;

/**
 * Normaliza un valor de entorno: los secrets se pegan a menudo con espacios o
 * un salto de línea final, y eso rompe URLs y API keys sin ningún error obvio.
 */
const clean = (value) => String(value ?? '').trim();

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
  supabaseUrl: clean(env.SUPABASE_URL),
  supabaseKey: clean(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY),
  table: clean(env.TABLE_NAME) || 'torrents',
  /** Columna donde se guarda el título limpio generado por el parser. */
  cleanTitleColumn: clean(env.CLEAN_TITLE_COLUMN) || 'title_text',

  // --- Ejecución ----------------------------------------------------------
  dryRun: toBool(env.DRY_RUN, false),
  steps: parseSteps(env.STEPS),
  continueOnError: toBool(env.CONTINUE_ON_ERROR, true),
  logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
  pageSize: clamp(toInt(env.PAGE_SIZE, 1000), 50, 1000), // PostgREST limita a 1000 por defecto
  deleteChunkSize: clamp(toInt(env.DELETE_CHUNK_SIZE, 500), 10, 1000),
  updateConcurrency: Math.max(toInt(env.UPDATE_CONCURRENCY, 8), 1),
  /**
   * Filas por llamada a la RPC `bulk_update_torrents` (o por ronda del fallback
   * fila a fila). 500 recorta a la mitad los round-trips que el enriquecedor
   * necesita para guardar la telemetría ids_* (una por fila escaneada) sin
   * arriesgar statement timeouts: la RPC es un único UPDATE ... FROM.
   */
  updateChunkSize: clamp(toInt(env.UPDATE_CHUNK_SIZE, 500), 10, 2000),
  /** Límite de seguridad: si un paso quiere borrar más de este % de las filas evaluadas, aborta. */
  maxDeleteRatio: toRatio(env.MAX_DELETE_RATIO, 0.95),

  // --- Paso 1: contenido adulto ------------------------------------------
  adult: {
    /** Palabras extra separadas por coma (se suman a la lista integrada). */
    extraKeywords: (env.ADULT_EXTRA_KEYWORDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  },

  // --- Paso 2: anti-fakes por tamaño --------------------------------------
  size: {
    minMovieBytes: Math.max(toInt(env.MIN_MOVIE_MB, 150), 0) * MB,
    minSeriesBytes: Math.max(toInt(env.MIN_SERIES_MB, 30), 0) * MB,
    /** Tratar también `anime` con el umbral de series. */
    applyToAnime: toBool(env.SIZE_FILTER_APPLY_TO_ANIME, true),
    /** Si `false`, se ignoran size_bytes = 0 (tamaño desconocido). */
    includeZero: toBool(env.SIZE_FILTER_INCLUDE_ZERO, false),
  },

  // --- Paso 3: torrents muertos -------------------------------------------
  dead: {
    afterDays: Math.max(toInt(env.DEAD_AFTER_DAYS, 30), 0),
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
    typeConfidence: clamp(toFloat(env.NORMALIZE_TYPE_CONFIDENCE, 0.8), 0, 1),
  },

  // --- Paso 6: enriquecimiento --------------------------------------------
  enrich: {
    tmdbApiKey: clean(env.TMDB_API_KEY),
    /** Máximo de obras distintas a resolver por ejecución (controla tiempo/rate-limits). */
    maxLookups: Math.max(toInt(env.ENRICH_MAX_LOOKUPS, 300), 0),
    /** Similitud mínima título↔resultado para aceptar un match (0-1). */
    minSimilarity: clamp(toFloat(env.ENRICH_MIN_SIMILARITY, 0.6), 0, 1),
    /** Buscar también anime en TMDB (para obtener tmdb_id/imdb_id útiles en Stremio). */
    tmdbForAnime: toBool(env.ENRICH_TMDB_FOR_ANIME, true),
    concurrency: Math.max(toInt(env.ENRICH_CONCURRENCY, 4), 1),
    anilistPerMinute: Math.max(toInt(env.ANILIST_RPM, 20), 1), // AniList: 30 req/min reales; 20 deja margen
    /** Tasa mínima a la que se degrada AniList cuando devuelve 429 (penalty box). */
    anilistMinPerMinute: Math.max(toInt(env.ANILIST_MIN_RPM, 5), 1),
    kitsuPerMinute: Math.max(toInt(env.KITSU_RPM, 90), 1),
    /** Tasa mínima a la que se degrada Kitsu cuando devuelve 429. */
    kitsuMinPerMinute: Math.max(toInt(env.KITSU_MIN_RPM, 15), 1),
    tmdbPerSecond: Math.max(toInt(env.TMDB_RPS, 20), 1),

    // --- Telemetría de resolución (columnas opcionales de la tabla) ------------
    // Si la tabla tiene ids_checked_at / ids_source / ids_confidence / ids_attempts
    // se registra cada consulta: así no se reintentan a diario las mismas obras
    // imposibles (que es lo que quema la cuota de AniList/TMDB).
    trackIdsColumns: toBool(env.ENRICH_TRACK_IDS_COLUMNS, true),
    /** Días antes de volver a consultar una obra que no se pudo resolver. */
    recheckAfterDays: Math.max(toInt(env.ENRICH_RECHECK_AFTER_DAYS, 14), 0),
    /** Intentos máximos por obra (0 = ilimitado). */
    maxAttempts: Math.max(toInt(env.ENRICH_MAX_ATTEMPTS, 3), 0),
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
    seederWeight: Math.max(toFloat(env.DEDUP_SEEDER_WEIGHT, 20), 0),
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
  if (!IDENT.test(cfg.table)) problems.push('TABLE_NAME debe ser un identificador simple (letras, números, _)');
  if (!IDENT.test(cfg.cleanTitleColumn)) problems.push('CLEAN_TITLE_COLUMN debe ser un identificador simple');
  if (problems.length) {
    throw new Error(`Configuración inválida:\n - ${problems.join('\n - ')}`);
  }
  return cfg;
}
