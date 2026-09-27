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
import { createDb } from './db.js';
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

/** Escribe el resumen en $GITHUB_STEP_SUMMARY si estamos en Actions. */
function writeGithubSummary(results, dbStats, totalMs) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const lines = [
    `## 🧹 Mantenimiento de \`${config.table}\`${config.dryRun ? ' — **DRY RUN**' : ''}`,
    '',
    `Duración total: **${fmtMs(totalMs)}** · Borradas: **${dbStats.deleted}** · Actualizadas: **${dbStats.updated}**`,
    '',
    '| Paso | Estado | Duración | Resultado |',
    '|------|--------|----------|-----------|',
  ];
  for (const r of results) {
    const status = r.error ? '❌ error' : '✅ ok';
    const detail = r.error ? `\`${r.error}\`` : `\`${JSON.stringify(r.result)}\``;
    lines.push(`| ${STEP_RUNNERS[r.step].title} | ${status} | ${fmtMs(r.ms)} | ${detail} |`);
  }
  lines.push('');
  try { appendFileSync(file, `${lines.join('\n')}\n`); } catch (err) { log.warn(`No se pudo escribir GITHUB_STEP_SUMMARY: ${err.message}`); }
}

async function main() {
  log.setLevel(config.logLevel);
  validateConfig(config);

  log.info(`Inicio del mantenimiento de "${config.table}" — pasos: ${config.steps.join(', ')}${config.dryRun ? ' — MODO DRY RUN (no se escribe nada)' : ''}`);

  const db = createDb(config);
  const approx = await db.healthcheck();
  log.info(`Conexión OK. Filas aproximadas en la tabla: ${approx}`);

  const results = [];
  const t0 = Date.now();
  let failed = false;

  for (const step of config.steps) {
    const { title, run } = STEP_RUNNERS[step];
    log.group(title);
    const start = Date.now();
    try {
      const result = await run(db, config, log);
      results.push({ step, result, ms: Date.now() - start });
    } catch (err) {
      failed = true;
      log.error(`Paso "${step}" falló: ${err.stack || err.message}`);
      results.push({ step, error: err.message, ms: Date.now() - start });
      if (!config.continueOnError) {
        log.groupEnd();
        break;
      }
    } finally {
      log.groupEnd();
    }
  }

  const totalMs = Date.now() - t0;
  log.info('================ RESUMEN ================');
  for (const r of results) {
    log.info(`${r.error ? '✗' : '✓'} ${STEP_RUNNERS[r.step].title} (${fmtMs(r.ms)}) → ${r.error ? r.error : JSON.stringify(r.result)}`);
  }
  log.info(`Totales BD: ${JSON.stringify(db.stats)} · duración ${fmtMs(totalMs)}`);
  writeGithubSummary(results, db.stats, totalMs);

  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exitCode = 1;
});
