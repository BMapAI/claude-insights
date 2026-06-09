'use strict';

// Durable-history test. Sets up a temp projects dir + a temp rollup store BEFORE
// requiring the server (PROJECTS_DIR is read at module load), writes a settled
// (past-dated) session, then proves: the scan persists it, archivedFor filters
// live ids, the totals survive deleting the transcript, and with persistence
// off the aged-out session disappears (the read-only default is preserved).

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A settled session, dated 5 days ago so persistRollups will store it.
const PAST = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
const ts = (s) => `${PAST}T10:00:${s}.000Z`;
const OBJS = [
  { type: 'ai-title', aiTitle: 'Archived work', timestamp: ts('00') },
  { type: 'user', cwd: '/home/demo/acme', gitBranch: 'main', entrypoint: 'cli', timestamp: ts('05'),
    message: { content: 'Do the thing.' } },
  { type: 'assistant', entrypoint: 'cli', timestamp: ts('10'),
    message: { model: 'claude-opus-4-8',
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000,
        cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 100 } },
      content: [ { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/home/demo/acme/x.js' } },
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'git commit -m "x"' } } ] } },
  { type: 'system', subtype: 'turn_duration', timestamp: ts('20'), durationMs: 30000 },
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rollup-'));
const projectsDir = path.join(root, 'projects');
const folder = '-tmp-acme';
const sessId = 'sess-aaa';
const sessFile = path.join(projectsDir, folder, sessId + '.jsonl');
const storeFile = path.join(root, 'rollups.json');
fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
fs.writeFileSync(sessFile, OBJS.map((o) => JSON.stringify(o)).join('\n') + '\n');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.CLAUDE_LEDGER_DATA = storeFile;
const L = require('../server.js'); // must come after the env is set

after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });

let liveCost;

test('overview reads the live session and persists it to the store', () => {
  const ov = L.overview(null, null);
  assert.equal(ov.projectCount, 1);
  assert.ok(ov.totals.cost > 0);
  liveCost = ov.totals.cost;

  assert.ok(fs.existsSync(storeFile), 'store file written');
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  assert.equal(store.v, 1);
  assert.ok(store.sessions[folder] && store.sessions[folder][sessId], 'session persisted under its folder/id');
  assert.ok(store.sessions[folder][sessId].data.days[PAST], 'stored data keeps the per-day bucket');
});

test('archivedFor filters by live id (returns only aged-out sessions)', () => {
  assert.equal(L.archivedFor(folder, new Set([sessId])).length, 0); // still live → skipped
  const arch = L.archivedFor(folder, new Set());
  assert.equal(arch.length, 1);
  assert.equal(arch[0].id, sessId);
});

test('after the transcript ages out, archived history still shows', () => {
  fs.rmSync(sessFile); // simulate Claude Code's cleanupPeriodDays deletion
  const ov = L.overview(null, null);
  assert.equal(ov.projectCount, 1, 'project still present via the archive');
  assert.equal(ov.totals.sessions, 1);
  assert.ok(Math.abs(ov.totals.cost - liveCost) < 1e-9, 'same cost, now sourced from the store');
  // Output metrics survive too.
  assert.equal(ov.output.commits, 1);
  assert.equal(ov.output.filesEdited, 1);
});

test('with persistence disabled the aged-out session is gone (read-only default)', () => {
  delete process.env.CLAUDE_LEDGER_DATA;
  assert.equal(L.rollupPath(), null);
  const ov = L.overview(null, null);
  assert.equal(ov.projectCount, 0); // no live transcript, no archive
  assert.equal(ov.totals.cost, 0);
  process.env.CLAUDE_LEDGER_DATA = storeFile; // restore
});

test('loadRollups fails safe on a malformed / wrong-version store', () => {
  const bad = path.join(root, 'bad.json');
  fs.writeFileSync(bad, '{ not json');
  const saved = process.env.CLAUDE_LEDGER_DATA;
  process.env.CLAUDE_LEDGER_DATA = bad;
  try {
    const store = L.loadRollups();
    assert.deepEqual(store, { v: 1, sessions: {} }); // empty, not a throw
  } finally {
    process.env.CLAUDE_LEDGER_DATA = saved;
  }
});
