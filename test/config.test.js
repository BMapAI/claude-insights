'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point pricing at a temp file BEFORE requiring server.js (PRICING_FILE is read
// once at module load). Each test rewrites it and bumps mtime to bust the cache.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-pricing-'));
const PRICING_FILE = path.join(TMP, 'pricing.json');
process.env.PRICING_FILE = PRICING_FILE;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const { validatePricing, getPricing, pricingIsFromFile, DEFAULT_PRICING } = require('../server.js');

let mtime = 1_000_000; // seconds; bumped each write so mtime-keyed cache reloads
function writePricing(obj) {
  fs.writeFileSync(PRICING_FILE, typeof obj === 'string' ? obj : JSON.stringify(obj));
  mtime += 1000;
  fs.utimesSync(PRICING_FILE, mtime, mtime);
}

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// --- validatePricing (pure) -------------------------------------------------
test('validatePricing accepts a full valid config', () => {
  assert.deepEqual(validatePricing(DEFAULT_PRICING), []);
});

test('validatePricing accepts partial overrides', () => {
  assert.deepEqual(validatePricing({ opus: { input: 10 } }), []);
  assert.deepEqual(validatePricing({ cacheReadMultiplier: 0.2 }), []);
  assert.deepEqual(validatePricing({}), []);
});

test('validatePricing ignores unknown keys like _comment', () => {
  assert.deepEqual(validatePricing({ _comment: 'hi', opus: { input: 5, output: 25 } }), []);
});

test('validatePricing rejects non-object top-level values', () => {
  assert.equal(validatePricing(null).length, 1);
  assert.equal(validatePricing([]).length, 1);
  assert.equal(validatePricing('nope').length, 1);
  assert.equal(validatePricing(42).length, 1);
});

test('validatePricing rejects negative, non-finite, and non-numeric rates', () => {
  assert.ok(validatePricing({ opus: { input: -1 } }).length > 0);
  assert.ok(validatePricing({ opus: { output: 'free' } }).length > 0);
  assert.ok(validatePricing({ sonnet: { input: Infinity } }).length > 0);
  assert.ok(validatePricing({ haiku: { input: NaN } }).length > 0);
});

test('validatePricing rejects a non-object family and bad multipliers', () => {
  assert.ok(validatePricing({ opus: 5 }).length > 0);
  assert.ok(validatePricing({ cacheReadMultiplier: -0.1 }).length > 0);
  assert.ok(validatePricing({ cacheWrite1hMultiplier: 'x' }).length > 0);
});

test('validatePricing reports one error per offending field', () => {
  const errs = validatePricing({ opus: { input: -1, output: -2 } });
  assert.equal(errs.length, 2);
});

// --- loader integration -----------------------------------------------------
test('getPricing merges a valid file over defaults and reports fromFile', () => {
  writePricing({ opus: { input: 99 } });
  const p = getPricing();
  assert.equal(p.opus.input, 99);
  assert.equal(p.opus.output, DEFAULT_PRICING.opus.output); // unspecified → default
  assert.equal(p.sonnet.input, DEFAULT_PRICING.sonnet.input);
  assert.equal(pricingIsFromFile(), true);
});

test('getPricing falls back to defaults (and fromFile=false) on malformed JSON', () => {
  writePricing('{ this is not json');
  assert.deepEqual(getPricing(), DEFAULT_PRICING);
  assert.equal(pricingIsFromFile(), false);
});

test('getPricing falls back to defaults on invalid values', () => {
  writePricing({ opus: { input: -5 } });
  assert.deepEqual(getPricing(), DEFAULT_PRICING);
  assert.equal(pricingIsFromFile(), false);
});

test('getPricing recovers once the file is fixed', () => {
  writePricing({ opus: { input: -5 } });
  assert.equal(pricingIsFromFile(), false);
  writePricing({ opus: { input: 7 } });
  assert.equal(getPricing().opus.input, 7);
  assert.equal(pricingIsFromFile(), true);
});
