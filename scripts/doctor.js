#!/usr/bin/env node
/**
 * DIAGNÓSTICO DE CONFIGURACIÓN (no escribe en la base de datos)
 * ==============================================================
 * Comprueba qué variables de entorno llegan realmente al proceso, valida la
 * credencial de TMDB contra la API y hace un conteo de lectura en Supabase.
 * Pensado para responder a la pregunta
 * "lo configuré en GitHub Actions pero sigue apareciendo el aviso".
 *
 *   npm run doctor                      # usa el entorno actual / .env
 *   SUPABASE_URL=... SUPABASE_...=... npm run doctor
 */
import { config } from '../src/config.js';
import { tmdbKeyKind, validateTmdbKey } from '../src/apis/tmdb.js';
import { createDb } from '../src/db.js';

const mask = (value) => {
  const v = String(value ?? '');
  if (!v) return '(vacia)';
  if (v.length <= 6) return `«${'.'.repeat(v.length)}» (${v.length} caracteres)`;
  return `«${v.slice(0, 4)}...${v.slice(-2)}» (${v.length} caracteres)`;
};

const problems = [];

console.log('\n=== Variables de entorno que ve el proceso ===');
for (const [name, value, { optional = false } = {}] of [
  ['SUPABASE_URL', config.supabaseUrl],
  ['SUPABASE_SERVICE_ROLE_KEY', config.supabaseKey],
  // TMDB es opcional: sin ella sólo se enriquecen los animes (no debe fallar el doctor).
  ['TMDB_API_KEY', config.enrich.tmdbApiKey, { optional: true }],
  ['TABLE_NAME', config.table],
  ['STEPS', config.steps.join(',')],
  ['DRY_RUN', String(config.dryRun)],
]) {
  console.log(`  ${name.padEnd(26)} ${mask(value)}${optional && !value ? '  (opcional)' : ''}`);
  if (!value && !optional) problems.push(`${name} está vacía`);
}
const warnings = [...(config.warnings ?? [])];
if (config.stepsError) problems.push(config.stepsError);
for (const warning of warnings) console.log(`  ! ${warning}`);

console.log('\n=== Validación de TMDB ===');
if (!config.enrich.tmdbApiKey) {
  console.log('  ✗ TMDB_API_KEY no definida → no se enriquecerán movies/series.');
  console.log('    En GitHub: Settings → Secrets and variables → Actions → Secrets → New repository secret');
  console.log('    Nombre exacto: TMDB_API_KEY (las mayúsculas cuentan).');
  console.log('    Si la guardaste en un Environment, el job necesita "environment: <nombre>".');
} else {
  const kind = tmdbKeyKind(config.enrich.tmdbApiKey);
  console.log(`  Tipo detectado: ${kind === 'v4' ? 'token de lectura v4 (Bearer)' : 'API key v3 (query api_key)'}`);
  const res = await validateTmdbKey(config.enrich.tmdbApiKey);
  console.log(`  ${res.ok ? '✓' : '✗'} ${res.message}`);
  if (!res.ok) problems.push(`TMDB_API_KEY rechazada (${res.message})`);
}

if (config.supabaseUrl && config.supabaseKey) {
  console.log('\n=== Conexión a Supabase ===');
  try {
    const db = createDb(config);
    const approx = await db.healthcheck();
    console.log(`  ✓ Conexión OK. Filas aproximadas en "${config.table}": ${approx}`);
  } catch (err) {
    console.log(`  ✗ ${err.message}`);
    problems.push(`Supabase: ${err.message}`);
  }
}

console.log('');
for (const warning of warnings) console.log(`  ! ${warning}`); // se repiten al final para que no pasen desapercibidos
if (problems.length) {
  console.log(`Resultado: ${problems.length} problema(s) detectado(s)${warnings.length ? ` y ${warnings.length} aviso(s)` : ''}.`);
  process.exitCode = 1;
} else if (warnings.length) {
  console.log(`Resultado: sin problemas (${warnings.length} aviso(s) de configuración).`);
} else {
  console.log('Resultado: todo correcto.');
}
