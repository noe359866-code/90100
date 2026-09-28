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

test('config: MAX_DELETE_RATIO acepta porcentaje y los días negativos se recortan', async () => {
  const previousRatio = process.env.MAX_DELETE_RATIO;
  const previousDays = process.env.DEAD_AFTER_DAYS;
  process.env.MAX_DELETE_RATIO = '95';
  process.env.DEAD_AFTER_DAYS = '-3';
  try {
    const { config: fresh } = await import('../src/config.js?ratio=1');
    assert.equal(fresh.maxDeleteRatio, 0.95);
    assert.equal(fresh.dead.afterDays, 0);
  } finally {
    if (previousRatio === undefined) delete process.env.MAX_DELETE_RATIO;
    else process.env.MAX_DELETE_RATIO = previousRatio;
    if (previousDays === undefined) delete process.env.DEAD_AFTER_DAYS;
    else process.env.DEAD_AFTER_DAYS = previousDays;
  }
});

test('index: el módulo principal carga sin errores de sintaxis', async () => {
  // Importar src/index.js ejecutaría main(); comprobamos en su lugar los módulos que orquesta.
  for (const m of ['../src/db.js', '../src/logger.js', '../src/steps/01-adultFilter.js', '../src/steps/02-sizeFilter.js', '../src/steps/03-deadPurger.js', '../src/steps/04-normalizer.js', '../src/steps/05-enricher.js', '../src/steps/06-deduplicator.js', '../src/apis/anilist.js', '../src/apis/kitsu.js', '../src/apis/tmdb.js']) {
    await assert.doesNotReject(() => import(m), m);
  }
});

test('config: un STEPS inválido se reporta al validar, no al importar', async () => {
  const previous = process.env.STEPS;
  process.env.STEPS = 'adult,noexiste';
  try {
    const { config: fresh, validateConfig } = await import('../src/config.js?steps=invalido');
    assert.equal(fresh.stepsError, 'STEPS contiene pasos desconocidos: noexiste. Válidos: adult, size, dead, normalize, enrich, dedupe (o "all")');
    assert.deepEqual(fresh.steps, ['adult', 'size', 'dead', 'normalize', 'enrich', 'dedupe'], 'respaldo: se usarían todos los pasos');
    assert.throws(
      () => validateConfig({ ...fresh, supabaseUrl: 'x', supabaseKey: 'y' }),
      /STEPS contiene pasos desconocidos: noexiste/,
      'debe abortar con un mensaje claro (y logueable) antes de tocar la BD',
    );
  } finally {
    if (previous === undefined) delete process.env.STEPS;
    else process.env.STEPS = previous;
  }
});

test('config: un LOG_LEVEL inválido se avisa sin romper la ejecución', async () => {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'verbose';
  try {
    const { config: fresh, validateConfig } = await import('../src/config.js?loglevel=malo');
    assert.equal(fresh.logLevel, 'verbose');
    assert.equal(fresh.warnings.length, 1);
    assert.match(fresh.warnings[0], /LOG_LEVEL="verbose" no es válido/);
    assert.doesNotThrow(() => validateConfig({ ...fresh, supabaseUrl: 'x', supabaseKey: 'y' }), 'no es fatal: el logger cae a info');
  } finally {
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
  }
});

test('index: cada paso de ALL_STEPS tiene su runner y su título', async () => {
  const { ALL_STEPS } = await import('../src/config.js');
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  for (const step of ALL_STEPS) {
    assert.match(src, new RegExp(`\\b${step}:\\s*\\{ title:`), `falta el runner del paso "${step}" en src/index.js`);
  }
});
