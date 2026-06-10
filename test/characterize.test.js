'use strict';

// Characterization test for the two big aggregators, overview() and
// projectDetail(). It builds a fixed multi-project / multi-model / multi-day
// fixture and asserts their FULL output is byte-identical to a committed golden
// snapshot (test/fixtures/aggregation.golden.json). The point is to lock current
// behavior so the shared-accumulator refactor is provably behavior-preserving:
// if any field drifts, the deep-equal fails and points at it.
//
// Dates are fixed in 2023 so the current-month-dependent bits (monthGrand /
// budget / plan) are deterministically empty, and the explicit query range
// makes the prev-period / delta deterministic too. PRICING_FILE points at a
// nonexistent path so DEFAULT_PRICING is used (the golden's dollar figures are
// computed from it). Regenerate the golden if the fixture or DEFAULT_PRICING
// intentionally changes:  node test/characterize.test.js --print > test/fixtures/aggregation.golden.json

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FROM = '2023-01-01';
const TO = '2023-12-31';
const ALPHA = '-home-demo-alpha';

function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-char-'));
  const projectsDir = path.join(root, 'projects');
  const write = (folder, id, objs) => {
    fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
    fs.writeFileSync(path.join(projectsDir, folder, id + '.jsonl'),
      objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
  };
  const ts = (d, s) => `2023-03-${d}T14:00:${s}.000Z`;

  // alpha / sA1 (03-10): opus turn w/ skill + edit + commit, a tool error, then
  // a sonnet recovery turn + write. Two turn-duration samples.
  write(ALPHA, 'sA1', [
    { type: 'ai-title', aiTitle: 'Refactor the parser', timestamp: ts('10', '00') },
    { type: 'user', cwd: '/home/demo/alpha', gitBranch: 'main', entrypoint: 'cli', timestamp: ts('10', '01'),
      message: { content: 'Refactor the parser please' } },
    { type: 'assistant', entrypoint: 'cli', attributionSkill: 'code-review', timestamp: ts('10', '05'),
      message: { model: 'claude-opus-4-8',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000,
          cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 100 } },
        content: [ { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/home/demo/alpha/x.js' } },
          { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'git commit -m "wip"' } } ] } },
    { type: 'user', entrypoint: 'cli', timestamp: ts('10', '07'),
      message: { content: [ { type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'boom' } ] } },
    { type: 'assistant', entrypoint: 'cli', timestamp: ts('10', '09'),
      message: { model: 'claude-sonnet-4-6',
        usage: { input_tokens: 200, output_tokens: 100 },
        content: [ { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/home/demo/alpha/y.js' } } ] } },
    { type: 'system', subtype: 'turn_duration', timestamp: ts('10', '20'), durationMs: 30000 },
    { type: 'system', subtype: 'turn_duration', timestamp: ts('10', '22'), durationMs: 12000 },
  ]);

  // alpha / sA2 (03-11): haiku, sdk-cli, mcp-attributed, opens a PR.
  write(ALPHA, 'sA2', [
    { type: 'ai-title', aiTitle: 'Add more tests', timestamp: ts('11', '00') },
    { type: 'user', cwd: '/home/demo/alpha', gitBranch: 'main', entrypoint: 'sdk-cli', timestamp: ts('11', '01'),
      message: { content: 'Add more tests for coverage' } },
    { type: 'assistant', entrypoint: 'sdk-cli', attributionMcpServer: 'github', timestamp: ts('11', '05'),
      message: { model: 'claude-haiku-4-5',
        usage: { input_tokens: 400, output_tokens: 50, cache_read_input_tokens: 100 },
        content: [ { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'gh pr create --fill' } } ] } },
    { type: 'system', subtype: 'turn_duration', timestamp: ts('11', '12'), durationMs: 8000 },
  ]);

  // beta / sB1 (03-10): one opus session.
  write('-home-demo-beta', 'sB1', [
    { type: 'ai-title', aiTitle: 'Beta investigation', timestamp: ts('10', '00') },
    { type: 'user', cwd: '/home/demo/beta', gitBranch: 'dev', entrypoint: 'cli', timestamp: ts('10', '02'),
      message: { content: 'Investigate the beta path' } },
    { type: 'assistant', entrypoint: 'cli', timestamp: ts('10', '06'),
      message: { model: 'claude-opus-4-8',
        usage: { input_tokens: 800, output_tokens: 300 },
        content: [ { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/home/demo/beta/z.js' } } ] } },
    { type: 'system', subtype: 'turn_duration', timestamp: ts('10', '15'), durationMs: 5000 },
  ]);

  return projectsDir;
}

// Load the server against the fixture with DEFAULT_PRICING and no persistence.
const projectsDir = buildFixture();
process.env.CLAUDE_PROJECTS_DIR = projectsDir;
process.env.PRICING_FILE = path.join(projectsDir, 'no-such-pricing.json'); // → DEFAULT_PRICING
delete process.env.CLAUDE_LEDGER_DATA;
delete process.env.LEDGER_PERSIST;
const L = require('../server.js');

const actual = { ov: L.overview(FROM, TO), pd: L.projectDetail(ALPHA, FROM, TO) };

// `--print` regenerates the golden (see header). Not part of the test run.
if (process.argv.includes('--print')) {
  process.stdout.write(JSON.stringify(actual, null, 2) + '\n');
  process.exit(0);
}

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'aggregation.golden.json'), 'utf8'));

test('overview() output matches the golden snapshot', () => {
  assert.deepStrictEqual(actual.ov, GOLDEN.ov);
});

test('projectDetail() output matches the golden snapshot', () => {
  assert.deepStrictEqual(actual.pd, GOLDEN.pd);
});

// Human-readable anchors on top of the deep-equal — these document what the
// fixture is supposed to exercise and make a deep-equal failure quick to triage.
test('the fixture exercises the full aggregation surface', () => {
  const o = actual.ov;
  assert.equal(o.projectCount, 2, '2 active projects');
  assert.equal(o.totals.sessions, 3, '3 sessions across both projects');
  assert.deepEqual(o.topModels.map((m) => m.name),
    ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'], '3 model families present');
  assert.deepEqual(o.topSkills.map((s) => s.name), ['code-review'], 'skill attribution folded in');
  assert.deepEqual(o.topMcp.map((s) => s.name), ['github'], 'mcp attribution folded in');
  assert.deepEqual(o.topEntrypoints.map((s) => s.name), ['cli', 'sdk-cli'], 'both entrypoints present');
  assert.equal(o.reliability.totalErrors, 1, 'the failed Bash result is counted');
  assert.ok(o.reliability.wastedCost > 0, 'recovery spend after the error is priced');
  assert.deepEqual(o.output, { commits: 1, prs: 1, edits: 2, filesEdited: 2,
    costPerCommit: o.output.costPerCommit, costPerFile: o.output.costPerFile });
  assert.equal(o.daily.length, 2, 'two active days in the chart');
  assert.equal(o.budget.mtdCost, 0, '2023 fixture contributes nothing to the current month');
  assert.equal(o.plan, null, 'no plan fee configured');

  const p = actual.pd;
  assert.equal(p.id, ALPHA);
  assert.equal(p.gitBranch, 'main');
  assert.equal(p.totals.sessions, 2);
  assert.equal(p.sessions.length, 2, 'per-session table has both live sessions');
});
