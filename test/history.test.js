'use strict';

// Batch 3: the sidecar sources outside projects/ — history.jsonl (command /
// prompt analytics) and plans/ (plan-mode usage). Env points at fixtures BEFORE
// requiring the server, which reads the paths at load (node --test isolates each
// test file in its own process, so this doesn't affect the other suites).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let dir, L;
const CWD_A = '/home/demo/alpha';
const CWD_B = '/home/demo/beta';

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-hist-'));
  const histFile = path.join(dir, 'history.jsonl');
  const plansDir = path.join(dir, 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const D = (day, h) => Date.UTC(2026, 2, day, h, 0, 0); // 2026-03-<day>
  const lines = [
    { display: '/clear', project: CWD_A, sessionId: 's1', timestamp: D(10, 9) },
    { display: '/clear', project: CWD_A, sessionId: 's1', timestamp: D(10, 10) },
    { display: '/code-review --high arg', project: CWD_A, sessionId: 's1', timestamp: D(11, 9), pastedContents: { a: 1 } },
    { display: 'just a normal prompt', project: CWD_A, sessionId: 's1', timestamp: D(11, 10) },
    { display: '/clear', project: CWD_B, sessionId: 's2', timestamp: D(12, 9) },
    { display: 'no timestamp prompt', project: CWD_A, sessionId: 's1' }, // unparseable ts → all-time only
  ];
  fs.writeFileSync(histFile, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  fs.writeFileSync(path.join(plansDir, 'p1.md'), '# Add OAuth login\n\nbody');
  fs.writeFileSync(path.join(plansDir, 'p2.md'), 'no heading here, just text');
  fs.writeFileSync(path.join(plansDir, 'notes.txt'), 'not markdown, ignored');

  process.env.HISTORY_FILE = histFile;
  process.env.PLANS_DIR = plansDir;
  L = require('../server.js');
});

after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('analyzeHistory: global command leaderboard + prompt counts', () => {
  const h = L.analyzeHistory('2026-03-01', '2026-03-31');
  assert.equal(h.available, true);
  assert.equal(h.prompts, 5, 'in-range prompts (the no-timestamp one is excluded)');
  assert.equal(h.commandPrompts, 4, '3x /clear + /code-review');
  assert.equal(h.pasted, 1);
  assert.equal(h.activeDays, 3, 'days 10, 11, 12');
  assert.deepEqual(h.topCommands[0], { name: '/clear', count: 3 });
  assert.equal(h.distinctCommands, 2);
});

test('analyzeHistory: scoped to one project cwd', () => {
  const h = L.analyzeHistory('2026-03-01', '2026-03-31', CWD_A);
  assert.equal(h.prompts, 4, "beta's /clear is excluded");
  assert.equal(h.topCommands.find((c) => c.name === '/clear').count, 2);
});

test('analyzeHistory: all-time includes timestamp-less entries', () => {
  const h = L.analyzeHistory(null, null);
  assert.equal(h.prompts, 6, 'the no-timestamp prompt is counted for an unbounded range');
});

test('analyzeHistory: only the command NAME is kept (no args, no prompt text)', () => {
  const h = L.analyzeHistory(null, null);
  assert.ok(h.topCommands.every((c) => /^\/[A-Za-z0-9:_-]+$/.test(c.name)), 'no args leak into command names');
  assert.ok(h.topCommands.some((c) => c.name === '/code-review'), 'command name extracted without its --high arg');
});

test('analyzeHistory: empty range degrades to zeros, not a throw', () => {
  const h = L.analyzeHistory('1999-01-01', '1999-01-02');
  assert.equal(h.prompts, 0);
  assert.deepEqual(h.topCommands, []);
});

test('analyzePlans: counts md only, uses heading then filename for title', () => {
  const p = L.analyzePlans(null, null);
  assert.equal(p.available, true);
  assert.equal(p.total, 2, 'notes.txt is ignored');
  const titles = p.recent.map((x) => x.title);
  assert.ok(titles.includes('Add OAuth login'), 'first markdown heading used as title');
  assert.ok(titles.includes('p2'), 'filename used when there is no heading');
});

test('analyzePlans: mtime-day range filter (fresh files fall outside a past range)', () => {
  const past = L.analyzePlans('2000-01-01', '2000-12-31');
  assert.equal(past.total, 2, 'total is all-time');
  assert.equal(past.inRange, 0, 'just-written files are not in a 2000 range');
});
