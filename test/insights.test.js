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
