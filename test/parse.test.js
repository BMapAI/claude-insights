'use strict';

// End-to-end parse test: write a synthetic transcript to disk and assert that
// parseSession extracts the exact schema fields server.js depends on. This is
// the guard against Claude Code's transcript format drifting — every cost and
// metric the dashboard shows flows through these fields, and the other tests
// only cover the pure helpers downstream of here. Cost is checked against
// priceBundles() of the same tokens, so it holds under any pricing.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../server.js');

const DAY = '2026-03-02';
const TS = (s) => `${DAY}T14:00:${s}.000Z`;
// Full token bundle expected for the day: both assistant turns, opus family.
const EXPECTED_OPUS = { input: 1200, output: 550, cacheRead: 2000, cw5: 300, cw1: 100, cwOther: 0 };
// The first assistant turn alone (the one carrying skill / MCP attribution).
const TURN1_OPUS = { input: 1000, output: 500, cacheRead: 2000, cw5: 300, cw1: 100, cwOther: 0 };

let dir, file, parsed;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-parse-'));
  file = path.join(dir, 'session-abc.jsonl');
  const objs = [
    { type: 'ai-title', aiTitle: 'Add OAuth login', timestamp: TS('00') },
    { type: 'user', cwd: '/home/demo/acme', gitBranch: 'main', entrypoint: 'cli', timestamp: TS('05'),
      message: { content: 'Add an OAuth login flow.' } },
    { type: 'assistant', entrypoint: 'cli', attributionSkill: 'code-review', attributionMcpServer: 'github', timestamp: TS('10'),
      message: {
        model: 'claude-opus-4-8',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000,
          cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 100 } },
        content: [
          { type: 'text', text: 'Working on it.' },
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/home/demo/acme/auth.js' } },
          { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'git commit -m "add oauth"' } },
        ] } },
    { type: 'user', timestamp: TS('15'),
      message: { content: [ { type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'boom' } ] } },
    { type: 'assistant', entrypoint: 'cli', timestamp: TS('20'),
      message: { model: 'claude-opus-4-8', usage: { input_tokens: 200, output_tokens: 50 },
        content: [ { type: 'text', text: 'Trying again.' } ] } },
    { type: 'system', subtype: 'turn_duration', timestamp: TS('25'), durationMs: 42000 },
  ];
  // A malformed line and trailing blanks must be skipped, not throw.
  const raw = objs.map((o) => JSON.stringify(o)).join('\n') + '\n{ this is not valid json\n\n';
  fs.writeFileSync(file, raw);
  parsed = L.parseSession(file);
});

after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('parseSession extracts session-level metadata', () => {
  assert.equal(parsed.id, 'session-abc');
  assert.equal(parsed.cwd, '/home/demo/acme');
  assert.equal(parsed.gitBranch, 'main');
  assert.equal(parsed.title, 'Add OAuth login');
  assert.equal(parsed.firstPrompt, 'Add an OAuth login flow.');
  assert.equal(parsed.start, TS('00'));
  assert.equal(parsed.end, TS('25'));
});

test('parseSession buckets one day with the right counts and tools', () => {
  const d = parsed.days[DAY];
  assert.ok(d, 'day bucket exists');
  assert.equal(d.userPrompts, 1);      // the tool_result user msg is not a prompt
  assert.equal(d.assistantMessages, 2);
  assert.equal(d.toolUses, 2);
  assert.deepEqual(d.tools, { Edit: 1, Bash: 1 });
});

test('parseSession sums the usage bundle (5m/1h cache split included)', () => {
  assert.deepEqual(parsed.days[DAY].byFamily.opus, EXPECTED_OPUS);
});

test('parseSession tracks exact model id and entrypoint', () => {
  const d = parsed.days[DAY];
  assert.deepEqual(d.byModel['claude-opus-4-8'].opus, EXPECTED_OPUS);
  assert.deepEqual(d.byEntry.cli.opus, EXPECTED_OPUS);
});

test('parseSession attributes skill / MCP spend (tagged turn only)', () => {
  const d = parsed.days[DAY];
  assert.deepEqual(d.bySkill['code-review'].opus, TURN1_OPUS);
  assert.deepEqual(d.byMcp.github.opus, TURN1_OPUS);
});

test('parseSession records tool errors and recovery spend', () => {
  const d = parsed.days[DAY];
  assert.deepEqual(d.toolErrors, { Bash: 1 });   // t2 → Bash failed
  // The assistant turn right after the failed result counts as recovery spend.
  assert.equal(d.errorFollowup.opus.input, 200);
  assert.equal(d.errorFollowup.opus.output, 50);
});

test('parseSession derives output metrics (commits / edits / files)', () => {
  const d = parsed.days[DAY];
  assert.equal(d.commits, 1);
  assert.equal(d.prs, 0);
  assert.equal(d.edits, 1);   // Edit only; Bash is not an editing tool
  assert.deepEqual(d.editsByFile, { '/home/demo/acme/auth.js': 1 });
});

