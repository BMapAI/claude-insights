'use strict';

// Tests for the activity-analytics helpers: UTC hour/weekday bucketing and the
// weekday × hour punchcard. Cost assertions compare against priceBundles() of the
// same tokens rather than hardcoded dollars, so they hold under any pricing.json.

const test = require('node:test');
const assert = require('node:assert');
const L = require('../server.js');

test('hourOf slices the UTC hour straight from an ISO-Z timestamp', () => {
  assert.equal(L.hourOf('2026-06-09T14:23:01.000Z'), 14);
  assert.equal(L.hourOf('2026-06-09T00:00:00Z'), 0);
  assert.equal(L.hourOf('2026-06-09T23:59:59Z'), 23);
});

test('hourOf falls back to 0 for missing or malformed timestamps', () => {
  assert.equal(L.hourOf(null), 0);
  assert.equal(L.hourOf(''), 0);
  assert.equal(L.hourOf('not-a-timestamp'), 0);
  assert.equal(L.hourOf('2026-06-09T99:00:00Z'), 0); // hour out of range
  assert.equal(L.hourOf(12345), 0); // non-string
});

test('weekdayOf returns the UTC day-of-week (0=Sun … 6=Sat)', () => {
  assert.equal(L.weekdayOf('2026-06-07'), 0); // Sunday
  assert.equal(L.weekdayOf('2026-06-08'), 1); // Monday
  assert.equal(L.weekdayOf('2026-06-09'), 2); // Tuesday
});

test('emptyPunchGrid is a fresh 7×24 grid of independent cells', () => {
  const grid = L.emptyPunchGrid();
  assert.equal(grid.length, 7);
  assert.equal(grid[0].length, 24);
  // Cells must not be shared references (a classic Array.fill bug).
  grid[0][0].messages = 5;
  assert.equal(grid[0][1].messages, 0);
  assert.equal(grid[1][0].messages, 0);
});

test('accumulatePunchcard lands tokens in the day\'s weekday row + hour column', () => {
  const grid = L.emptyPunchGrid();
  const b = L.emptyBundle();
  b.input = 1000;
  b.output = 500;
  // 2026-06-08 is a Monday (weekday 1); activity recorded at hour 10.
  L.accumulatePunchcard(grid, '2026-06-08', { hours: { 10: { messages: 3, byFamily: { opus: b } } } });
  const priced = L.pricePunchcard(grid);

  assert.equal(priced.cost.length, 7);
  assert.equal(priced.cost[0].length, 24);
  assert.equal(priced.messages[1][10], 3);

  const expect = L.priceBundles({ opus: b }).cost;
  assert.ok(Math.abs(priced.cost[1][10] - expect) < 1e-9, 'cell priced like its bundle');
  assert.ok(expect > 0);
  // Untouched cells stay zero.
  assert.equal(priced.cost[1][11], 0);
  assert.equal(priced.messages[2][10], 0);
});

test('accumulatePunchcard sums days that fall on the same weekday', () => {
  const grid = L.emptyPunchGrid();
  const mk = (inTok) => {
    const b = L.emptyBundle();
    b.input = inTok;
    return { hours: { 9: { messages: 1, byFamily: { opus: b } } } };
  };
  // 2026-06-08 and 2026-06-15 are both Mondays.
  L.accumulatePunchcard(grid, '2026-06-08', mk(1000));
  L.accumulatePunchcard(grid, '2026-06-15', mk(1000));
  const priced = L.pricePunchcard(grid);

  const combined = L.emptyBundle();
  combined.input = 2000;
  assert.ok(Math.abs(priced.cost[1][9] - L.priceBundles({ opus: combined }).cost) < 1e-9);
  assert.equal(priced.messages[1][9], 2);
});

test('accumulatePunchcard tolerates a day with no hours bucket', () => {
  const grid = L.emptyPunchGrid();
  assert.doesNotThrow(() => L.accumulatePunchcard(grid, '2026-06-09', {}));
  const priced = L.pricePunchcard(grid);
  assert.equal(priced.cost[2][0], 0);
});
