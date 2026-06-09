'use strict';

// Force built-in defaults so these tests don't depend on the user's pricing.json.
process.env.PRICING_FILE = '/claude-ledger-nonexistent-pricing.json';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_PRICING,
  getPricing,
  modelFamily,
  emptyBundle,
  addBundle,
  usageToBundle,
  priceBundles,
  priceByName,
  efficiencyStats,
  nestFam,
  mergeByName,
} = require('../server.js');

const P = DEFAULT_PRICING;

test('getPricing falls back to defaults when the file is missing', () => {
  assert.deepEqual(getPricing(), DEFAULT_PRICING);
});

// --- modelFamily ------------------------------------------------------------
test('modelFamily maps known model names to families', () => {
  assert.equal(modelFamily('claude-opus-4-8'), 'opus');
  assert.equal(modelFamily('claude-sonnet-4-6'), 'sonnet');
  assert.equal(modelFamily('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(modelFamily('CLAUDE-OPUS'), 'opus'); // case-insensitive
});

test('modelFamily defaults unknown / empty models to opus', () => {
  assert.equal(modelFamily('gpt-4'), 'opus');
  assert.equal(modelFamily(''), 'opus');
  assert.equal(modelFamily(null), 'opus');
  assert.equal(modelFamily(undefined), 'opus');
});

// --- usageToBundle ----------------------------------------------------------
test('usageToBundle returns an empty bundle for missing usage', () => {
  assert.deepEqual(usageToBundle(null), emptyBundle());
  assert.deepEqual(usageToBundle(undefined), emptyBundle());
});

test('usageToBundle reads plain input/output/cacheRead', () => {
  const b = usageToBundle({
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 200,
  });
  assert.equal(b.input, 100);
  assert.equal(b.output, 50);
  assert.equal(b.cacheRead, 200);
  assert.equal(b.cw5, 0);
  assert.equal(b.cw1, 0);
  assert.equal(b.cwOther, 0);
});

test('usageToBundle splits 5m/1h cache writes when present', () => {
  const b = usageToBundle({
    cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 70 },
    cache_creation_input_tokens: 999, // ignored once the split is present
  });
  assert.equal(b.cw5, 30);
  assert.equal(b.cw1, 70);
  assert.equal(b.cwOther, 0);
});

test('usageToBundle falls back to the lumped legacy field', () => {
  const b = usageToBundle({ cache_creation_input_tokens: 40 });
  assert.equal(b.cwOther, 40);
  assert.equal(b.cw5, 0);
  assert.equal(b.cw1, 0);
});

test('usageToBundle treats a zero 5m split as present (not legacy)', () => {
  // ephemeral_5m present (even as 0) means the split exists; legacy must stay 0.
  const b = usageToBundle({
    cache_creation: { ephemeral_5m_input_tokens: 0 },
    cache_creation_input_tokens: 500,
  });
  assert.equal(b.cw5, 0);
  assert.equal(b.cw1, 0);
  assert.equal(b.cwOther, 0);
});

// --- addBundle --------------------------------------------------------------
test('addBundle accumulates every field in place', () => {
  const dst = emptyBundle();
  addBundle(dst, { input: 1, output: 2, cacheRead: 3, cw5: 4, cw1: 5, cwOther: 6 });
  addBundle(dst, { input: 1, output: 2, cacheRead: 3, cw5: 4, cw1: 5, cwOther: 6 });
  assert.deepEqual(dst, { input: 2, output: 4, cacheRead: 6, cw5: 8, cw1: 10, cwOther: 12 });
});

// --- priceBundles -----------------------------------------------------------
test('priceBundles prices plain input/output at the family rate', () => {
  const b = { ...emptyBundle(), input: 1e6, output: 1e6 };
  const r = priceBundles({ opus: b });
  // 1M input * $5 + 1M output * $25 = $30
  assert.equal(r.cost, P.opus.input + P.opus.output);
  assert.equal(r.costByFamily.opus, P.opus.input + P.opus.output);
  assert.deepEqual(r.models, ['opus']);
});

test('priceBundles applies cache-read and cache-write multipliers', () => {
  const b = { ...emptyBundle(), cacheRead: 1e6, cw5: 1e6, cw1: 1e6, cwOther: 1e6 };
  const r = priceBundles({ sonnet: b });
  const inRate = P.sonnet.input; // $/1M
  const expected =
    inRate * P.cacheReadMultiplier +
    inRate * P.cacheWrite5mMultiplier +
    inRate * P.cacheWrite1hMultiplier +
    inRate * P.cacheWrite5mMultiplier; // cwOther billed at the 5m rate
  assert.ok(Math.abs(r.cost - expected) < 1e-9);
});

test('priceBundles cacheSavings reflects the discount vs full input price', () => {
  const b = { ...emptyBundle(), cacheRead: 1e6 };
  const r = priceBundles({ opus: b });
  const expected = P.opus.input * (1 - P.cacheReadMultiplier);
  assert.ok(Math.abs(r.cacheSavings - expected) < 1e-9);
});

test('priceBundles sums multiple families and tracks token totals', () => {
  const r = priceBundles({
    opus: { ...emptyBundle(), input: 1e6 },
    haiku: { ...emptyBundle(), output: 1e6 },
  });
  assert.equal(r.cost, P.opus.input + P.haiku.output);
  assert.equal(r.tokens.input, 1e6);
  assert.equal(r.tokens.output, 1e6);
  assert.equal(r.models.length, 2);
});

test('priceBundles prices an unknown family at the opus rate', () => {
  const b = { ...emptyBundle(), input: 1e6 };
  const r = priceBundles({ mystery: b });
  assert.equal(r.cost, P.opus.input);
});

test('priceBundles returns zero for an empty map', () => {
  const r = priceBundles({});
  assert.equal(r.cost, 0);
  assert.equal(r.cacheSavings, 0);
  assert.deepEqual(r.models, []);
});

// --- priceByName ------------------------------------------------------------
test('priceByName returns a list sorted by descending cost', () => {
  const byName = {
    cheap: { haiku: { ...emptyBundle(), input: 1e6 } }, // $1
    pricey: { opus: { ...emptyBundle(), output: 1e6 } }, // $25
  };
  const list = priceByName(byName);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'pricey');
  assert.equal(list[1].name, 'cheap');
  assert.equal(list[0].cost, P.opus.output);
  assert.equal(list[1].tokens, 1e6);
});

