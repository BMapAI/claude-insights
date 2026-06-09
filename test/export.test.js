'use strict';

// Tests for the CSV serializer and the unknown-model flag. The CSV cases cover
// the escaping rules (comma / quote / newline) so a project title with a comma
// can't shift columns; modelFamilyKnown / pricedModels back the "priced as Opus"
// badge that flags model ids with no known pricing family.

const test = require('node:test');
const assert = require('node:assert');
const L = require('../server.js');

test('toCSV emits a header row and one row per record', () => {
  const csv = L.toCSV([{ a: 1, b: 2 }, { a: 3, b: 4 }], [
    { label: 'A', key: 'a' },
    { label: 'B', key: 'b' },
  ]);
  assert.equal(csv, 'A,B\n1,2\n3,4\n');
});

test('toCSV quotes cells containing commas, quotes, or newlines', () => {
  const csv = L.toCSV([{ t: 'a,b' }, { t: 'say "hi"' }, { t: 'line1\nline2' }], [
    { label: 'Title', key: 't' },
  ]);
  assert.equal(csv, 'Title\n"a,b"\n"say ""hi"""\n"line1\nline2"\n');
});

test('toCSV supports computed columns and blanks null/undefined', () => {
  const csv = L.toCSV([{ x: 2 }, {}], [
    { label: 'Double', value: (r) => (r.x != null ? r.x * 2 : null) },
  ]);
  assert.equal(csv, 'Double\n4\n\n');
});

test('toCSV on no rows is just the header line', () => {
  assert.equal(L.toCSV([], [{ label: 'A', key: 'a' }]), 'A\n');
});

test('csvCell escapes only when needed', () => {
  assert.equal(L.csvCell('plain'), 'plain');
  assert.equal(L.csvCell(0), '0');
  assert.equal(L.csvCell(null), '');
  assert.equal(L.csvCell('has,comma'), '"has,comma"');
});

test('modelFamilyKnown is true only for opus/sonnet/haiku ids', () => {
  assert.equal(L.modelFamilyKnown('claude-opus-4-8'), true);
  assert.equal(L.modelFamilyKnown('claude-sonnet-4-6'), true);
  assert.equal(L.modelFamilyKnown('claude-haiku-4-5-20251001'), true);
  assert.equal(L.modelFamilyKnown('some-future-model'), false);
  assert.equal(L.modelFamilyKnown(''), false);
  assert.equal(L.modelFamilyKnown(null), false);
});

test('pricedModels flags unknown ids and stays cost-sorted', () => {
  const tok = (n) => { const b = L.emptyBundle(); b.input = n; return b; };
  const list = L.pricedModels({
    'claude-opus-4-8': { opus: tok(1000) },
    'mystery-model': { opus: tok(5000) }, // unknown id, priced as opus
  });
  assert.equal(list[0].name, 'mystery-model'); // more tokens → higher cost → first
  assert.equal(list[0].unknown, true);
  assert.equal(list.find((m) => m.name === 'claude-opus-4-8').unknown, false);
});
