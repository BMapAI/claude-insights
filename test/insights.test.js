'use strict';

// Tests for computeInsights — the "worth a look" signal engine. Each detector
// should fire only past its threshold, signals rank by dollar impact, and the
// list caps at 5. Inputs mirror the shapes overview() / projectDetail() pass in.

const { test } = require('node:test');
const assert = require('node:assert');
const L = require('../server.js');

const kinds = (v) => L.computeInsights(v).map((s) => s.kind);

test('flags a spend-spike day (>=2.5x median, >=4 active days)', () => {
  const daily = [{ date: 'a', cost: 5 }, { date: 'b', cost: 6 }, { date: 'c', cost: 5 }, { date: 'd', cost: 40 }];
  const spike = L.computeInsights({ totals: { cost: 56 }, daily }).find((s) => s.kind === 'spike');
  assert.ok(spike);
  assert.equal(spike.tone, 'warn');
  assert.match(spike.detail, /median active day/);
});

test('no spike on flat days, and it needs >=4 active days', () => {
  assert.deepEqual(kinds({ totals: { cost: 20 }, daily: [{ date: 'a', cost: 5 }, { date: 'b', cost: 5 }, { date: 'c', cost: 5 }, { date: 'd', cost: 5 }] }), []);
  assert.deepEqual(kinds({ totals: { cost: 45 }, daily: [{ date: 'a', cost: 5 }, { date: 'b', cost: 40 }] }), []); // only 2 active days
});

test('flags concentration when one project is >=60% of spend', () => {
  assert.ok(kinds({ totals: { cost: 100 }, projects: [{ name: 'big', cost: 70 }, { name: 'x', cost: 30 }] }).includes('concentration'));
  assert.ok(!kinds({ totals: { cost: 100 }, projects: [{ name: 'a', cost: 55 }, { name: 'b', cost: 45 }] }).includes('concentration'));
});

test('flags a pricey session (>=3x median, >=4 sessions)', () => {
  const sessions = [{ title: 's1', cost: 2 }, { title: 's2', cost: 3 }, { title: 's3', cost: 2 }, { title: 'big', cost: 30 }];
  assert.ok(L.computeInsights({ totals: { cost: 37 }, sessions }).find((s) => s.kind === 'session'));
});

test('flags recovery spend, and trend direction sets the tone', () => {
  assert.ok(L.computeInsights({ totals: { cost: 100 }, reliability: { wastedCost: 10, totalErrors: 5 } }).find((s) => s.kind === 'recovery' && s.tone === 'warn'));
  assert.equal(L.computeInsights({ totals: { cost: 100 }, delta: { costPct: 0.6, costChange: 30, days: 7 } }).find((s) => s.kind === 'trend').tone, 'warn');
  assert.equal(L.computeInsights({ totals: { cost: 100 }, delta: { costPct: -0.6, costChange: -30, days: 7 } }).find((s) => s.kind === 'trend').tone, 'good');
  assert.deepEqual(kinds({ totals: { cost: 100 }, delta: { costPct: 0.1, costChange: 5, days: 7 } }), []); // small move ignored
});

test('flags heavy automation and unrecognized models past their thresholds', () => {
  assert.ok(kinds({ totals: { cost: 100 }, topEntrypoints: [{ name: 'cli', cost: 40 }, { name: 'sdk-cli', cost: 60 }] }).includes('automation'));
  assert.ok(!kinds({ totals: { cost: 100 }, topEntrypoints: [{ name: 'cli', cost: 70 }, { name: 'sdk-cli', cost: 30 }] }).includes('automation'));
  assert.ok(kinds({ totals: { cost: 100 }, topModels: [{ name: 'x', cost: 8, unknown: true }, { name: 'claude-opus-4-8', cost: 92 }] }).includes('unknown-model'));
  assert.ok(!kinds({ totals: { cost: 100 }, topModels: [{ name: 'x', cost: 2, unknown: true }, { name: 'y', cost: 98 }] }).includes('unknown-model'));
});

test('ranks by dollar impact and caps the list at 5', () => {
  const ins = L.computeInsights({
    totals: { cost: 200 },
    daily: [{ date: 'a', cost: 5 }, { date: 'b', cost: 6 }, { date: 'c', cost: 5 }, { date: 'd', cost: 60 }],
    projects: [{ name: 'big', cost: 150 }, { name: 'x', cost: 50 }],
    reliability: { wastedCost: 9, totalErrors: 6 },
    delta: { costPct: 0.8, costChange: 40, days: 7 },
    topEntrypoints: [{ name: 'cli', cost: 80 }, { name: 'sdk-cli', cost: 120 }],
    topModels: [{ name: 'x', cost: 20, unknown: true }, { name: 'o', cost: 180, unknown: false }],
  });
  assert.ok(ins.length <= 5);
  for (let i = 1; i < ins.length; i++) assert.ok(ins[i - 1].sev >= ins[i].sev); // descending
  assert.equal(ins[0].kind, 'concentration'); // $150 is the biggest impact
});

test('empty / unusual-free input yields no signals', () => {
  assert.deepEqual(L.computeInsights({ totals: { cost: 0 } }), []);
  assert.deepEqual(L.computeInsights({}), []);
});

// --- Batch 1–4 signals wired into the insight engine ------------------------
test('flags subagent-heavy spend past 45% of cost (dollar-valued)', () => {
  const ins = L.computeInsights({ totals: { cost: 100 }, topAgentKinds: [{ name: 'main', cost: 40 }, { name: 'subagent', cost: 60 }] });
  const sub = ins.find((s) => s.kind === 'subagent');
  assert.ok(sub && sub.sev === 60, 'severity is the subagent dollar cost');
  assert.ok(!kinds({ totals: { cost: 100 }, topAgentKinds: [{ name: 'main', cost: 70 }, { name: 'subagent', cost: 30 }] }).includes('subagent'));
});