// --- nestFam / mergeByName --------------------------------------------------
test('nestFam lazily creates name/family slots', () => {
  const map = {};
  const slot = nestFam(map, 'skill-a', 'opus');
  assert.deepEqual(slot, emptyBundle());
  // Returns the same object on a second call (so callers accumulate into it).
  assert.equal(nestFam(map, 'skill-a', 'opus'), slot);
});

test('mergeByName deep-adds one attribution map into another', () => {
  const dst = {};
  const src = {
    'skill-a': { opus: { ...emptyBundle(), input: 10 } },
    'skill-b': { sonnet: { ...emptyBundle(), output: 5 } },
  };
  mergeByName(dst, src);
  mergeByName(dst, src);
  assert.equal(dst['skill-a'].opus.input, 20);
  assert.equal(dst['skill-b'].sonnet.output, 10);
});

// --- efficiencyStats --------------------------------------------------------
test('efficiencyStats computes cache hit rate over the input side', () => {
  const grand = { opus: { ...emptyBundle(), input: 100, cacheRead: 300, cacheWrite: 0 } };
  const eff = efficiencyStats(grand, 1, 0);
  // cacheRead / (input + cacheRead + cacheWrite) = 300 / 400
  assert.ok(Math.abs(eff.cacheHitRate - 0.75) < 1e-9);
});

test('efficiencyStats whatIf reprices identical tokens across families', () => {
  const grand = { opus: { ...emptyBundle(), input: 1e6, output: 1e6 } };
  const eff = efficiencyStats(grand, 4, 8);
  assert.equal(eff.whatIf.opus, P.opus.input + P.opus.output);
  assert.equal(eff.whatIf.sonnet, P.sonnet.input + P.sonnet.output);
  assert.equal(eff.whatIf.haiku, P.haiku.input + P.haiku.output);
  // Per-prompt ratios.
  assert.equal(eff.tokensPerPrompt, 2e6 / 4);
  assert.equal(eff.toolsPerPrompt, 8 / 4);
});

test('efficiencyStats guards against divide-by-zero on empty input', () => {
  const eff = efficiencyStats({}, 0, 0);
  assert.equal(eff.cacheHitRate, 0);
  assert.equal(eff.blendedPerMtok, 0);
  assert.equal(eff.outputShare, 0);
  assert.equal(eff.tokensPerPrompt, 0);
  assert.equal(eff.toolsPerPrompt, 0);
});

test('efficiencyStats cost composition sums to the priced cost', () => {
  const grand = {
    opus: { ...emptyBundle(), input: 1e6, output: 5e5, cacheRead: 2e6, cw5: 1e5 },
    sonnet: { ...emptyBundle(), input: 3e5, output: 1e5 },
  };
  const eff = efficiencyStats(grand, 2, 3);
  const c = eff.composition;
  const sum = c.output + c.input + c.cacheRead + c.cacheWrite;
  assert.ok(Math.abs(sum - eff.cost) < 1e-9, `composition ${sum} vs cost ${eff.cost}`);
});
