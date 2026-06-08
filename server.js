'use strict';

/*
 * Claude Insights — ROI / cost analyzer for Claude Code projects.
 *
 * Reads the session transcripts under ~/.claude/projects, attributes token
 * usage to a per-model price, and exposes the aggregates over a tiny HTTP API.
 * No external dependencies — Node's standard library only.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 4317;
const HOST = process.env.HOST || '127.0.0.1';
const PROJECTS_DIR =
  process.env.CLAUDE_PROJECTS_DIR ||
  path.join(os.homedir(), '.claude', 'projects');
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Pricing (USD per 1M tokens) --------------------------------------------
// Source: Claude API model pricing. Cache reads bill at ~0.1x the input rate;
// cache writes at 1.25x (5-minute TTL) or 2x (1-hour TTL).
const PRICING = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
};
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;

function modelFamily(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'opus'; // sensible default for unknown Claude models
}

function usageCost(u, family) {
  const rate = PRICING[family] || PRICING.opus;
  const inRate = rate.input / 1e6;
  const outRate = rate.output / 1e6;
  let c = 0;
  c += (u.input_tokens || 0) * inRate;
  c += (u.output_tokens || 0) * outRate;
  c += (u.cache_read_input_tokens || 0) * inRate * CACHE_READ_MULT;
  const cc = u.cache_creation || {};
  const w5 = cc.ephemeral_5m_input_tokens;
  const w1 = cc.ephemeral_1h_input_tokens;
  if (w5 != null || w1 != null) {
    c += (w5 || 0) * inRate * CACHE_WRITE_5M_MULT;
    c += (w1 || 0) * inRate * CACHE_WRITE_1H_MULT;
  } else {
    c += (u.cache_creation_input_tokens || 0) * inRate * CACHE_WRITE_5M_MULT;
  }
  return c;
}

// --- Transcript parsing (cached by file mtime + size) -----------------------
const sessionCache = new Map(); // filePath -> { mtimeMs, size, data }

function parseSession(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const cached = sessionCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.data;
  }

  const data = {
    id: path.basename(filePath, '.jsonl'),
    cwd: null,
    title: null,
    firstPrompt: null,
    gitBranch: null,
    start: null,
    end: null,
    models: {}, // family -> message count
    userPrompts: 0,
    assistantMessages: 0,
    toolUses: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    costByFamily: {}, // family -> cost
    tools: {}, // tool name -> count
    daily: {}, // YYYY-MM-DD -> { cost, messages, userPrompts }
  };

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const touchDay = (ts) => {
    if (!ts) return null;
    const day = ts.slice(0, 10);
    if (!data.daily[day]) data.daily[day] = { cost: 0, messages: 0, userPrompts: 0 };
    return data.daily[day];
  };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (o.cwd && !data.cwd) data.cwd = o.cwd;
    if (o.gitBranch && !data.gitBranch) data.gitBranch = o.gitBranch;
    if (o.timestamp) {
      if (!data.start || o.timestamp < data.start) data.start = o.timestamp;
      if (!data.end || o.timestamp > data.end) data.end = o.timestamp;
    }

    if (o.type === 'ai-title' && o.aiTitle) {
      data.title = o.aiTitle;
    }

    if (o.type === 'user') {
      const content = o.message && o.message.content;
      // Count only genuine human prompts (string content), not tool_result turns.
      if (typeof content === 'string' && content.trim()) {
        data.userPrompts += 1;
        if (!data.firstPrompt) data.firstPrompt = content;
        const d = touchDay(o.timestamp);
        if (d) d.userPrompts += 1;
      }
    }

    if (o.type === 'assistant' && o.message) {
      data.assistantMessages += 1;
      const msg = o.message;
      const family = modelFamily(msg.model);
      data.models[family] = (data.models[family] || 0) + 1;

      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b && b.type === 'tool_use') {
            data.toolUses += 1;
            const name = b.name || 'unknown';
            data.tools[name] = (data.tools[name] || 0) + 1;
          }
        }
      }

      const u = msg.usage;
      if (u) {
        data.tokens.input += u.input_tokens || 0;
        data.tokens.output += u.output_tokens || 0;
        data.tokens.cacheRead += u.cache_read_input_tokens || 0;
        data.tokens.cacheWrite += u.cache_creation_input_tokens || 0;
        const c = usageCost(u, family);
        data.cost += c;
        data.costByFamily[family] = (data.costByFamily[family] || 0) + c;
        const d = touchDay(o.timestamp);
        if (d) {
          d.cost += c;
          d.messages += 1;
        }
      }
    }
  }

  sessionCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, data });
  return data;
}

function listSessionFiles(projectPath) {
  let entries;
  try {
    entries = fs.readdirSync(projectPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => path.join(projectPath, e.name));
}

function emptyTotals() {
  return {
    sessions: 0,
    sessionsWithActivity: 0,
    userPrompts: 0,
    assistantMessages: 0,
    toolUses: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    costByFamily: {},
    models: {},
    start: null,
    end: null,
  };
}

function mergeSessionInto(t, s) {
  t.sessions += 1;
  if (s.assistantMessages > 0 || s.userPrompts > 0) t.sessionsWithActivity += 1;
  t.userPrompts += s.userPrompts;
  t.assistantMessages += s.assistantMessages;
  t.toolUses += s.toolUses;
  t.tokens.input += s.tokens.input;
  t.tokens.output += s.tokens.output;
  t.tokens.cacheRead += s.tokens.cacheRead;
  t.tokens.cacheWrite += s.tokens.cacheWrite;
  t.cost += s.cost;
  for (const [f, c] of Object.entries(s.costByFamily)) {
    t.costByFamily[f] = (t.costByFamily[f] || 0) + c;
  }
  for (const [f, n] of Object.entries(s.models)) {
    t.models[f] = (t.models[f] || 0) + n;
  }
  if (s.start && (!t.start || s.start < t.start)) t.start = s.start;
  if (s.end && (!t.end || s.end > t.end)) t.end = s.end;
}

// Cache savings: tokens served from cache would otherwise have cost full input
// price; instead they cost ~0.1x. Saved = read tokens * inRate * 0.9.
function cacheSavings(costByFamilyTokens) {
  return costByFamilyTokens;
}

function projectName(folder, cwd) {
  if (cwd) return path.basename(cwd) || cwd;
  // Fallback: best-effort decode of the dash-encoded folder name.
  return folder.replace(/^-/, '').replace(/-/g, '/');
}

function listProjects() {
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const folder = e.name;
    const projectPath = path.join(PROJECTS_DIR, folder);
    const files = listSessionFiles(projectPath);
    if (files.length === 0) continue;

    const totals = emptyTotals();
    let cwd = null;
    let savedFromCache = 0;
    for (const f of files) {
      const s = parseSession(f);
      if (!s) continue;
      if (s.cwd && !cwd) cwd = s.cwd;
      mergeSessionInto(totals, s);
      const fam = Object.keys(s.costByFamily)[0] || modelFamily(null);
      const inRate = (PRICING[fam] || PRICING.opus).input / 1e6;
      savedFromCache += s.tokens.cacheRead * inRate * (1 - CACHE_READ_MULT);
    }

    projects.push({
      id: folder,
      name: projectName(folder, cwd),
      cwd: cwd || projectName(folder, null),
      sessions: totals.sessions,
      userPrompts: totals.userPrompts,
      cost: totals.cost,
      tokens: totals.tokens,
      cacheSavings: savedFromCache,
      lastActive: totals.end,
      firstActive: totals.start,
      models: totals.models,
    });
  }
  // Most recently active first.
  projects.sort((a, b) => (b.lastActive || '').localeCompare(a.lastActive || ''));
  return projects;
}

function projectDetail(folder) {
  const projectPath = path.join(PROJECTS_DIR, folder);
  const files = listSessionFiles(projectPath);
  if (files.length === 0) return null;

  const totals = emptyTotals();
  const daily = {}; // date -> { cost, messages, userPrompts }
  const tools = {}; // tool -> count
  let cwd = null;
  let gitBranch = null;
  let savedFromCache = 0;
  const sessions = [];

  for (const f of files) {
    const s = parseSession(f);
    if (!s) continue;
    if (s.cwd && !cwd) cwd = s.cwd;
    if (s.gitBranch && !gitBranch) gitBranch = s.gitBranch;
    mergeSessionInto(totals, s);

    const fam = Object.keys(s.costByFamily)[0] || modelFamily(null);
    const inRate = (PRICING[fam] || PRICING.opus).input / 1e6;
    savedFromCache += s.tokens.cacheRead * inRate * (1 - CACHE_READ_MULT);

    for (const [day, v] of Object.entries(s.daily)) {
      if (!daily[day]) daily[day] = { cost: 0, messages: 0, userPrompts: 0 };
      daily[day].cost += v.cost;
      daily[day].messages += v.messages;
      daily[day].userPrompts += v.userPrompts;
    }
    for (const [name, n] of Object.entries(s.tools)) {
      tools[name] = (tools[name] || 0) + n;
    }

    sessions.push({
      id: s.id,
      title: s.title || (s.firstPrompt ? s.firstPrompt.slice(0, 80) : '(untitled)'),
      firstPrompt: s.firstPrompt,
      cost: s.cost,
      userPrompts: s.userPrompts,
      assistantMessages: s.assistantMessages,
      toolUses: s.toolUses,
      tokens: s.tokens,
      models: s.models,
      start: s.start,
      end: s.end,
    });
  }

  sessions.sort((a, b) => (b.end || '').localeCompare(a.end || ''));

  const dailyArr = Object.entries(daily)
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const topTools = Object.entries(tools)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    id: folder,
    name: projectName(folder, cwd),
    cwd: cwd || projectName(folder, null),
    gitBranch,
    totals,
    cacheSavings: savedFromCache,
    perSession: {
      cost: totals.sessionsWithActivity ? totals.cost / totals.sessionsWithActivity : 0,
      prompt: totals.userPrompts ? totals.cost / totals.userPrompts : 0,
    },
    daily: dailyArr,
    topTools,
    sessions,
  };
}

// Aggregate across every project into a single rollup view.
function overview() {
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }

  const totals = emptyTotals();
  const daily = {}; // date -> { cost, messages, userPrompts }
  const tools = {}; // tool -> count
  let savedFromCache = 0;
  let projectCount = 0;
  const projects = []; // leaderboard rows

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const projectPath = path.join(PROJECTS_DIR, e.name);
    const files = listSessionFiles(projectPath);
    if (files.length === 0) continue;

    const pTotals = emptyTotals();
    let cwd = null;
    let pSaved = 0;

    for (const f of files) {
      const s = parseSession(f);
      if (!s) continue;
      if (s.cwd && !cwd) cwd = s.cwd;
      mergeSessionInto(totals, s);
      mergeSessionInto(pTotals, s);

      const fam = Object.keys(s.costByFamily)[0] || modelFamily(null);
      const inRate = (PRICING[fam] || PRICING.opus).input / 1e6;
      const sv = s.tokens.cacheRead * inRate * (1 - CACHE_READ_MULT);
      savedFromCache += sv;
      pSaved += sv;

      for (const [day, v] of Object.entries(s.daily)) {
        if (!daily[day]) daily[day] = { cost: 0, messages: 0, userPrompts: 0 };
        daily[day].cost += v.cost;
        daily[day].messages += v.messages;
        daily[day].userPrompts += v.userPrompts;
      }
      for (const [name, n] of Object.entries(s.tools)) {
        tools[name] = (tools[name] || 0) + n;
      }
    }

    projectCount += 1;
    projects.push({
      id: e.name,
      name: projectName(e.name, cwd),
      cwd: cwd || projectName(e.name, null),
      sessions: pTotals.sessions,
      userPrompts: pTotals.userPrompts,
      toolUses: pTotals.toolUses,
      cost: pTotals.cost,
      cacheSavings: pSaved,
      lastActive: pTotals.end,
    });
  }

  projects.sort((a, b) => b.cost - a.cost);

  const dailyArr = Object.entries(daily)
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const topTools = Object.entries(tools)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    projectCount,
    totals,
    cacheSavings: savedFromCache,
    perSession: {
      cost: totals.sessionsWithActivity ? totals.cost / totals.sessionsWithActivity : 0,
      prompt: totals.userPrompts ? totals.cost / totals.userPrompts : 0,
    },
    daily: dailyArr,
    topTools,
    projects,
  };
}

// --- HTTP -------------------------------------------------------------------
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(file);
    const type =
      ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.js'
        ? 'text/javascript; charset=utf-8'
        : ext === '.css'
        ? 'text/css; charset=utf-8'
        : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    if (pathname === '/api/projects') {
      return sendJSON(res, 200, {
        projectsDir: PROJECTS_DIR,
        pricing: PRICING,
        projects: listProjects(),
      });
    }
    if (pathname === '/api/overview') {
      const ov = overview();
      if (!ov) return sendJSON(res, 404, { error: 'no projects' });
      return sendJSON(res, 200, ov);
    }
    if (pathname.startsWith('/api/project/')) {
      const id = pathname.slice('/api/project/'.length);
      const detail = projectDetail(id);
      if (!detail) return sendJSON(res, 404, { error: 'project not found' });
      return sendJSON(res, 200, detail);
    }
    if (pathname === '/' || pathname === '/index.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    // Static assets under public/
    const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const file = path.join(PUBLIC_DIR, safe);
    if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return sendFile(res, file);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    sendJSON(res, 500, { error: String((err && err.message) || err) });
  }
});

// On a shared host, default to localhost so one user's prompts/costs aren't
// exposed to everyone on the machine (and the network). Reach it via SSH tunnel,
// or set HOST=0.0.0.0 to opt into LAN access. If PORT is unset, auto-pick a free
// one so simultaneous users on the same box don't collide.
const portWasSet = process.env.PORT != null;

function listen(port, triesLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && !portWasSet && triesLeft > 0) {
      listen(port + 1, triesLeft - 1);
    } else if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Set PORT=<a free port> and retry.`);
      process.exit(1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
    console.log(`Claude Insights → http://${shown}:${port}`);
    console.log(`Reading projects from: ${PROJECTS_DIR}`);
    if (HOST === '127.0.0.1') {
      console.log(
        `Localhost-only. From your laptop:  ssh -L ${port}:localhost:${port} <you>@<this-host>  then open http://localhost:${port}`
      );
    }
  });
}

listen(Number(PORT) || 4317, 50);
