'use strict';

// Unit tests for computeVerdict — the "is the AI paying off?" grade. Pure
// function, so no fixture/server needed. Covers each headline branch and the
// honest boundaries: output is never graded, and nothing is graded with no spend.

const { test } = require('node:test');
const assert = require('node:assert');
const { computeVerdict, VERDICT } = require('../server.js');

const baseOutput = { commits: 5, prs: 1, filesEdited: 8, costPerCommit: 20, costPerFile: 12.5 };

test('no spend → nothing to grade', () => {
  assert.equal(computeVerdict({ cost: 0, output: baseOutput }), null);
});

test('no plan fee → value ungraded; verdict leans on efficiency', () => {
  const v = computeVerdict({ cost: 100, cacheHitRate: 0.8, wastedCost: 2, output: baseOutput, planFee: null, rangeDays: 7 });
  assert.equal(v.value, null);
  assert.equal(v.efficiency.tone, 'good');     // 80% cache, 2% friction → lean
  assert.equal(v.status, 'lean_no_fee');
  assert.equal(v.tone, 'good');
  assert.equal(v.output.tone, 'info');          // output is never graded
});

test('strong leverage + lean spend → paying off', () => {
  const v = computeVerdict({ cost: 600, cacheHitRate: 0.85, wastedCost: 12, output: baseOutput, planFee: 200, rangeDays: 30 });
  assert.ok(v.value.leverage >= VERDICT.leverageStrong, 'leverage clears the strong bar');
  assert.equal(v.value.tone, 'good');
  assert.equal(v.efficiency.tone, 'good');
  assert.equal(v.status, 'paying_off');
  assert.equal(v.tone, 'good');
});

test('usage below the prorated fee → below_fee / warn', () => {
  const v = computeVerdict({ cost: 50, cacheHitRate: 0.8, wastedCost: 1, output: baseOutput, planFee: 200, rangeDays: 30 });
  assert.ok(v.value.leverage < VERDICT.leverageOk);
  assert.equal(v.value.tone, 'warn');
  assert.equal(v.status, 'below_fee');
  assert.equal(v.tone, 'warn');
});

test('high friction → worth a look, even with good leverage', () => {
  const v = computeVerdict({ cost: 600, cacheHitRate: 0.3, wastedCost: 200, output: baseOutput, planFee: 200, rangeDays: 30 });
  assert.equal(v.value.tone, 'good');           // leverage still strong
  assert.equal(v.efficiency.tone, 'warn');      // 33% friction + 30% cache → leaky
  assert.equal(v.status, 'worth_a_look');
  assert.equal(v.tone, 'warn');
});

test('fee is prorated across the range (7d of a monthly fee)', () => {
  const v = computeVerdict({ cost: 100, cacheHitRate: 0.6, wastedCost: 10, output: baseOutput, planFee: 200, rangeDays: 7 });
  const expectedFee = 200 * (7 / VERDICT.avgMonthDays);
  assert.ok(Math.abs(v.value.proratedFee - expectedFee) < 1e-9);
  assert.ok(Math.abs(v.value.leverage - 100 / expectedFee) < 1e-9);
});

// --- Direction (v2): spend-efficiency trend vs the prior equal-length period ---

test('direction: leaner than the prior period → improving', () => {
  const v = computeVerdict({ cost: 100, cacheHitRate: 0.8, wastedCost: 2, output: baseOutput, planFee: 200, rangeDays: 30,
    prev: { cacheHitRate: 0.5, friction: 0.10 } }); // score 0.78 vs 0.40
  assert.equal(v.direction.trend, 'improving');
  assert.equal(v.direction.tone, 'good');
});

test('direction: leakier than the prior period → worsening', () => {
  const v = computeVerdict({ cost: 100, cacheHitRate: 0.5, wastedCost: 20, output: baseOutput, planFee: 200, rangeDays: 30,
    prev: { cacheHitRate: 0.8, friction: 0.02 } }); // score 0.30 vs 0.78
  assert.equal(v.direction.trend, 'worsening');
  assert.equal(v.direction.tone, 'warn');
});

test('direction: within the margin → steady', () => {
  const v = computeVerdict({ cost: 100, cacheHitRate: 0.60, wastedCost: 5, output: baseOutput, planFee: 200, rangeDays: 30,
    prev: { cacheHitRate: 0.60, friction: 0.07 } }); // score 0.55 vs 0.53, |Δ| < margin
  assert.equal(v.direction.trend, 'steady');
  assert.equal(v.direction.tone, 'ok');
});

test('direction: null with no prior period to compare', () => {
  const v = computeVerdict({ cost: 100, cacheHitRate: 0.8, wastedCost: 2, output: baseOutput, planFee: 200, rangeDays: 30 });
  assert.equal(v.direction, null);
});
