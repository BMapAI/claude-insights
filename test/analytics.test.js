'use strict';

// Tests for the activity-analytics helpers: UTC hour/weekday bucketing and the
// per-day × hour activity grid. Cost assertions compare against priceBundles() of
// the same tokens rather than hardcoded dollars, so they hold under any pricing.json.

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

test('emptyHourRow is a fresh 24-cell row of independent cells', () => {
  const row = L.emptyHourRow();
  assert.equal(row.length, 24);
  // Cells must not be shared references (a classic Array.fill bug).
  row[0].messages = 5;
  assert.equal(row[1].messages, 0);
});

test('accumulateDayHours lands tokens in the right date + hour', () => {
  const dh = {};
  const b = L.emptyBundle();
  b.input = 1000;
  b.output = 500;
  L.accumulateDayHours(dh, '2026-06-08', { hours: { 10: { messages: 3, byFamily: { opus: b } } } });
  const priced = L.priceHourly(dh);

  assert.ok(priced['2026-06-08'], 'the date is present, keyed by its actual day');
  assert.equal(priced['2026-06-08'].cost.length, 24);
  assert.equal(priced['2026-06-08'].messages[10], 3);

  const expect = L.priceBundles({ opus: b }).cost;
  assert.ok(Math.abs(priced['2026-06-08'].cost[10] - expect) < 1e-9, 'cell priced like its bundle');
  assert.ok(expect > 0);
  assert.equal(priced['2026-06-08'].cost[11], 0); // untouched hour stays zero
});

test('accumulateDayHours sums repeated hours within a day but keeps days separate', () => {
  const dh = {};
  const mk = (inTok) => {
    const b = L.emptyBundle();
    b.input = inTok;
    return { hours: { 9: { messages: 1, byFamily: { opus: b } } } };
  };
  L.accumulateDayHours(dh, '2026-06-08', mk(1000));
  L.accumulateDayHours(dh, '2026-06-08', mk(1000)); // same date + hour → sums
  L.accumulateDayHours(dh, '2026-06-09', mk(1000)); // different date → its own row
  const priced = L.priceHourly(dh);

  const combined = L.emptyBundle();
  combined.input = 2000;
  assert.ok(Math.abs(priced['2026-06-08'].cost[9] - L.priceBundles({ opus: combined }).cost) < 1e-9);
  assert.equal(priced['2026-06-08'].messages[9], 2);
  assert.equal(priced['2026-06-09'].messages[9], 1);
});

test('accumulateDayHours tolerates a day with no hours bucket', () => {
  const dh = {};
  assert.doesNotThrow(() => L.accumulateDayHours(dh, '2026-06-09', {}));
  const priced = L.priceHourly(dh);
  assert.equal(priced['2026-06-09'].cost[0], 0);
});

test('reliabilityStats computes per-tool rates, totals, and recovery spend', () => {
  const tools = { Edit: 100, Bash: 50, Read: 200 };
  const toolErrors = { Edit: 10, Bash: 5 };
  const followup = { opus: L.emptyBundle() };
  followup.opus.output = 1000;

  const r = L.reliabilityStats(tools, toolErrors, followup);
  assert.equal(r.totalCalls, 350);
  assert.equal(r.totalErrors, 15);
  assert.ok(Math.abs(r.errorRate - 15 / 350) < 1e-9);
  assert.ok(Math.abs(r.wastedCost - L.priceBundles(followup).cost) < 1e-9);
  assert.ok(r.wastedCost > 0);

  // Only tools with ≥1 error are listed, worst (most errors) first.
  assert.deepEqual(r.byTool.map((t) => t.name), ['Edit', 'Bash']);
  assert.ok(Math.abs(r.byTool[0].rate - 0.1) < 1e-9);
});

test('reliabilityStats counts errors for tools that were never seen as a tool_use', () => {
  // An error whose tool_use id never matched lands under "unknown" with calls=0.
  const r = L.reliabilityStats({ Read: 5 }, { unknown: 3 }, {});
  assert.equal(r.totalErrors, 3);
  assert.equal(r.totalCalls, 5);
  const unknown = r.byTool.find((t) => t.name === 'unknown');
  assert.ok(unknown && unknown.calls === 0 && unknown.errors === 3);
});