test('parseSession captures turn-duration latency', () => {
  const d = parsed.days[DAY];
  assert.equal(d.turns, 1);
  assert.equal(d.turnMs, 42000);
  assert.deepEqual(d.durations, [42000]);
});

test('parseSession buckets per-hour activity (feeds the day×hour grid)', () => {
  const d = parsed.days[DAY];
  assert.equal(d.hours[14].messages, 2);
  assert.deepEqual(d.hours[14].byFamily.opus, EXPECTED_OPUS);
});

test('parsed session prices through aggregateSession at the same tokens', () => {
  const agg = L.aggregateSession(parsed, null, null);
  assert.ok(agg.has);
  assert.deepEqual(agg.byFamily.opus, EXPECTED_OPUS);
  const cost = L.priceBundles(agg.byFamily).cost;
  assert.ok(cost > 0);
  assert.ok(Math.abs(cost - L.priceBundles({ opus: EXPECTED_OPUS }).cost) < 1e-9);
  // A window that excludes the day contributes nothing.
  assert.equal(L.aggregateSession(parsed, '2026-03-03', '2026-03-09').has, false);
});

test('parseSession counts skipped malformed lines instead of dropping them silently', () => {
  // The fixture appends one '{ this is not valid json' line + blank lines; only
  // the non-blank unparseable line counts (blanks are skipped before parsing).
  assert.equal(parsed.parseErrors, 1);
});

test('parseSession tolerates malformed input and missing files', () => {
  assert.equal(L.parseSession(path.join(dir, 'does-not-exist.jsonl')), null);
  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(bad, '{ not json\n\n\n');
  const p = L.parseSession(bad);
  assert.ok(p && typeof p.days === 'object');
  assert.equal(Object.keys(p.days).length, 0); // nothing parseable → no day buckets
  assert.equal(p.parseErrors, 1);              // the one bad line is surfaced, not hidden
});

test('parseSession caches by mtime + size (same object on repeat reads)', () => {
  assert.strictEqual(L.parseSession(file), L.parseSession(file));
});

// --- Batch 1: branch / subagent / service-tier / CLI-version dimensions ------
test('parseSession defaults the new dimensions when the fields are absent', () => {
  const d = parsed.days[DAY];
  // The base fixture carries gitBranch=main, no isSidechain/service_tier/version,
  // so each dimension folds the whole day's opus bundle into its fallback key.
  assert.deepEqual(d.byBranch.main.opus, EXPECTED_OPUS, 'branch from gitBranch');
  assert.deepEqual(d.byAgentKind.main.opus, EXPECTED_OPUS, 'main thread when no isSidechain');
  assert.deepEqual(d.byTier.standard.opus, EXPECTED_OPUS, 'standard tier when service_tier unset');
  assert.deepEqual(d.byVersion.unknown.opus, EXPECTED_OPUS, 'unknown version when none on the line');
});

test('parseSession splits spend by branch / subagent / tier / version', () => {
  const day = '2026-03-04';
  const ts = (s) => `${day}T09:00:${s}.000Z`;
  const objs = [
    // user line seeds the session branch = feature-x (the per-message fallback).
    { type: 'user', cwd: '/home/demo/acme', gitBranch: 'feature-x', version: '2.1.170', timestamp: ts('01'),
      message: { content: 'work on feature x' } },
    // A: main thread, standard tier, v2.1.170, branch feature-x (inherited).
    { type: 'assistant', version: '2.1.170', timestamp: ts('05'),
      message: { model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 50 }, content: [] } },
    // B: a Task subagent turn, priority tier, v2.1.170, branch feature-x.
    { type: 'assistant', version: '2.1.170', isSidechain: true, timestamp: ts('10'),
      message: { model: 'claude-opus-4-8', usage: { input_tokens: 200, output_tokens: 60, service_tier: 'priority' }, content: [] } },
    // C: main thread, standard tier, v2.2.0, branch main (line-level override).
    { type: 'assistant', gitBranch: 'main', version: '2.2.0', timestamp: ts('15'),
      message: { model: 'claude-opus-4-8', usage: { input_tokens: 300, output_tokens: 70 }, content: [] } },
  ];
  const f = path.join(dir, 'vary.jsonl');
  fs.writeFileSync(f, objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
  const d = L.parseSession(f).days[day];

  assert.equal(d.byBranch['feature-x'].opus.input, 300, 'feature-x = A+B input');
  assert.equal(d.byBranch.main.opus.input, 300, 'main = C input');
  assert.equal(d.byAgentKind.main.opus.input, 400, 'main thread = A+C');
  assert.equal(d.byAgentKind.subagent.opus.input, 200, 'subagent = B');
  assert.equal(d.byTier.standard.opus.input, 400, 'standard = A+C');
  assert.equal(d.byTier.priority.opus.input, 200, 'priority = B');
  assert.equal(d.byVersion['2.1.170'].opus.input, 300, 'v2.1.170 = A+B');
  assert.equal(d.byVersion['2.2.0'].opus.input, 300, 'v2.2.0 = C');
});
