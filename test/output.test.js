'use strict';

// Tests for the output / ROI metrics (the "R"): detecting commits / PRs / file
// edits from tool_use blocks, summarizing them into per-cost ratios, and rolling
// them up across a session's days. Cost ratios use plain arithmetic so they hold
// under any pricing.

const test = require('node:test');
const assert = require('node:assert');
const L = require('../server.js');

test('isCommitCommand / isPrCommand match the real command shapes', () => {
  assert.ok(L.isCommitCommand('git commit -m "x"'));
  assert.ok(L.isCommitCommand('git add -A && git commit -m "x"'));
  assert.ok(L.isCommitCommand('git  commit --amend'));
  assert.ok(!L.isCommitCommand('git status'));
  assert.ok(!L.isCommitCommand('echo committing'));
  assert.ok(!L.isCommitCommand(null));
  assert.ok(L.isPrCommand('gh pr create --fill'));
  assert.ok(!L.isPrCommand('gh pr list'));
  assert.ok(!L.isPrCommand(undefined));
});

test('recordOutput tallies edits (distinct files), commits, and PRs', () => {
  const day = { commits: 0, prs: 0, edits: 0, editsByFile: {} };
  L.recordOutput(day, 'Edit', { file_path: '/a.js' });
  L.recordOutput(day, 'Write', { file_path: '/b.js' });
  L.recordOutput(day, 'Edit', { file_path: '/a.js' });       // same file again
  L.recordOutput(day, 'NotebookEdit', { notebook_path: '/n.ipynb' });
  L.recordOutput(day, 'Bash', { command: 'git add -A && git commit -m "x"' });
  L.recordOutput(day, 'Bash', { command: 'gh pr create --fill' });
  L.recordOutput(day, 'Read', { file_path: '/c.js' });        // not an output
  L.recordOutput(day, 'Bash', { command: 'ls -la' });         // not an output

  assert.equal(day.edits, 4);
  assert.equal(day.commits, 1);
  assert.equal(day.prs, 1);
  assert.deepEqual(Object.keys(day.editsByFile).sort(), ['/a.js', '/b.js', '/n.ipynb']);
  assert.equal(day.editsByFile['/a.js'], 2);
});

test('outputStats derives distinct files and per-cost ratios', () => {
  const o = { commits: 2, prs: 1, edits: 5, editsByFile: { '/a': 1, '/b': 1, '/c': 1 } };
  const s = L.outputStats(o, 100);
  assert.equal(s.commits, 2);
  assert.equal(s.prs, 1);
  assert.equal(s.edits, 5);
  assert.equal(s.filesEdited, 3);
  assert.ok(Math.abs(s.costPerCommit - 50) < 1e-9);
  assert.ok(Math.abs(s.costPerFile - 100 / 3) < 1e-9);
});

test('outputStats guards divide-by-zero and missing input', () => {
  const z = L.outputStats({ commits: 0, prs: 0, edits: 0, editsByFile: {} }, 100);
  assert.equal(z.costPerCommit, 0);
  assert.equal(z.costPerFile, 0);
  const e = L.outputStats(undefined, 100);
  assert.equal(e.commits, 0);
  assert.equal(e.filesEdited, 0);
  assert.equal(e.costPerCommit, 0);
});

test('aggregateSession sums commits/prs/edits and unions distinct files', () => {
  const session = {
    days: {
      '2026-01-01': {
        userPrompts: 1, assistantMessages: 1, toolUses: 2, tools: {}, byFamily: {},
        commits: 1, prs: 0, edits: 2, editsByFile: { '/a': 1, '/b': 1 },
      },
      '2026-01-02': {
        userPrompts: 1, assistantMessages: 1, toolUses: 1, tools: {}, byFamily: {},
        commits: 1, prs: 1, edits: 1, editsByFile: { '/a': 1 },
      },
    },
  };
  const a = L.aggregateSession(session, null, null);
  assert.equal(a.commits, 2);
  assert.equal(a.prs, 1);
  assert.equal(a.edits, 3);
  assert.deepEqual(Object.keys(a.editsByFile).sort(), ['/a', '/b']); // distinct across days
  assert.equal(a.editsByFile['/a'], 2);

  // Date filtering still applies.
  const d1 = L.aggregateSession(session, '2026-01-01', '2026-01-01');
  assert.equal(d1.commits, 1);
  assert.equal(d1.prs, 0);
  assert.deepEqual(Object.keys(d1.editsByFile).sort(), ['/a', '/b']);
});

test('getPlanFee reads env first, then config; rejects junk', () => {
  const saved = process.env.PLAN_MONTHLY_FEE;
  try {
    process.env.PLAN_MONTHLY_FEE = '200';
    assert.equal(L.getPlanFee(), 200);
    process.env.PLAN_MONTHLY_FEE = 'not-a-number';
    assert.equal(L.getPlanFee(), null);
    process.env.PLAN_MONTHLY_FEE = '-5';
    assert.equal(L.getPlanFee(), null); // negative rejected
  } finally {
    if (saved == null) delete process.env.PLAN_MONTHLY_FEE;
    else process.env.PLAN_MONTHLY_FEE = saved;
  }
});
