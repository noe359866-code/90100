import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLanguageArray, detectTitleLanguages, classifyLanguage, sameLanguageArray } from '../src/parser/languages.js';

test('normalizeLanguageArray: códigos, nombres y basura', () => {
  assert.deepEqual(
    normalizeLanguageArray(['Spanish (Latin America)', 'AC3 5.1', 'es', 'ENG', 'English', 'unknown', 'pt-BR', 'Castellano', '', null, 'und', '5.1']),
    ['english', 'latino', 'portuguese', 'spanish'],
  );
});

test('normalizeLanguageArray: entradas compuestas y serializadas', () => {
  assert.deepEqual(normalizeLanguageArray(['es/en']), ['english', 'spanish']);
  assert.deepEqual(normalizeLanguageArray('{spa,eng}'), ['english', 'spanish']);
  assert.deepEqual(normalizeLanguageArray('["ja","en"]'), ['english', 'japanese']);
  assert.deepEqual(normalizeLanguageArray('Español Latino, Inglés'), ['english', 'latino']);
});

test('normalizeLanguageArray: latino vs castellano', () => {
  assert.deepEqual(normalizeLanguageArray(['Español Latino']), ['latino']);
  assert.deepEqual(normalizeLanguageArray(['Español']), ['spanish']);
  assert.deepEqual(normalizeLanguageArray(['es-419']), ['latino']);
  assert.deepEqual(normalizeLanguageArray(['es-ES']), ['spanish']);
  assert.deepEqual(normalizeLanguageArray(['lat']), ['latino']);
});

test('normalizeLanguageArray: valores no array', () => {
  assert.deepEqual(normalizeLanguageArray(null), []);
  assert.deepEqual(normalizeLanguageArray(undefined), []);
  assert.deepEqual(normalizeLanguageArray(42), []);
});

test('detectTitleLanguages: multi-subs con códigos', () => {
  const r = detectTitleLanguages('- 05 [1080p][Multiple Subtitle][ENG][POR-BR][SPA-LA][SPA]', { audio: ['japanese'], subtitles: ['english'] });
  assert.deepEqual(r.audio, ['japanese']);
  assert.deepEqual(r.subtitles, ['english', 'latino', 'portuguese', 'spanish']);
  assert.equal(r.multiSubs, true);
});

test('detectTitleLanguages: VOSE y dual', () => {
  const r = detectTitleLanguages('2020 1080p Dual Castellano Ingles VOSE');
  assert.deepEqual(r.audio, ['english', 'spanish']);
  assert.deepEqual(r.subtitles, ['spanish']);
  assert.equal(r.dual, true);
  assert.equal(r.original, true);
});

test('detectTitleLanguages: no confunde palabras en minúsculas con códigos', () => {
  assert.deepEqual(detectTitleLanguages('the cast of the show').audio, []);
  assert.deepEqual(detectTitleLanguages('the spa of the day').audio, []);
  assert.deepEqual(detectTitleLanguages('[CAST]').audio, ['spanish']);
  assert.deepEqual(detectTitleLanguages('1080p.BluRay.spa').audio, ['spanish']);
  assert.deepEqual(detectTitleLanguages('1080p WEB vose').subtitles, ['spanish']);
});

test('classifyLanguage', () => {
  assert.deepEqual(classifyLanguage({ audio: ['spanish'], subtitles: [] }), { spanish: true, english: false, other: false, unknown: false });
  assert.deepEqual(classifyLanguage({ audio: ['japanese'], subtitles: ['spanish'] }), { spanish: true, english: false, other: false, unknown: false });
  assert.deepEqual(classifyLanguage({ audio: ['japanese'], subtitles: ['english'] }), { spanish: false, english: true, other: false, unknown: false });
  assert.deepEqual(classifyLanguage({ audio: ['english', 'latino'], subtitles: [] }), { spanish: true, english: true, other: false, unknown: false });
  assert.deepEqual(classifyLanguage({ audio: [], subtitles: [] }), { spanish: false, english: false, other: false, unknown: true });
  assert.deepEqual(classifyLanguage({ audio: ['japanese'], subtitles: [] }), { spanish: false, english: false, other: false, unknown: true });
  assert.deepEqual(classifyLanguage({ audio: ['french'], subtitles: ['french'] }), { spanish: false, english: false, other: true, unknown: false });
});

test('sameLanguageArray', () => {
  assert.equal(sameLanguageArray(['a', 'b'], ['a', 'b']), true);
  assert.equal(sameLanguageArray(['a'], ['a', 'b']), false);
  assert.equal(sameLanguageArray(null, []), true);
});
