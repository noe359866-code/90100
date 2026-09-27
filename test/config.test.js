import { test } from 'node:test';
import assert from 'node:assert/strict';

test('config: se importa y valida credenciales obligatorias', async () => {
  const { config, validateConfig, ALL_STEPS } = await import('../src/config.js');
  assert.deepEqual(ALL_STEPS, ['adult', 'size', 'dead', 'normalize', 'enrich', 'dedupe']);
  assert.equal(config.size.minMovieBytes, 150 * 1024 * 1024);
  assert.equal(config.size.minSeriesBytes, 30 * 1024 * 1024);
  assert.equal(config.dead.afterDays, 30);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    assert.throws(() => validateConfig(config), /SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY/);
  }
  assert.throws(() => validateConfig({ ...config, supabaseUrl: 'x', supabaseKey: 'y', dedupe: { ...config.dedupe, otherLanguagePolicy: 'nope' } }), /DEDUP_OTHER_LANGUAGE_POLICY/);
});

test('index: el módulo principal carga sin errores de sintaxis', async () => {
  // Importar src/index.js ejecutaría main(); comprobamos en su lugar los módulos que orquesta.
  for (const m of ['../src/db.js', '../src/logger.js', '../src/steps/01-adultFilter.js', '../src/steps/02-sizeFilter.js', '../src/steps/03-deadPurger.js', '../src/steps/04-normalizer.js', '../src/steps/05-enricher.js', '../src/steps/06-deduplicator.js', '../src/apis/anilist.js', '../src/apis/kitsu.js', '../src/apis/tmdb.js']) {
    await assert.doesNotReject(() => import(m), m);
  }
});
