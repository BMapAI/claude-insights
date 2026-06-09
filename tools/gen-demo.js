'use strict';

/*
 * LOCAL, GIT-IGNORED screenshot tool — not part of the shipped app.
 *
 * Generates synthetic ~/.claude/projects-style transcripts so we can screenshot
 * the dashboard for the README without exposing any real prompts or costs. The
 * emitted JSONL matches the exact fields server.js reads: per-message usage
 * (with the cache_creation 5m/1h split), tool_use / tool_result (some errors),
 * exact model ids, entrypoint (cli vs sdk-cli), and skill / MCP attribution.
 *
 * Usage:  node tools/gen-demo.js [outDir]
 * Output: <outDir>/<folder>/<sessionId>.jsonl, one folder per demo project.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const outDir = process.argv[2] || path.join(os.tmpdir(), 'claude-demo', 'projects');

// Seeded PRNG (mulberry32) so the same screenshot reproduces run to run.
let seed = 0x1a2b3c4d;
function rnd() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const pickW = (pairs) => {
  const tot = pairs.reduce((s, p) => s + p[1], 0);
  let r = rnd() * tot;
  for (const [v, w] of pairs) { if ((r -= w) <= 0) return v; }
  return pairs[0][0];
};
const hex = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('');
const sessionId = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;

const PROJECTS = [
  { name: 'acme-api', auto: false, heat: 1.0 },
  { name: 'web-dashboard', auto: false, heat: 0.9 },
  { name: 'ml-pipeline', auto: true, heat: 0.8 },
  { name: 'infra-terraform', auto: false, heat: 0.6 },
  { name: 'mobile-app', auto: false, heat: 0.7 },
  { name: 'docs-site', auto: false, heat: 0.4 },
  { name: 'data-etl', auto: true, heat: 0.6 },
];
// Last entry is an intentionally-unknown id (no opus/sonnet/haiku) so the demo
// shows the "priced as Opus" badge on the exact-model-version list.
const MODELS = [['claude-opus-4-8', 60], ['claude-opus-4-7', 26], ['claude-sonnet-4-6', 9], ['claude-haiku-4-5-20251001', 3], ['claude-neptune-1', 2]];
const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'Agent', 'WebFetch', 'TodoWrite'];
const SKILLS = ['code-review', 'deep-research', 'verify', 'security-review', 'simplify'];
const MCP = ['github', 'linear', 'sentry', 'postgres'];
const TITLES = ['Fix flaky integration tests', 'Add OAuth login flow', 'Refactor the data loader', 'Investigate prod latency', 'Migrate to the new schema', 'Write the API docs', 'Optimize bundle size', 'Set up the CI pipeline', 'Debug a memory leak', 'Add cursor pagination', 'Harden the auth middleware', 'Speed up the test suite'];
const PROMPTS = ['Can you fix the failing test in CI?', 'Add a new endpoint for user profiles.', 'Why is this query so slow?', 'Refactor this module to be cleaner.', 'Write unit tests for the parser.', 'Update the README with the new flags.', 'Investigate the deploy failure.', 'Add caching to the hot path.', 'Review this diff for bugs.', 'Wire up the webhook handler.'];

// Output-metric inputs: realistic file paths + shell commands so the Output (ROI)
// panel has commits, PRs, and distinct files touched. Without an `input` on each
// tool_use, server.js can't attribute any output and the panel would be empty.
const SRC_DIRS = ['src', 'lib', 'app', 'server', 'components', 'tests', 'api'];
const SRC_NAMES = ['index', 'utils', 'handler', 'model', 'service', 'router', 'auth', 'db', 'cache', 'parser', 'client', 'config', 'helpers', 'types', 'middleware'];
const SRC_EXTS = ['js', 'ts', 'tsx', 'py', 'go', 'json', 'md'];
const demoFilePath = () => `${pick(SRC_DIRS)}/${pick(SRC_NAMES)}.${pick(SRC_EXTS)}`;
const COMMIT_MSGS = ['fix failing tests', 'add user endpoint', 'refactor data loader', 'update docs', 'tidy imports', 'handle edge case'];
function bashCmd() {
  const r = rnd();
  if (r < 0.34) return `git commit -m "${pick(COMMIT_MSGS)}"`;
  if (r < 0.44) return 'gh pr create --fill';
  return pick(['npm test', 'git status', 'npm run build', 'ls -la', 'grep -rn TODO .']);
}
function toolUse(id, name) {
  const b = { type: 'tool_use', id, name };
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') b.input = { file_path: demoFilePath() };
  else if (name === 'Bash') b.input = { command: bashCmd() };
  else if (name === 'Read' || name === 'Grep') b.input = { file_path: demoFilePath() };
  return b;
}

function isoAt(daysAgo, hour, minute) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour, minute, ri(0, 59), 0);
  return d.toISOString();
}
function usage() {
  return {
    input_tokens: ri(600, 7000),
    output_tokens: ri(900, 9000),
    cache_read_input_tokens: ri(60000, 800000),
    cache_creation: {
      ephemeral_5m_input_tokens: ri(6000, 60000),
      ephemeral_1h_input_tokens: rnd() < 0.3 ? ri(0, 20000) : 0,
    },
  };
}
let tid = 0;
const newToolId = () => 'toolu_' + (tid++).toString(36).padStart(12, '0');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

let totalSessions = 0;
for (const proj of PROJECTS) {
  const cwd = '/home/demo/' + proj.name;
  const folder = '-home-demo-' + proj.name;
  const pdir = path.join(outDir, folder);
  fs.mkdirSync(pdir, { recursive: true });

  const nSessions = ri(3, 7);
  for (let s = 0; s < nSessions; s++) {
    totalSessions++;
    // Bias toward recent days (rnd*rnd skews low) so the month-to-date budget
    // panel has meaningful spend, while still filling ~5 weeks of history.
    const daysAgo = Math.floor(rnd() * rnd() * 35);
    // Working-hours bias gives the punchcard a realistic shape.
    const startHour = pickW([[9, 3], [10, 4], [11, 4], [12, 2], [13, 3], [14, 4], [15, 4], [16, 3], [17, 2], [19, 1], [21, 1]]);
    const entrypoint = proj.auto && rnd() < 0.6 ? 'sdk-cli' : 'cli';
    const branch = pick(['main', 'develop', 'feat/profiles', 'fix/bug-412']);
    const lines = [];
    let minute = 0;
    const ts = () => isoAt(daysAgo, startHour, minute++);

    lines.push({ type: 'ai-title', aiTitle: pick(TITLES), timestamp: ts() });
    const nTurns = Math.max(2, Math.round(ri(3, 9) * proj.heat));
    for (let t = 0; t < nTurns; t++) {
      const model = pickW(MODELS);
      const skill = rnd() < 0.4 ? pick(SKILLS) : null;
      const mcp = rnd() < 0.22 ? pick(MCP) : null;
      const toolName = pick(TOOLS);
      const toolId = newToolId();

      lines.push({ type: 'user', cwd, gitBranch: branch, entrypoint, timestamp: ts(), message: { content: pick(PROMPTS) } });

      // Primary tool (tracked for the error/result flow below) plus a few extra
      // edits/commits so the Output (ROI) panel has realistic volume.
      const content = [{ type: 'text', text: 'Working on it.' }, toolUse(toolId, toolName)];
      for (let k = ri(0, 3); k > 0; k--) content.push(toolUse(newToolId(), pickW([['Edit', 6], ['Write', 2], ['Bash', 2]])));
      const a1 = { type: 'assistant', cwd, gitBranch: branch, entrypoint, timestamp: ts(), message: { model, usage: usage(), content } };
      if (skill) a1.attributionSkill = skill;
      if (mcp) a1.attributionMcpServer = mcp;
      lines.push(a1);

      const isErr = rnd() < 0.06;
      lines.push({ type: 'user', cwd, timestamp: ts(), message: { content: [{ type: 'tool_result', tool_use_id: toolId, is_error: isErr, content: isErr ? 'Error: command exited 1' : 'ok' }] } });

      lines.push({ type: 'assistant', cwd, gitBranch: branch, entrypoint, timestamp: ts(), message: { model, usage: usage(), content: [{ type: 'text', text: isErr ? 'Let me try a different approach.' : 'Done.' }] } });

      // Wall-clock turn duration: mostly short, with a ~15% long tail (like real
      // turns — low median, occasional multi-minute outliers).
      const durationMs = rnd() < 0.15 ? ri(60000, 900000) : ri(5000, 50000);
      lines.push({ type: 'system', subtype: 'turn_duration', cwd, gitBranch: branch, entrypoint, timestamp: ts(), durationMs, messageCount: (t + 1) * 2 });
    }
    fs.writeFileSync(path.join(pdir, sessionId() + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
}

console.log(`Wrote ${PROJECTS.length} demo projects, ${totalSessions} sessions to ${outDir}`);
