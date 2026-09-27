/** Tests de los clientes de API: credenciales TMDB y validación de la key. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmdbKeyKind, validateTmdbKey, createTmdbClient } from '../src/apis/tmdb.js';

test('tmdbKeyKind: distingue API key v3, token v4 y vacío', () => {
  assert.equal(tmdbKeyKind(undefined), null);
  assert.equal(tmdbKeyKind(''), null);
  assert.equal(tmdbKeyKind('   '), null);
  assert.equal(tmdbKeyKind('  abcdef123456  '), 'v3'); // recorta espacios
  assert.equal(tmdbKeyKind('eyJhbGciOiJIUzI1NiJ9.abcdef'), 'v4');
  assert.equal(tmdbKeyKind('a'.repeat(41)), 'v4');
});

test('createTmdbClient: sin key (o con espacios) devuelve null', () => {
  assert.equal(createTmdbClient({ apiKey: '' }), null);
  assert.equal(createTmdbClient({}), null);
  assert.equal(createTmdbClient({ apiKey: '   ' }), null);
  assert.ok(createTmdbClient({ apiKey: 'abcdef123456' }));
});

test('validateTmdbKey: key vacía no lanza', async () => {
  const res = await validateTmdbKey('');
  assert.equal(res.ok, false);
  assert.equal(res.kind, null);
  assert.match(res.message, /vacía/);
});

const withFetch = async (stub, fn) => {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
};

test('validateTmdbKey: credencial aceptada (HTTP 200)', async () => {
  const calls = [];
  const res = await withFetch(async (url, opts) => {
    calls.push([String(url), opts.headers]);
    return { ok: true, status: 200, statusText: 'OK', text: async () => '{"success":true}' };
  }, () => validateTmdbKey('abcdef123456'));

  assert.equal(res.ok, true);
  assert.equal(res.kind, 'v3');
  assert.match(calls[0][0], /api_key=abcdef123456/); // la key va en la query
});

test('validateTmdbKey: credencial rechazada (HTTP 401) informa del motivo', async () => {
  const res = await withFetch(async () => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    text: async () => '{"status_message":"Invalid API key"}',
  }), () => validateTmdbKey('eyJhbGciOiJIUzI1NiJ9.token'));

  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(res.kind, 'v4');
  assert.match(res.message, /Invalid API key/);
});

test('validateTmdbKey: token v4 se envía como Bearer', async () => {
  const calls = [];
  const res = await withFetch(async (url, opts) => {
    calls.push([String(url), opts.headers]);
    return { ok: true, status: 200, statusText: 'OK', text: async () => '' };
  }, () => validateTmdbKey('eyJhbGciOiJIUzI1NiJ9.token'));

  assert.equal(res.ok, true);
  assert.equal(calls[0][1].Authorization, 'Bearer eyJhbGciOiJIUzI1NiJ9.token');
  assert.doesNotMatch(calls[0][0], /api_key=/);
});

test('config: recorta espacios y saltos de línea en las credenciales', async () => {
  const previous = process.env.TMDB_API_KEY;
  process.env.TMDB_API_KEY = '  key-con-espacios\n';
  try {
    // Query string para evitar la caché de módulos ESM.
    const { config } = await import('../src/config.js?trim=1');
    assert.equal(config.enrich.tmdbApiKey, 'key-con-espacios');
  } finally {
    if (previous === undefined) delete process.env.TMDB_API_KEY;
    else process.env.TMDB_API_KEY = previous;
  }
});