test('reliabilityStats is all-zero / empty for clean input', () => {
  const r = L.reliabilityStats({ Read: 5 }, {}, {});
  assert.equal(r.totalErrors, 0);
  assert.equal(r.errorRate, 0);
  assert.equal(r.wastedCost, 0);
  assert.deepEqual(r.byTool, []);
});

test('timeStats computes totals, median/p90, $/hour, and the histogram', () => {
  const durations = [10000, 20000, 30000, 40000, 50000, 60000, 70000, 80000, 90000, 100000];
  const cost = 36.67;
  const t = L.timeStats(durations, 5, cost);
  assert.equal(t.turns, 10);
  assert.equal(t.totalMs, 550000);
  assert.equal(t.avgMs, 55000);
  assert.equal(t.medianMs, 60000); // arr[floor(0.5*10)] = arr[5]
  assert.equal(t.p90Ms, 100000); // arr[floor(0.9*10)] = arr[9]
  assert.equal(t.perPromptMs, 110000); // 550000 / 5 prompts
  assert.ok(Math.abs(t.costPerHour - cost / (550000 / 3600000)) < 1e-9);

  const byLabel = Object.fromEntries(t.hist.map((h) => [h.label, h.count]));
  assert.equal(byLabel['<10s'], 0); // 10000 is not < 10000
  assert.equal(byLabel['10–30s'], 2);
  assert.equal(byLabel['30–60s'], 3);
  assert.equal(byLabel['1–3m'], 5);
  assert.equal(t.hist.reduce((s, h) => s + h.count, 0), 10);
});

test('timeStats is zeroed for empty input', () => {
  const t = L.timeStats([], 0, 0);
  assert.equal(t.turns, 0);
  assert.equal(t.totalMs, 0);
  assert.equal(t.avgMs, 0);
  assert.equal(t.medianMs, 0);
  assert.equal(t.p90Ms, 0);
  assert.equal(t.costPerHour, 0);
  assert.equal(t.hist.reduce((s, h) => s + h.count, 0), 0);
});

test('aggregateSession rolls up byEntry / byModel / toolErrors / errorFollowup across days', () => {
  const bundle = (o) => ({ ...L.emptyBundle(), ...o });
  const session = {
    days: {
      '2026-01-01': {
        userPrompts: 1, assistantMessages: 2, toolUses: 2,
        tools: { Bash: 2 },
        byFamily: { opus: bundle({ input: 100 }) },
        byModel: { 'claude-opus-4-8': { opus: bundle({ input: 100 }) } },
        byEntry: { cli: { opus: bundle({ input: 100 }) } },
        toolErrors: { Bash: 1 },
        errorFollowup: { opus: bundle({ output: 10 }) },
      },
      '2026-01-02': {
        userPrompts: 0, assistantMessages: 1, toolUses: 0,
        tools: {},
        byFamily: { opus: bundle({ input: 50 }) },
        byModel: { 'claude-opus-4-8': { opus: bundle({ input: 50 }) } },
        byEntry: { 'sdk-cli': { opus: bundle({ input: 50 }) } },
        toolErrors: {},
        errorFollowup: {},
      },
    },
  };
  const a = L.aggregateSession(session, null, null);
  assert.equal(a.byEntry.cli.opus.input, 100);
  assert.equal(a.byEntry['sdk-cli'].opus.input, 50);
  assert.equal(a.byModel['claude-opus-4-8'].opus.input, 150);
  assert.equal(a.toolErrors.Bash, 1);
  assert.equal(a.errorFollowup.opus.output, 10);

  // Date filtering still applies to the new maps.
  const day1 = L.aggregateSession(session, '2026-01-01', '2026-01-01');
  assert.equal(day1.byEntry.cli.opus.input, 100);
  assert.equal(day1.byEntry['sdk-cli'], undefined);
});
