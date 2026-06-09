'use strict';

process.env.PRICING_FILE = '/claude-ledger-nonexistent-pricing.json';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  shiftDay,
  previousPeriod,
  makeDelta,
  currentMonthInfo,
  inRange,
  aggregateSession,
  emptyBundle,
} = require('../server.js');

// --- shiftDay ---------------------------------------------------------------
test('shiftDay moves a day forward and backward in UTC', () => {
  assert.equal(shiftDay('2026-01-15', 1), '2026-01-16');
  assert.equal(shiftDay('2026-01-15', -1), '2026-01-14');
  assert.equal(shiftDay('2026-01-15', 0), '2026-01-15');
});

test('shiftDay crosses month and year boundaries', () => {
  assert.equal(shiftDay('2026-01-31', 1), '2026-02-01');
  assert.equal(shiftDay('2026-03-01', -1), '2026-02-28'); // 2026 not a leap year
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDay('2024-02-28', 1), '2024-02-29'); // 2024 is a leap year
});

// --- previousPeriod ---------------------------------------------------------
test('previousPeriod returns the equal-length window immediately before', () => {
  // 7-day window: Jan 8..14 → previous Jan 1..7.
  const p = previousPeriod('2026-01-08', '2026-01-14');
  assert.deepEqual(p, { from: '2026-01-01', to: '2026-01-07', len: 7 });
});

test('previousPeriod handles a single-day window', () => {
  const p = previousPeriod('2026-01-10', '2026-01-10');
  assert.deepEqual(p, { from: '2026-01-09', to: '2026-01-09', len: 1 });
});

test('previousPeriod is null for an unbounded range', () => {
  assert.equal(previousPeriod(null, '2026-01-10'), null);
  assert.equal(previousPeriod('2026-01-10', null), null);
  assert.equal(previousPeriod(null, null), null);
});

test('previousPeriod is null when to precedes from', () => {
  assert.equal(previousPeriod('2026-01-10', '2026-01-01'), null);
});

// --- makeDelta --------------------------------------------------------------
test('makeDelta computes absolute and percentage changes', () => {
  const prev = { from: '2026-01-01', to: '2026-01-07', len: 7 };
  const d = makeDelta(prev, 150, 100, 30, 20);
  assert.equal(d.prevCost, 100);
  assert.equal(d.costChange, 50);
  assert.ok(Math.abs(d.costPct - 0.5) < 1e-9);
  assert.equal(d.promptsChange, 10);
  assert.ok(Math.abs(d.promptsPct - 0.5) < 1e-9);
  assert.equal(d.days, 7);
});

test('makeDelta returns null percentages when the previous total is zero', () => {
  const prev = { from: '2026-01-01', to: '2026-01-07', len: 7 };
  const d = makeDelta(prev, 80, 0, 5, 0);
  assert.equal(d.costPct, null);
  assert.equal(d.promptsPct, null);
  assert.equal(d.costChange, 80);
});

// --- currentMonthInfo -------------------------------------------------------
test('currentMonthInfo is internally consistent and UTC-based', () => {
  const m = currentMonthInfo();
  assert.match(m.monthStart, /^\d{4}-\d{2}-01$/);
  assert.match(m.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(m.daysElapsed >= 1 && m.daysElapsed <= 31);
  assert.ok(m.daysInMonth >= 28 && m.daysInMonth <= 31);
  assert.ok(m.daysElapsed <= m.daysInMonth);
  // today's day-of-month equals daysElapsed; both derive from the same UTC date.
  assert.equal(Number(m.today.slice(8, 10)), m.daysElapsed);
  assert.equal(m.today.slice(0, 7), m.monthStart.slice(0, 7));
});

// --- inRange ----------------------------------------------------------------
test('inRange respects inclusive bounds', () => {
  assert.equal(inRange('2026-01-05', '2026-01-01', '2026-01-10'), true);
  assert.equal(inRange('2026-01-01', '2026-01-01', '2026-01-10'), true); // inclusive low
  assert.equal(inRange('2026-01-10', '2026-01-01', '2026-01-10'), true); // inclusive high
  assert.equal(inRange('2025-12-31', '2026-01-01', '2026-01-10'), false);
  assert.equal(inRange('2026-01-11', '2026-01-01', '2026-01-10'), false);
});

test('inRange treats missing bounds as open-ended', () => {
  assert.equal(inRange('2026-01-05', null, null), true);
  assert.equal(inRange('2026-01-05', '2026-01-01', null), true);
  assert.equal(inRange('2026-01-05', null, '2026-01-10'), true);
  assert.equal(inRange('2025-01-05', '2026-01-01', null), false);
});

// --- aggregateSession -------------------------------------------------------
function fakeSession() {
  return {
    days: {
      '2026-01-01': {
        userPrompts: 2,
        assistantMessages: 3,
        toolUses: 4,
        tools: { Read: 2, Edit: 2 },
        byFamily: { opus: { ...emptyBundle(), input: 100, output: 50 } },
        bySkill: { 'skill-a': { opus: { ...emptyBundle(), input: 100 } } },
        byMcp: {},
      },
      '2026-01-05': {
        userPrompts: 1,
        assistantMessages: 1,
        toolUses: 1,
        tools: { Read: 1 },
        byFamily: { sonnet: { ...emptyBundle(), output: 20 } },
        bySkill: {},
        byMcp: { github: { sonnet: { ...emptyBundle(), output: 20 } } },
      },
    },
  };
}

test('aggregateSession sums all days when the range is open', () => {
  const a = aggregateSession(fakeSession(), null, null);
  assert.equal(a.has, true);
  assert.equal(a.userPrompts, 3);
  assert.equal(a.assistantMessages, 4);
  assert.equal(a.toolUses, 5);
  assert.equal(a.tools.Read, 3);
  assert.equal(a.tools.Edit, 2);
  assert.equal(a.byFamily.opus.input, 100);
  assert.equal(a.byFamily.sonnet.output, 20);
  assert.equal(a.bySkill['skill-a'].opus.input, 100);
  assert.equal(a.byMcp.github.sonnet.output, 20);
});

test('aggregateSession includes only days inside the range', () => {
  const a = aggregateSession(fakeSession(), '2026-01-01', '2026-01-03');
  assert.equal(a.has, true);
  assert.equal(a.userPrompts, 2);
  assert.equal(a.byFamily.opus.input, 100);
  assert.equal(a.byFamily.sonnet, undefined); // Jan 5 excluded
  assert.equal(a.tools.Read, 2);
});

test('aggregateSession reports has=false when nothing falls in range', () => {
  const a = aggregateSession(fakeSession(), '2026-02-01', '2026-02-28');
  assert.equal(a.has, false);
  assert.equal(a.userPrompts, 0);
  assert.deepEqual(a.byFamily, {});
});