test('flags web-tool spend above the floor, ignores trivial usage', () => {
  const web = L.computeInsights({ totals: { cost: 100 }, signals: { webSearch: 50, webFetch: 0, webCost: 5, truncated: 0, truncationRate: 0, compactions: 0 } }).find((s) => s.kind === 'web');
  assert.ok(web && web.sev === 5);
  assert.ok(!kinds({ totals: { cost: 100 }, signals: { webSearch: 1, webFetch: 0, webCost: 0.1, truncated: 0, truncationRate: 0, compactions: 0 } }).includes('web'));
});

test('flags truncated turns (>=3 and >=2%) and frequent compaction (>=3)', () => {
  assert.ok(kinds({ totals: { cost: 100 }, signals: { truncated: 5, truncationRate: 0.1, compactions: 0, webSearch: 0, webFetch: 0, webCost: 0 } }).includes('truncation'));
  assert.ok(!kinds({ totals: { cost: 100 }, signals: { truncated: 2, truncationRate: 0.5, compactions: 0, webSearch: 0, webFetch: 0, webCost: 0 } }).includes('truncation'));
  assert.ok(kinds({ totals: { cost: 100 }, signals: { compactions: 4, compactAvgPreTokens: 500000, truncated: 0, truncationRate: 0, webSearch: 0, webFetch: 0, webCost: 0 } }).includes('compaction'));
  assert.ok(!kinds({ totals: { cost: 100 }, signals: { compactions: 2, truncated: 0, truncationRate: 0, webSearch: 0, webFetch: 0, webCost: 0 } }).includes('compaction'));
});

// --- Prescriptive actions ---------------------------------------------------
// Actionable signals carry a suggested next step; purely-informational ones don't.
const actionFor = (kind, v) => (L.computeInsights(v).find((s) => s.kind === kind) || {}).action;

test('actionable signals carry a suggested next step', () => {
  assert.match(actionFor('spike', { totals: { cost: 56 }, daily: [{ date: 'a', cost: 5 }, { date: 'b', cost: 6 }, { date: 'c', cost: 5 }, { date: 'd', cost: 40 }] }), /Activity/);
  assert.match(actionFor('concentration', { totals: { cost: 100 }, projects: [{ name: 'big', cost: 70 }, { name: 'x', cost: 30 }] }), /Open big/);
  assert.match(actionFor('recovery', { totals: { cost: 100 }, reliability: { wastedCost: 10, totalErrors: 5 } }), /Tool reliability/);
  assert.match(actionFor('unknown-model', { totals: { cost: 100 }, topModels: [{ name: 'x', cost: 8, unknown: true }, { name: 'claude-opus-4-8', cost: 92 }] }), /pricing\.json/);
  assert.match(actionFor('truncation', { totals: { cost: 100 }, signals: { truncated: 5, truncationRate: 0.1, compactions: 0, webSearch: 0, webFetch: 0, webCost: 0 } }), /smaller|compact/);
  assert.match(actionFor('compaction', { totals: { cost: 100 }, signals: { compactions: 4, compactAvgPreTokens: 500000, truncated: 0, truncationRate: 0, webSearch: 0, webFetch: 0, webCost: 0 } }), /fresh session/);
});

test('trending up gets an action, trending down (good news) does not', () => {
  assert.match(actionFor('trend', { totals: { cost: 100 }, delta: { costPct: 0.6, costChange: 30, days: 7 } }), /prior period/);
  assert.equal(actionFor('trend', { totals: { cost: 100 }, delta: { costPct: -0.6, costChange: -30, days: 7 } }), undefined);
});

test('purely-informational signals carry no action', () => {
  assert.equal(actionFor('automation', { totals: { cost: 100 }, topEntrypoints: [{ name: 'cli', cost: 40 }, { name: 'sdk-cli', cost: 60 }] }), undefined);
  assert.equal(actionFor('concurrency', { totals: { cost: 100 }, concurrency: { maxConcurrent: 6, parallelSessions: 10, totalSessions: 12 } }), undefined);
  assert.equal(actionFor('subagent', { totals: { cost: 100 }, topAgentKinds: [{ name: 'main', cost: 40 }, { name: 'subagent', cost: 60 }] }), undefined);
});

test('flags high session concurrency at >=4 max concurrent', () => {
  assert.ok(kinds({ totals: { cost: 100 }, concurrency: { maxConcurrent: 6, parallelSessions: 10, totalSessions: 12 } }).includes('concurrency'));
  assert.ok(!kinds({ totals: { cost: 100 }, concurrency: { maxConcurrent: 2, parallelSessions: 1, totalSessions: 5 } }).includes('concurrency'));
});

test('dollar insights still outrank the sev-0 signal notes', () => {
  // A subagent ($) and a truncation note (sev 0) together: subagent ranks first.
  const ins = L.computeInsights({
    totals: { cost: 100 },
    topAgentKinds: [{ name: 'main', cost: 30 }, { name: 'subagent', cost: 70 }],
    signals: { truncated: 9, truncationRate: 0.3, compactions: 5, webSearch: 0, webFetch: 0, webCost: 0 },
  });
  assert.equal(ins[0].kind, 'subagent', 'the dollar insight sorts above sev-0 notes');
  assert.ok(ins.some((s) => s.kind === 'truncation') && ins.some((s) => s.kind === 'compaction'));
});
