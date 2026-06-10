'use strict';

// HTTP / endpoint-level tests. Every other suite calls the exported pure
// functions directly; this one boots the real server on an ephemeral port (the
// module exports `server` but only auto-listens when run as `main`) and drives
// it over actual HTTP — so the routing, status codes, response shapes, the
// CSV / Markdown / Prometheus exports, the session-route path-traversal guards,
// and the date-parameter validation are exercised end to end, not just the math.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// One session, dated today (UTC) so it lands in every relative date filter.
const TODAY = new Date().toISOString().slice(0, 10);
const ts = (s) => `${TODAY}T10:00:${s}.000Z`;
const OBJS = [
  { type: 'ai-title', aiTitle: 'HTTP test session', timestamp: ts('00') },
  { type: 'user', cwd: '/home/demo/acme', gitBranch: 'main', entrypoint: 'cli', timestamp: ts('05'),
    message: { content: 'Build the thing.' } },
  { type: 'assistant', entrypoint: 'cli', timestamp: ts('10'),
    message: { model: 'claude-opus-4-8',
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000,
        cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 100 } },
      content: [ { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/home/demo/acme/x.js' } },
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'git commit -m "x"' } } ] } },
  { type: 'system', subtype: 'turn_duration', timestamp: ts('20'), durationMs: 30000 },
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-http-'));
const projectsDir = path.join(root, 'projects');
const folder = '-home-demo-acme';
const sessId = 'sess-http-1';
fs.mkdirSync(path.join(projectsDir, folder), { recursive: true });
fs.writeFileSync(path.join(projectsDir, folder, sessId + '.jsonl'),
  OBJS.map((o) => JSON.stringify(o)).join('\n') + '\n');

process.env.CLAUDE_PROJECTS_DIR = projectsDir;
delete process.env.CLAUDE_LEDGER_DATA; // keep the read-only default — no persistence
delete process.env.LEDGER_PERSIST;
const L = require('../server.js'); // must come after the env is set

let port;
before(() => new Promise((resolve) => {
  L.server.listen(0, '127.0.0.1', () => { port = L.server.address().port; resolve(); });
}));
after(() => {
  L.server.close();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

// Raw GET against an explicit path so the client never normalizes `..` away —
// the path-traversal cases need to reach the server verbatim.
function get(rawPath) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}
const json = (r) => JSON.parse(r.body);

test('GET /api/projects lists the project with pricing + bounds', async () => {
  const r = await get('/api/projects');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /application\/json/);
  const b = json(r);
  assert.equal(b.projectsDir, projectsDir);
  assert.ok(b.pricing && b.pricing.opus, 'pricing block present');
  assert.ok(b.bounds && b.bounds.min && b.bounds.max, 'date bounds present');
  const p = b.projects.find((x) => x.id === folder);
  assert.ok(p, 'our project is listed by folder id');
  assert.ok(p.cost > 0);
});

test('GET /api/overview returns priced totals + output metrics', async () => {
  const r = await get('/api/overview');
  assert.equal(r.status, 200);
  const b = json(r);
  assert.equal(b.projectCount, 1);
  assert.ok(b.totals.cost > 0);
  assert.equal(b.output.commits, 1);
  assert.equal(b.output.filesEdited, 1);
});

test('GET /api/project/:id returns the session table', async () => {
  const r = await get(`/api/project/${folder}`);
  assert.equal(r.status, 200);
  const b = json(r);
  assert.equal(b.id, folder);
  assert.equal(b.sessions.length, 1);
  assert.equal(b.sessions[0].id, sessId);
  assert.ok(b.sessions[0].cost > 0);
});

test('GET /api/project/:id 404s for an unknown project', async () => {
  const r = await get('/api/project/-does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(json(r).error, 'project not found');
});

test('GET /api/session/:project/:id returns prompts + title', async () => {
  const r = await get(`/api/session/${folder}/${sessId}`);
  assert.equal(r.status, 200);
  const b = json(r);
  assert.equal(b.id, sessId);
  assert.equal(b.projectId, folder);
  assert.equal(b.title, 'HTTP test session');
  assert.ok(Array.isArray(b.prompts) && b.prompts.length >= 1);
  assert.equal(b.parseErrors, 0); // clean transcript → no skipped lines
});

test('GET /api/session 404s for an unknown session id', async () => {
  const r = await get(`/api/session/${folder}/nope`);
  assert.equal(r.status, 404);
  assert.equal(json(r).error, 'session not found');
});

test('GET /api/session with no project/session split is a 400', async () => {
  const r = await get('/api/session/onlyfolder');
  assert.equal(r.status, 400);
  assert.equal(json(r).error, 'bad session path');
});

test('GET /api/session rejects path traversal (no escape from PROJECTS_DIR)', async () => {
  // %2f survives the URL parse; decodeURIComponent turns it into ../../passwd,
  // which resolveProjectDir + the session-id regex must both refuse → 404.
  const r = await get('/api/session/..%2f..%2fpasswd');
  assert.equal(r.status, 404, 'traversal must not 200 or 500');
});

test('GET /api/overview.csv is an attachment with a Project column', async () => {
  const r = await get('/api/overview.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.match(r.headers['content-disposition'], /attachment; filename=/);
  assert.match(r.body.split('\n')[0], /Project/);
});

test('GET /api/project/:id.csv exports the sessions with a Title column', async () => {
  const r = await get(`/api/project/${folder}.csv`);
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.match(r.body.split('\n')[0], /Title/);
});

test('GET /api/worklog.md serves markdown', async () => {
  const r = await get('/api/worklog.md');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/markdown/);
});

test('GET /metrics exposes Prometheus gauges', async () => {
  const r = await get('/metrics');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/plain/);
  assert.match(r.body, /claude_ledger_spend_usd /);
});

test('GET / serves the dashboard HTML', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.body, /<html/i);
});

test('unknown route is a 404', async () => {
  const r = await get('/no/such/thing.js');
  assert.equal(r.status, 404);
});

// --- Date-parameter validation (#2) ----------------------------------------

test('a wide valid range still includes today\'s session', async () => {
  const r = await get('/api/overview?from=2000-01-01&to=2999-12-31');
  assert.equal(r.status, 200);
  assert.equal(json(r).projectCount, 1);
});

test('a valid range that excludes today filters everything out', async () => {
  const r = await get('/api/overview?from=2999-01-01&to=2999-12-31');
  assert.equal(r.status, 200);
  assert.equal(json(r).projectCount, 0); // filtering works end to end, not a 400
});

test('malformed and impossible dates are rejected with 400 (not silently wrong)', async () => {
  for (const bad of ['foo', '2026-13-40', '2026-02-30', '26-01-01', '2026-1-1']) {
    const rf = await get(`/api/overview?from=${bad}`);
    assert.equal(rf.status, 400, `from=${bad} should 400`);
    assert.match(json(rf).error, /invalid date/);
    const rt = await get(`/api/project/${folder}?to=${bad}`);
    assert.equal(rt.status, 400, `to=${bad} should 400 on project route too`);
  }
});
