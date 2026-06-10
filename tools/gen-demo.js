'use strict';

/*
 * LOCAL screenshot tool — regenerates the README's synthetic demo data so the
 * dashboard can be shot without exposing any real prompts or costs.
 *
 * Emits the exact fields server.js reads:
 *  - transcripts under <outDir>/<folder>/<sessionId>.jsonl: per-message usage
 *    (5m/1h cache split + service_tier + server_tool_use), tool_use / tool_result
 *    (some errors), exact model ids, entrypoint (cli vs sdk-cli), gitBranch,
 *    isSidechain (subagents), version, stop_reason (incl. some max_tokens
 *    truncations), thinking blocks, pasted images, compact_boundary events, and
 *    skill / MCP attribution.
 *  - sidecar sources alongside projects/ (the ~/.claude root): history.jsonl
 *    (command/prompt log), plans/ (plan-mode markdown), file-history/ (versioned
 *    file snapshots → code churn), sessions/ (live registry), tasks/ (background).
 *
 * Usage:  node tools/gen-demo.js [outDir]
 * Output: <outDir> and its parent (sidecars) are wiped and rewritten.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const outDir = process.argv[2] || path.join(os.tmpdir(), 'claude-demo', 'projects');
const rootDir = path.dirname(outDir); // sidecars live beside projects/ (the .claude root)

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
// Two live versions + a small tail, so the "Claude Code version" split renders.
const VERSIONS = [['2.1.170', 64], ['2.1.169', 28], ['2.1.158', 8]];
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
// A 1x1 PNG, enough for the parser to see a user-pasted image content block.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function isoAt(daysAgo, hour, minute) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour, minute, ri(0, 59), 0);
  return d.toISOString();
}
function usage(tier, webSearch) {
  const u = {
    input_tokens: ri(600, 7000),
    output_tokens: ri(900, 9000),
    cache_read_input_tokens: ri(60000, 800000),
    cache_creation: {
      ephemeral_5m_input_tokens: ri(6000, 60000),
      ephemeral_1h_input_tokens: rnd() < 0.3 ? ri(0, 20000) : 0,
    },
    service_tier: tier,
  };
  if (webSearch) u.server_tool_use = { web_search_requests: webSearch, web_fetch_requests: rnd() < 0.5 ? ri(0, 2) : 0 };
  return u;
}
let tid = 0;
const newToolId = () => 'toolu_' + (tid++).toString(36).padStart(12, '0');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
for (const p of ['history.jsonl', 'plans', 'file-history', 'sessions', 'tasks']) {
  fs.rmSync(path.join(rootDir, p), { recursive: true, force: true });
}

const allSessions = []; // { id, cwd, folder, start, end, version, entrypoint, name }
let totalSessions = 0;
for (const proj of PROJECTS) {
  const cwd = '/home/demo/' + proj.name;
  const folder = '-home-demo-' + proj.name;
  const pdir = path.join(outDir, folder);
  fs.mkdirSync(pdir, { recursive: true });

  const nSessions = ri(3, 7);
  for (let s = 0; s < nSessions; s++) {
    totalSessions++;
    // Automated projects run as parallel-agent bursts: cluster their sessions on
    // a couple of recent days at a fixed hour so they overlap (→ real concurrency).
    // Interactive projects bias toward recent days (rnd*rnd skews low) so the
    // month-to-date budget has spend, while still filling ~5 weeks of history.
    const daysAgo = proj.auto ? ri(1, 2) : Math.floor(rnd() * rnd() * 35);
    // Working-hours bias gives the punchcard a realistic shape.
    const startHour = proj.auto ? 14 : pickW([[9, 3], [10, 4], [11, 4], [12, 2], [13, 3], [14, 4], [15, 4], [16, 3], [17, 2], [19, 1], [21, 1]]);
    const entrypoint = proj.auto && rnd() < 0.6 ? 'sdk-cli' : 'cli';
    const branch = pick(['main', 'main', 'develop', 'feat/profiles', 'fix/bug-412']);
    const version = pickW(VERSIONS);
    const title = pick(TITLES);
    // Automated projects delegate to Task subagents; a session that does so marks
    // a share of its turns isSidechain so the "main vs subagents" split renders.
    const usesSubagents = proj.auto && rnd() < 0.7;
    const lines = [];
    let minute = 0;
    const ts = () => isoAt(daysAgo, startHour, minute++);
    const meta = () => ({ cwd, gitBranch: branch, entrypoint, version });

    lines.push(Object.assign({ type: 'ai-title', aiTitle: title, timestamp: ts() }, meta()));
    const nTurns = Math.max(2, Math.round(ri(3, 9) * proj.heat));
    for (let t = 0; t < nTurns; t++) {
      const model = pickW(MODELS);
      const skill = rnd() < 0.4 ? pick(SKILLS) : null;
      const mcp = rnd() < 0.22 ? pick(MCP) : null;
      const toolName = pick(TOOLS);
      const toolId = newToolId();
      const tier = rnd() < 0.15 ? 'priority' : 'standard';
      const webSearch = skill === 'deep-research' || rnd() < 0.05 ? ri(1, 5) : 0;
      const sidechain = usesSubagents && rnd() < 0.6;

      lines.push(Object.assign({ type: 'user', timestamp: ts(), message: { content: pick(PROMPTS) } }, meta()));

      // ~8% of turns: a user-pasted image (separate array-content message, so the
      // normal prompt count is unaffected) → the "Image prompts" signal card.
      if (rnd() < 0.08) {
        lines.push(Object.assign({ type: 'user', timestamp: ts(), message: { content: [
          { type: 'text', text: 'See this screenshot:' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX } },
        ] } }, meta()));
      }

      // Primary tool turn (tracked for the error/result flow) plus a few extra
      // edits/commits for Output volume, and a thinking block on ~35% of turns.
      const content = [];
      if (rnd() < 0.35) content.push({ type: 'thinking', thinking: '', signature: hex(16) });
      content.push({ type: 'text', text: 'Working on it.' }, toolUse(toolId, toolName));
      for (let k = ri(0, 3); k > 0; k--) content.push(toolUse(newToolId(), pickW([['Edit', 6], ['Write', 2], ['Bash', 2]])));
      const a1 = Object.assign({ type: 'assistant', timestamp: ts(),
        message: { model, usage: usage(tier, webSearch), stop_reason: 'tool_use', content } }, meta());
      if (sidechain) a1.isSidechain = true;
      if (skill) a1.attributionSkill = skill;
      if (mcp) a1.attributionMcpServer = mcp;
      lines.push(a1);

      const isErr = rnd() < 0.06;
      lines.push(Object.assign({ type: 'user', timestamp: ts(),
        message: { content: [{ type: 'tool_result', tool_use_id: toolId, is_error: isErr, content: isErr ? 'Error: command exited 1' : 'ok' }] } }, meta()));

      // Final turn of the exchange: usually ends cleanly; ~5% get cut off at the
      // token limit (max_tokens) so the "Truncated turns" signal/insight appears.
      const stop = isErr ? 'tool_use' : (rnd() < 0.05 ? 'max_tokens' : 'end_turn');
      const a2 = Object.assign({ type: 'assistant', timestamp: ts(),
        message: { model, usage: usage(tier, 0), stop_reason: stop, content: [{ type: 'text', text: isErr ? 'Let me try a different approach.' : 'Done.' }] } }, meta());
      if (sidechain) a2.isSidechain = true;
      lines.push(a2);

      // Wall-clock turn duration: mostly short, with a ~15% long tail.
      const durationMs = rnd() < 0.15 ? ri(60000, 900000) : ri(5000, 50000);
      lines.push(Object.assign({ type: 'system', subtype: 'turn_duration', timestamp: ts(), durationMs, messageCount: (t + 1) * 2 }, meta()));

      // Long, heat-y sessions occasionally compact their context.
      if (proj.heat >= 0.6 && rnd() < 0.12) {
        lines.push(Object.assign({ type: 'system', subtype: 'compact_boundary', timestamp: ts(),
          compactMetadata: { trigger: pickW([['auto', 7], ['manual', 3]]), preTokens: ri(120000, 820000), durationMs: ri(20000, 90000) } }, meta()));
      }
    }
    const id = sessionId();
    fs.writeFileSync(path.join(pdir, id + '.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    allSessions.push({ id, cwd, folder, start: lines[0].timestamp, end: lines[lines.length - 1].timestamp, version, entrypoint, name: title });
  }
}

// --- Sidecar sources (siblings of projects/) --------------------------------

// history.jsonl — submitted-prompt log. ~22% slash commands (so the leaderboard
// has /clear etc.), the rest plain prompts; project = cwd, sessionId carried.
const CMDS = [['/clear', 30], ['/code-review', 6], ['/commit', 7], ['/resume', 5], ['/compact', 3], ['/plan', 4], ['/effort', 3], ['/model', 3], ['/rename', 2], ['/mcp', 2]];
const histLines = [];
for (const s of allSessions) {
  const base = Date.parse(s.start);
  const n = ri(3, 11);
  for (let i = 0; i < n; i++) {
    const display = rnd() < 0.22 ? pickW(CMDS) : pick(PROMPTS);
    histLines.push({ display, pastedContents: rnd() < 0.05 ? { p0: { type: 'text' } } : {}, timestamp: base + i * 60000 + ri(0, 40000), project: s.cwd, sessionId: s.id });
  }
}
fs.writeFileSync(path.join(rootDir, 'history.jsonl'), histLines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// plans/ — plan-mode markdown (title = first heading).
const PLAN_TITLES = ['Add OAuth login flow', 'Refactor the data loader', 'CI/CD pipeline hardening', 'Migrate to the new schema', 'Investigate prod latency', 'Bundle-size optimization', 'Webhook handler design', 'Auth middleware redesign', 'Search indexing rollout'];
fs.mkdirSync(path.join(rootDir, 'plans'), { recursive: true });
PLAN_TITLES.forEach((title, i) => {
  const body = `# ${title}\n\n## Context\n\n` + 'A short synthetic plan body. '.repeat(ri(20, 220));
  fs.writeFileSync(path.join(rootDir, 'plans', `plan-${i + 1}.md`), body);
});

// file-history/<sessionId>/<hash>@vN — versioned snapshots → code churn.
fs.mkdirSync(path.join(rootDir, 'file-history'), { recursive: true });
for (const s of allSessions) {
  if (rnd() < 0.4) continue; // ~60% of sessions touched files
  const sdir = path.join(rootDir, 'file-history', s.id);
  fs.mkdirSync(sdir, { recursive: true });
  const nFiles = ri(1, 3);
  for (let f = 0; f < nFiles; f++) {
    const hash = hex(16);
    const nVers = ri(2, 4);
    let body = Array.from({ length: ri(25, 140) }, (_, k) => `${pick(SRC_NAMES)}_${k} = ${hex(6)}`);
    for (let v = 1; v <= nVers; v++) {
      fs.writeFileSync(path.join(sdir, `${hash}@v${v}`), body.join('\n') + '\n');
      for (let a = ri(2, 15); a > 0; a--) body.splice(ri(0, body.length), 0, `added_v${v}_${hex(5)} = ${hex(6)}`);
      for (let r = ri(0, 6); r > 0 && body.length > 6; r--) body.splice(ri(0, body.length - 1), 1);
    }
  }
}

// sessions/ — a small live registry ("running now").
fs.mkdirSync(path.join(rootDir, 'sessions'), { recursive: true });
const now = Date.now();
allSessions.slice(0, 4).forEach((s, i) => {
  fs.writeFileSync(path.join(rootDir, 'sessions', `${1000 + i}.json`), JSON.stringify({
    pid: 1000 + i, sessionId: s.id, cwd: s.cwd, startedAt: now - ri(600000, 7200000),
    version: s.version, kind: 'interactive', entrypoint: s.entrypoint,
    status: i % 2 ? 'idle' : 'busy', updatedAt: now - ri(0, 300000), name: s.name,
  }));
});

// tasks/ — background-task dirs.
fs.mkdirSync(path.join(rootDir, 'tasks'), { recursive: true });
for (let i = ri(4, 8); i > 0; i--) {
  const td = path.join(rootDir, 'tasks', sessionId());
  fs.mkdirSync(td, { recursive: true });
  fs.writeFileSync(path.join(td, '.highwatermark'), String(ri(1, 40)));
}

console.log(`Wrote ${PROJECTS.length} demo projects, ${totalSessions} sessions to ${outDir}`);
console.log(`Sidecars in ${rootDir}: history.jsonl, plans/, file-history/, sessions/, tasks/`);
