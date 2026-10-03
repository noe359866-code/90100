#!/usr/bin/env node
/**
 * MANTENIMIENTO DE LA TABLA `torrents` EN SUPABASE
 * ================================================
 *
 * Pasos (en este orden; selecciona un subconjunto con STEPS="adult,size,dedupe"):
 *   1. adult      → elimina contenido adulto por palabras clave en `title`
 *   2. size       → elimina fakes: movies < 150 MB, series/anime < 30 MB
 *   3. dead       → elimina torrents con 0 seeders sin actualizar en 30 días
 *   4. normalize  → parser inteligente: title_text, type, season/episode/absolute_episode,
 *                   codec/quality, arrays audio/subtitles limpios
 *   5. enrich     → completa tmdb_id/imdb_id/anilist_id/kitsu_id/mal_id vía APIs públicas
 *   6. dedupe     → conserva sólo el mejor torrent 'spanish' y el mejor 'english' por obra+episodio
 *
 * Variables de entorno: ver `.env.example` y `src/config.js`.
 * Ejecuta con DRY_RUN=true para ver qué haría sin modificar nada.
 */
import { appendFileSync } from 'node:fs';
import { config, validateConfig } from './config.js';
import { log } from './logger.js';
import { exitSoon } from './utils/exit.js';
import { createDb } from './db.js';
import { tmdbKeyKind, validateTmdbKey } from './apis/tmdb.js';
import { runAdultFilter } from './steps/01-adultFilter.js';
import { runSizeFilter } from './steps/02-sizeFilter.js';
import { runDeadPurger } from './steps/03-deadPurger.js';
import { runNormalizer } from './steps/04-normalizer.js';
import { runEnricher } from './steps/05-enricher.js';
import { runDeduplicator } from './steps/06-deduplicator.js';

const STEP_RUNNERS = {
  adult: { title: '1. Filtro de contenido adulto', run: runAdultFilter },
  size: { title: '2. Filtro anti-fakes por tamaño', run: runSizeFilter },
  dead: { title: '3. Purga de torrents muertos', run: runDeadPurger },
  normalize: { title: '4/5. Normalización de títulos, episodios e idiomas', run: runNormalizer },
  enrich: { title: '6. Enriquecimiento de IDs (AniList / Kitsu / TMDB)', run: runEnricher },
  dedupe: { title: '7. Deduplicación inteligente (Top 1 ES / Top 1 EN)', run: runDeduplicator },
};

