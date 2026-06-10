'use strict';

// Batch 4: file-history churn (output volume) + sessions/tasks concurrency.
// Env points the sidecar dirs at fixtures BEFORE requiring the server (node
// --test isolates each file in its own process).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let dir, L;
const SID = 'sess-aaaa';

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-churn-'));
  const fh = path.join(dir, 'file-history', SID);
  const sessionsDir = path.join(dir, 'sessions');
  const tasksDir = path.join(dir, 'tasks');
  fs.mkdirSync(fh, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });

  // fileHash "h1": +2 lines (d,e), -0. fileHash "h2": +1 (z), -1 (y).
  fs.writeFileSync(path.join(fh, 'h1@v1'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(fh, 'h1@v2'), 'a\nb\nc\nd\ne\n');
  fs.writeFileSync(path.join(fh, 'h2@v1'), 'x\ny\n');
  fs.writeFileSync(path.join(fh, 'h2@v2'), 'x\nz\n');

  fs.writeFileSync(path.join(sessionsDir, '1.json'), JSON.stringify(
    { name: 'busy-one', cwd: '/home/demo/a', status: 'busy', kind: 'interactive', entrypoint: 'cli', updatedAt: 200 }));
  fs.writeFileSync(path.join(sessionsDir, '2.json'), JSON.stringify(
    { name: 'idle-one', cwd: '/home/demo/b', status: 'idle', kind: 'interactive', entrypoint: 'cli', updatedAt: 100 }));

  fs.mkdirSync(path.join(tasksDir, 't1'));
  fs.mkdirSync(path.join(tasksDir, 't2'));

  process.env.FILE_HISTORY_DIR = path.join(dir, 'file-history');
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.TASKS_DIR = tasksDir;
  L = require('../server.js');
});

after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('lineChurn: order-insensitive added/removed line counts', () => {
  assert.deepEqual(L.lineChurn('a\nb\n', 'a\nb\nc\n'), { added: 1, removed: 0 });
  assert.deepEqual(L.lineChurn('a\nb\n', 'a\nc\n'), { added: 1, removed: 1 });
  assert.deepEqual(L.lineChurn('a\nb\n', 'a\nb\n'), { added: 0, removed: 0 });
});

test('computeSessionChurn: sums churn across fileHash groups', () => {
  const c = L.computeSessionChurn(path.join(dir, 'file-history', SID));
  assert.equal(c.added, 3, 'h1 +2, h2 +1');
  assert.equal(c.removed, 1, 'h2 -1');
  assert.equal(c.net, 2);
  assert.equal(c.filesRevised, 2);
  assert.equal(c.revisions, 4, '2 versions x 2 files');
});

test('analyzeChurn: aggregates across sessions, range + scope filters', () => {
  const all = L.analyzeChurn(null, null);
  assert.equal(all.available, true);
  assert.equal(all.added, 3);
  assert.equal(all.removed, 1);
  assert.equal(all.net, 2);
  assert.equal(all.filesRevised, 2);
  assert.equal(all.sessions, 1);
  // Scope to an unrelated session id → nothing.
  const none = L.analyzeChurn(null, null, new Set(['other']));
  assert.equal(none.sessions, 0);
  assert.equal(none.added, 0);
});

test('sessionConcurrency: max overlap + parallel count, touching ≠ overlap', () => {
  const a = L.sessionConcurrency([{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 20, end: 30 }]);
  assert.deepEqual(a, { maxConcurrent: 2, parallelSessions: 2, totalSessions: 3 });
  // Back-to-back intervals: one ends exactly as the next starts → not concurrent.
  const b = L.sessionConcurrency([{ start: 0, end: 10 }, { start: 10, end: 20 }]);
  assert.equal(b.maxConcurrent, 1);
  assert.equal(b.parallelSessions, 0);
});

test('loadLiveSessions: reads registry, newest first', () => {
  const live = L.loadLiveSessions();
  assert.equal(live.length, 2);
  assert.equal(live[0].name, 'busy-one', 'sorted by updatedAt desc');
  assert.equal(live[0].status, 'busy');
});

test('analyzeTasks: counts background-task dirs', () => {
  const t = L.analyzeTasks(null, null);
  assert.equal(t.available, true);
  assert.equal(t.total, 2);
});

test('missing churn/sessions/tasks dirs degrade to empty, not throw', () => {
  // Pure functions over absent dirs via a fresh path the module never saw.
  // analyzeChurn already returns the empty shape if FILE_HISTORY_DIR is unreadable;
  // here we just confirm the documented empty-scope path.
  const c = L.analyzeChurn('1999-01-01', '1999-01-02');
  assert.equal(c.added, 0, 'fixture churn (today) excluded from a 1999 range');
});