const fmtMs = (ms) => (ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}min`);

/**
 * Etiqueta legible de un paso. `config.steps` sale de `ALL_STEPS`, así que un paso
 * sin runner (sólo posible si se añade a la lista y se olvida el runner) no debe
 * tumbar el resumen con un `undefined.title`.
 */
const stepLabel = (step) => STEP_RUNNERS[step]?.title ?? String(step);

/**
 * Diagnóstico de credenciales antes de arrancar.
 * Existe porque el fallo más común es "puse el secret y sigue saliendo el aviso":
 * casi siempre es un problema de nombre o de dónde se guardó, no del código.
 */
async function preflightCredentials() {
  const key = config.enrich.tmdbApiKey;
  const wantsEnrich = config.steps.includes('enrich');

  if (!key) {
    if (wantsEnrich) {
      log.warn('TMDB_API_KEY no está definida en el proceso: las movies/series no se enriquecerán.');
      log.warn('Comprueba en GitHub → Settings → Secrets and variables → Actions:');
      log.warn('  1. El secret debe llamarse EXACTAMENTE "TMDB_API_KEY" (distingue mayúsculas).');
      log.warn('  2. Debe estar en la pestaña "Secrets" (no en "Variables" ni dentro de un "Environment":');
      log.warn('     los secrets de un Environment sólo llegan si el job declara "environment: <nombre>").');
      log.warn('  3. Hay que relanzar el workflow: los secrets se inyectan al iniciar el job, no en caliente.');
    }
    return;
  }

  const kind = tmdbKeyKind(key);
  log.info(`TMDB: credencial detectada (${kind === 'v4' ? 'token de lectura v4' : 'API key v3'}, ${key.length} caracteres). Verificando contra TMDB...`);
  const res = await validateTmdbKey(key);
  if (res.ok) {
    log.info('TMDB: credencial válida');
  } else {
    log.warn(`TMDB: la credencial NO funciona → ${res.message}`);
    log.warn('  · Si es 401: la key está mal copiada, revocada o es del otro tipo (v3 vs v4).');
    log.warn('  · Cópiala de https://www.themoviedb.org/settings/api sin espacios ni saltos de línea.');
  }
}

/** Escribe el resumen en $GITHUB_STEP_SUMMARY si estamos en Actions. */
function writeGithubSummary(results, dbStats, totalMs) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const deleteLabel = config.dryRun ? 'Se eliminarían' : 'Borradas';
  const updateLabel = config.dryRun ? 'Se actualizarían' : 'Actualizadas';
  const lines = [
    `## 🧹 Mantenimiento de \`${config.table}\`${config.dryRun ? ' — **DRY RUN**' : ''}`,
    '',
    `Duración total: **${fmtMs(totalMs)}** · ${deleteLabel}: **${dbStats.deleted}** · ${updateLabel}: **${dbStats.updated}**`,
    '',
    '| Paso | Estado | Duración | Resultado |',
    '|------|--------|----------|-----------|',
  ];
  for (const r of results) {
    const status = r.error ? '❌ error' : '✅ ok';
    const raw = r.error ? r.error : JSON.stringify(r.result);
    const detail = '`' + String(raw).replace(/[|\n\r`]/g, ' ').slice(0, 500) + '`';
    lines.push(`| ${stepLabel(r.step)} | ${status} | ${fmtMs(r.ms)} | ${detail} |`);
  }
  lines.push('');
  try { appendFileSync(file, `${lines.join('\n')}\n`); } catch (err) { log.warn(`No se pudo escribir GITHUB_STEP_SUMMARY: ${err.message}`); }
}

async function main() {
  log.setLevel(config.logLevel);
  validateConfig(config);
  for (const warning of config.warnings ?? []) log.warn(warning);

  await preflightCredentials();

  log.info(`Inicio del mantenimiento de "${config.table}" — pasos: ${config.steps.join(', ')}${config.dryRun ? ' — MODO DRY RUN (no se escribe nada)' : ''}`);

  const db = createDb(config);
  const approx = await db.healthcheck();
  log.info(`Conexión OK. Filas aproximadas en la tabla: ${approx}`);

  const results = [];
  const t0 = Date.now();
  let failed = false;

  for (const step of config.steps) {
    const runner = STEP_RUNNERS[step];
    if (!runner) {
      // Sólo puede pasar si se añade un paso a ALL_STEPS sin su runner (hay test).
      failed = true;
      log.error(`Paso desconocido en STEP_RUNNERS: "${step}"`);
      results.push({ step, error: `paso desconocido: ${step}`, ms: 0 });
      continue;
    }
    const { title, run } = runner;
    log.group(title);
    const start = Date.now();
    try {
      const result = await run(db, config, log);
      results.push({ step, result, ms: Date.now() - start });
    } catch (err) {
      failed = true;
      log.error(`Paso "${step}" falló: ${err.stack || err.message}`);
      results.push({ step, error: err.message, ms: Date.now() - start });
      // El `finally` cierra el grupo; cerrarlo aquí también duplicaba el ::endgroup::.
      if (!config.continueOnError) break;
    } finally {
      log.groupEnd();
    }
  }

  const totalMs = Date.now() - t0;
  log.info('================ RESUMEN ================');
  for (const r of results) {
    log.info(`${r.error ? '✗' : '✓'} ${stepLabel(r.step)} (${fmtMs(r.ms)}) → ${r.error ? r.error : JSON.stringify(r.result)}`);
  }
  log.info(`Totales BD: ${JSON.stringify(db.stats)} · duración ${fmtMs(totalMs)}`);
  writeGithubSummary(results, db.stats, totalMs);

  const code = failed ? 1 : 0;
  process.exitCode = code;
  // supabase-js / undici pueden dejar sockets abiertos y el job de Actions no termina.
  exitSoon(code);
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exitCode = 1;
  exitSoon(1);
});
