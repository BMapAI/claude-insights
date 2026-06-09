'use strict';

/*
 * Claude Ledger — ROI / cost analyzer for Claude Code projects.
 *
 * Reads the session transcripts under ~/.claude/projects, keeps per-day /
 * per-model token counts, and prices them at query time (so date filtering and
 * a live pricing.json both work without re-parsing). No external dependencies.
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
const PRICING_FILE = process.env.PRICING_FILE || path.join(__dirname, 'pricing.json');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'config.json');

// --- Pricing ----------------------------------------------------------------
// USD per 1M tokens. Cache reads bill at ~0.1x input; cache writes at 1.25x
// (5-minute TTL) or 2x (1-hour TTL). Overridable via pricing.json (hot-reloaded
// on change) so users can match their actual rates without editing code.
const DEFAULT_PRICING = {
  opus: { input: 5, output: 25 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  cacheReadMultiplier: 0.1,
  cacheWrite5mMultiplier: 1.25,
  cacheWrite1hMultiplier: 2.0,
};

// Validate a parsed pricing.json. Every field is optional (partial overrides are
// allowed), but anything present must be a non-negative finite number so a typo
// can't silently produce nonsense costs. Returns the list of problems (empty = ok).
function validatePricing(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return ['top-level value must be a JSON object'];
  }
  const errors = [];
  const checkNum = (val, label) => {
    if (typeof val !== 'number' || !isFinite(val) || val < 0) {
      errors.push(`"${label}" must be a non-negative number`);
    }
  };
  for (const fam of ['opus', 'sonnet', 'haiku']) {
    if (raw[fam] == null) continue;
    if (typeof raw[fam] !== 'object' || Array.isArray(raw[fam])) {
      errors.push(`"${fam}" must be an object with input/output rates`);
      continue;
    }
    for (const k of ['input', 'output']) {
      if (raw[fam][k] != null) checkNum(raw[fam][k], `${fam}.${k}`);
    }
  }
  for (const k of ['cacheReadMultiplier', 'cacheWrite5mMultiplier', 'cacheWrite1hMultiplier']) {
    if (raw[k] != null) checkNum(raw[k], k);
  }
  return errors;
}

// Loads + caches pricing keyed by file mtime. A missing file is the normal case
// (built-in defaults, silent). A file that exists but is malformed or has bad
// values is a misconfiguration: warn loudly (once per version) and fall back to
// defaults rather than silently pricing at rates the user thinks they overrode.
let pricingCache = { mtimeMs: null, value: DEFAULT_PRICING, fromFile: false };
function loadPricing() {
  let st;
  try {
    st = fs.statSync(PRICING_FILE);
  } catch {
    pricingCache = { mtimeMs: null, value: DEFAULT_PRICING, fromFile: false };
    return pricingCache;
  }
  if (pricingCache.mtimeMs === st.mtimeMs) return pricingCache;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8'));
  } catch (err) {
    console.error(`[pricing] ${PRICING_FILE} is not valid JSON (${err.message}). Using built-in default rates.`);
    pricingCache = { mtimeMs: st.mtimeMs, value: DEFAULT_PRICING, fromFile: false };
    return pricingCache;
  }
  const errors = validatePricing(raw);
  if (errors.length) {
    console.error(
      `[pricing] ${PRICING_FILE} has invalid values; using built-in default rates instead:\n  - ` +
        errors.join('\n  - ')
    );
    pricingCache = { mtimeMs: st.mtimeMs, value: DEFAULT_PRICING, fromFile: false };
    return pricingCache;
  }
  const merged = {
    ...DEFAULT_PRICING,
    ...raw,
    opus: { ...DEFAULT_PRICING.opus, ...(raw.opus || {}) },
    sonnet: { ...DEFAULT_PRICING.sonnet, ...(raw.sonnet || {}) },
    haiku: { ...DEFAULT_PRICING.haiku, ...(raw.haiku || {}) },
  };
  pricingCache = { mtimeMs: st.mtimeMs, value: merged, fromFile: true };
  return pricingCache;
}
function getPricing() {
  return loadPricing().value;
}
// True only when a valid pricing.json is actually driving the displayed rates.
function pricingIsFromFile() {
  return loadPricing().fromFile;
}

// Monthly budget (USD): MONTHLY_BUDGET env wins, else config.json's monthlyBudget.
// null = no budget set (projection still shown). Read fresh each call (tiny file).
function getMonthlyBudget() {
  const env = process.env.MONTHLY_BUDGET;
  if (env != null && env !== '') {
    const n = Number(env);
    return isFinite(n) ? n : null;
  }
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (c.monthlyBudget == null) return null;
    const n = Number(c.monthlyBudget);
    return isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Current calendar month bounds for budget/projection. Computed in UTC so the
// month window and "today" align with the day-keys, which come from slicing the
// transcripts' ISO-Z (UTC) timestamps (see dayOf). Using local time here would
// drift off-by-one against those keys on any non-UTC host.
function currentMonthInfo() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const pad = (n) => String(n).padStart(2, '0');
  return {
    monthStart: `${y}-${pad(m + 1)}-01`,
    today: `${y}-${pad(m + 1)}-${pad(now.getUTCDate())}`,
    daysElapsed: now.getUTCDate(),
    daysInMonth: new Date(Date.UTC(y, m + 1, 0)).getUTCDate(),
  };
}

// Shift a YYYY-MM-DD string by N days (UTC, avoids DST/TZ drift).
function shiftDay(dayStr, deltaDays) {
  const d = new Date(dayStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// The equal-length period immediately before [from, to]. Null for an unbounded range.
function previousPeriod(from, to) {
  if (!from || !to) return null;
  const len = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
  if (!isFinite(len) || len <= 0) return null;
  const prevTo = shiftDay(from, -1);
  const prevFrom = shiftDay(prevTo, -(len - 1));
  return { from: prevFrom, to: prevTo, len };
}

// Build a delta object comparing current vs previous totals.
function makeDelta(prev, curCost, prevCost, curPrompts, prevPrompts) {
  return {
    prevFrom: prev.from,
    prevTo: prev.to,
    days: prev.len,
    prevCost,
    costChange: curCost - prevCost,
    costPct: prevCost > 0 ? (curCost - prevCost) / prevCost : null,
    prevPrompts,
    promptsChange: curPrompts - prevPrompts,
    promptsPct: prevPrompts > 0 ? (curPrompts - prevPrompts) / prevPrompts : null,
  };
}

function modelFamily(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'opus'; // sensible default for unknown Claude models
}

function emptyBundle() {
  return { input: 0, output: 0, cacheRead: 0, cw5: 0, cw1: 0, cwOther: 0 };
}
function addBundle(dst, src) {
  dst.input += src.input;
  dst.output += src.output;
  dst.cacheRead += src.cacheRead;
  dst.cw5 += src.cw5;
  dst.cw1 += src.cw1;
  dst.cwOther += src.cwOther;
}

// Build a token bundle from one message's usage block (5m/1h cache-write split
// when present, else the lumped legacy field).
function usageToBundle(u) {
  const b = emptyBundle();
  if (!u) return b;
  b.input = u.input_tokens || 0;
  b.output = u.output_tokens || 0;
  b.cacheRead = u.cache_read_input_tokens || 0;
  const cc = u.cache_creation || {};
  if (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null) {
    b.cw5 = cc.ephemeral_5m_input_tokens || 0;
    b.cw1 = cc.ephemeral_1h_input_tokens || 0;
  } else {
    b.cwOther = u.cache_creation_input_tokens || 0;
  }
  return b;
}

// Attribution maps are { name: { family: bundle } } — a token bundle per model
// family so each name can be priced at its own blended rate.
function nestFam(map, name, fam) {
  if (!map[name]) map[name] = {};
  if (!map[name][fam]) map[name][fam] = emptyBundle();
  return map[name][fam];
}
function mergeByName(dst, src) {
  for (const [name, byFam] of Object.entries(src)) {
    for (const [fam, b] of Object.entries(byFam)) addBundle(nestFam(dst, name, fam), b);
  }
}

// Price a { family: bundle } map at current rates.
function priceBundles(byFamily) {
  const P = getPricing();
  let cost = 0;
  let cacheSavings = 0;
  const costByFamily = {};
  const models = {};
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const [fam, b] of Object.entries(byFamily)) {
    const rate = P[fam] || P.opus;
    const inRate = rate.input / 1e6;
    const outRate = rate.output / 1e6;
    let c = 0;
    c += b.input * inRate;
    c += b.output * outRate;
    c += b.cacheRead * inRate * P.cacheReadMultiplier;
    c += b.cw5 * inRate * P.cacheWrite5mMultiplier;
    c += b.cw1 * inRate * P.cacheWrite1hMultiplier;
    c += b.cwOther * inRate * P.cacheWrite5mMultiplier;
    cost += c;
    costByFamily[fam] = (costByFamily[fam] || 0) + c;
    cacheSavings += b.cacheRead * inRate * (1 - P.cacheReadMultiplier);
    models[fam] = true;
    tokens.input += b.input;
    tokens.output += b.output;
    tokens.cacheRead += b.cacheRead;
    tokens.cacheWrite += b.cw5 + b.cw1 + b.cwOther;
  }
  return { cost, costByFamily, cacheSavings, tokens, models: Object.keys(models) };
}

// Price a { name: { family: bundle } } attribution map into a cost-sorted list.
function priceByName(byName) {
  return Object.entries(byName)
    .map(([name, byFam]) => {
      const p = priceBundles(byFam);
      const tk = p.tokens;
      return { name, cost: p.cost, tokens: tk.input + tk.output + tk.cacheRead + tk.cacheWrite };
    })
    .sort((a, b) => b.cost - a.cost);
}

// Efficiency ratios + cost composition + what-if repricing, from a { family: bundle } map.
function efficiencyStats(grand, userPrompts, toolUses) {
  const P = getPricing();
  const priced = priceBundles(grand);
  const tk = priced.tokens;
  const total = tk.input + tk.output + tk.cacheRead + tk.cacheWrite;
  const inputSide = tk.input + tk.cacheRead + tk.cacheWrite;

  // Real cost composition: price each token category at each family's own rate.
  const composition = { output: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
  const agg = emptyBundle();
  for (const [fam, b] of Object.entries(grand)) {
    const rate = P[fam] || P.opus;
    const inR = rate.input / 1e6;
    const outR = rate.output / 1e6;
    composition.output += b.output * outR;
    composition.input += b.input * inR;
    composition.cacheRead += b.cacheRead * inR * P.cacheReadMultiplier;
    composition.cacheWrite +=
      (b.cw5 * P.cacheWrite5mMultiplier + b.cw1 * P.cacheWrite1hMultiplier + b.cwOther * P.cacheWrite5mMultiplier) * inR;
    addBundle(agg, b);
  }

  // What-if: price the exact same tokens as if they all ran on one model.
  const whatIf = {
    opus: priceBundles({ opus: agg }).cost,
    sonnet: priceBundles({ sonnet: agg }).cost,
    haiku: priceBundles({ haiku: agg }).cost,
  };

  return {
    cost: priced.cost,
    cacheHitRate: inputSide > 0 ? tk.cacheRead / inputSide : 0,
    blendedPerMtok: total > 0 ? (priced.cost / total) * 1e6 : 0,
    outputShare: total > 0 ? tk.output / total : 0,
    tokensPerPrompt: userPrompts > 0 ? total / userPrompts : 0,
    toolsPerPrompt: userPrompts > 0 ? toolUses / userPrompts : 0,
    composition,
    whatIf,
  };
}

// --- Transcript parsing (cached by file mtime + size) -----------------------
// Stores raw token counts per day per model family; cost is computed later.
const sessionCache = new Map();

function dayOf(ts, fallback) {
  return (ts || fallback || '1970-01-01T00:00:00Z').slice(0, 10);
}

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
    days: {}, // 'YYYY-MM-DD' -> { userPrompts, assistantMessages, toolUses, tools:{}, byFamily:{} }
  };

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const getDay = (ts) => {
    const key = dayOf(ts, data.start);
    if (!data.days[key]) {
      data.days[key] = { userPrompts: 0, assistantMessages: 0, toolUses: 0, tools: {}, byFamily: {}, bySkill: {}, byMcp: {} };
    }
    return data.days[key];
  };
  const getFam = (day, fam) => {
    if (!day.byFamily[fam]) day.byFamily[fam] = emptyBundle();
    return day.byFamily[fam];
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
    if (o.type === 'ai-title' && o.aiTitle) data.title = o.aiTitle;

    if (o.type === 'user') {
      const content = o.message && o.message.content;
      if (typeof content === 'string' && content.trim()) {
        if (!data.firstPrompt) data.firstPrompt = content;
        getDay(o.timestamp).userPrompts += 1;
      }
    }

    if (o.type === 'assistant' && o.message) {
      const msg = o.message;
      const family = modelFamily(msg.model);
      const day = getDay(o.timestamp);
      day.assistantMessages += 1;

      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b && b.type === 'tool_use') {
            day.toolUses += 1;
            const name = b.name || 'unknown';
            day.tools[name] = (day.tools[name] || 0) + 1;
          }
        }
      }

      const u = msg.usage;
      if (u) {
        const bundle = usageToBundle(u);
        addBundle(getFam(day, family), bundle);
        // Attribute the same tokens to the skill / MCP server that drove the turn,
        // when Claude Code tagged the message. Both ride on usage-bearing messages.
        if (o.attributionSkill) addBundle(nestFam(day.bySkill, o.attributionSkill, family), bundle);
        if (o.attributionMcpServer) addBundle(nestFam(day.byMcp, o.attributionMcpServer, family), bundle);
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

// Refuse ids that escape PROJECTS_DIR (path traversal).
function resolveProjectDir(folder) {
  const projectPath = path.join(PROJECTS_DIR, folder);
  const rel = path.relative(PROJECTS_DIR, projectPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    return null;
  }
  return projectPath;
}

function projectName(folder, cwd) {
  if (cwd) return path.basename(cwd) || cwd;
  return folder.replace(/^-/, '').replace(/-/g, '/');
}

// --- Date filtering ---------------------------------------------------------
function inRange(day, from, to) {
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

// Aggregate one parsed session over a date range into a single token bundle map
// plus counts and tools. Returns null contribution if nothing in range.
function aggregateSession(s, from, to) {
  const byFamily = {};
  const bySkill = {};
  const byMcp = {};
  const tools = {};
  let userPrompts = 0;
  let assistantMessages = 0;
  let toolUses = 0;
  let has = false;
  for (const [day, d] of Object.entries(s.days)) {
    if (!inRange(day, from, to)) continue;
    if (d.userPrompts || d.assistantMessages) has = true;
    userPrompts += d.userPrompts;
    assistantMessages += d.assistantMessages;
    toolUses += d.toolUses;
    for (const [n, c] of Object.entries(d.tools)) tools[n] = (tools[n] || 0) + c;
    for (const [fam, b] of Object.entries(d.byFamily)) {
      if (!byFamily[fam]) byFamily[fam] = emptyBundle();
      addBundle(byFamily[fam], b);
    }
    mergeByName(bySkill, d.bySkill || {});
    mergeByName(byMcp, d.byMcp || {});
  }
  return { byFamily, bySkill, byMcp, tools, userPrompts, assistantMessages, toolUses, has };
}

// --- Project-level aggregation ---------------------------------------------
function projectDetail(folder, from, to) {
  const projectPath = resolveProjectDir(folder);
  if (!projectPath) return null;
  const files = listSessionFiles(projectPath);
  if (files.length === 0) return null;

  const grand = {}; // family -> bundle
  const bySkill = {}; // skill name -> family -> bundle
  const byMcp = {}; // mcp server name -> family -> bundle
  const tools = {};
  const dayMap = {}; // date -> { byFamily, messages, userPrompts }
  const prev = previousPeriod(from, to);
  const prevGrand = {};
  let prevPrompts = 0;
  let cwd = null;
  let gitBranch = null;
  let userPrompts = 0;
  let assistantMessages = 0;
  let toolUses = 0;
  let sessionsInRange = 0;
  let dataStart = null;
  let dataEnd = null;
  const sessions = [];

  for (const f of files) {
    const s = parseSession(f);
    if (!s) continue;
    if (s.cwd && !cwd) cwd = s.cwd;
    if (s.gitBranch && !gitBranch) gitBranch = s.gitBranch;

    if (prev) {
      const pa = aggregateSession(s, prev.from, prev.to);
      if (pa.has) {
        prevPrompts += pa.userPrompts;
        for (const [fam, b] of Object.entries(pa.byFamily)) {
          if (!prevGrand[fam]) prevGrand[fam] = emptyBundle();
          addBundle(prevGrand[fam], b);
        }
      }
    }

    const agg = aggregateSession(s, from, to);
    if (!agg.has) continue;
    sessionsInRange += 1;
    userPrompts += agg.userPrompts;
    assistantMessages += agg.assistantMessages;
    toolUses += agg.toolUses;
    for (const [n, c] of Object.entries(agg.tools)) tools[n] = (tools[n] || 0) + c;
    for (const [fam, b] of Object.entries(agg.byFamily)) {
      if (!grand[fam]) grand[fam] = emptyBundle();
      addBundle(grand[fam], b);
    }
    mergeByName(bySkill, agg.bySkill);
    mergeByName(byMcp, agg.byMcp);

    // Per-day rollup for the chart.
    for (const [day, d] of Object.entries(s.days)) {
      if (!inRange(day, from, to)) continue;
      if (!dayMap[day]) dayMap[day] = { byFamily: {}, messages: 0, userPrompts: 0 };
      dayMap[day].messages += d.assistantMessages;
      dayMap[day].userPrompts += d.userPrompts;
      for (const [fam, b] of Object.entries(d.byFamily)) {
        if (!dayMap[day].byFamily[fam]) dayMap[day].byFamily[fam] = emptyBundle();
        addBundle(dayMap[day].byFamily[fam], b);
      }
      if (!dataStart || day < dataStart) dataStart = day;
      if (!dataEnd || day > dataEnd) dataEnd = day;
    }

    const priced = priceBundles(agg.byFamily);
    sessions.push({
      id: s.id,
      title: s.title || (s.firstPrompt ? s.firstPrompt.slice(0, 80) : '(untitled)'),
      firstPrompt: s.firstPrompt,
      cost: priced.cost,
      userPrompts: agg.userPrompts,
      assistantMessages: agg.assistantMessages,
      toolUses: agg.toolUses,
      tokens: priced.tokens,
      models: priced.models,
      start: s.start,
      end: s.end,
    });
  }

  const totals = priceBundles(grand);
  const delta = prev ? makeDelta(prev, totals.cost, priceBundles(prevGrand).cost, userPrompts, prevPrompts) : null;
  sessions.sort((a, b) => (b.end || '').localeCompare(a.end || ''));

  const daily = Object.entries(dayMap)
    .map(([date, v]) => ({ date, cost: priceBundles(v.byFamily).cost, messages: v.messages, userPrompts: v.userPrompts }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const topTools = Object.entries(tools)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    id: folder,
    name: projectName(folder, cwd),
    cwd: cwd || projectName(folder, null),
    gitBranch,
    totals: {
      cost: totals.cost,
      costByFamily: totals.costByFamily,
      tokens: totals.tokens,
      models: totals.models,
      userPrompts,
      assistantMessages,
      toolUses,
      sessions: sessionsInRange,
      sessionsTotal: files.length,
      start: dataStart,
      end: dataEnd,
    },
    cacheSavings: totals.cacheSavings,
    perSession: {
      cost: sessionsInRange ? totals.cost / sessionsInRange : 0,
      prompt: userPrompts ? totals.cost / userPrompts : 0,
    },
    daily,
    topTools,
    topSkills: priceByName(bySkill),
    topMcp: priceByName(byMcp),
    sessions,
    delta,
    efficiency: efficiencyStats(grand, userPrompts, toolUses),
  };
}

// --- All-projects rollup ----------------------------------------------------
function overview(from, to) {
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return null;
  }

  const grand = {};
  const bySkill = {}; // skill name -> family -> bundle
  const byMcp = {}; // mcp server name -> family -> bundle
  const tools = {};
  const dayMap = {};
  const monthGrand = {}; // month-to-date tokens, independent of the selected range
  const M = currentMonthInfo();
  const prev = previousPeriod(from, to); // equal-length window before [from,to]
  const prevGrand = {};
  let prevPrompts = 0;
  let userPrompts = 0;
  let assistantMessages = 0;
  let toolUses = 0;
  let sessionCount = 0;
  let projectCount = 0;
  let dataStart = null;
  let dataEnd = null;
  const projects = [];

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const projectPath = path.join(PROJECTS_DIR, e.name);
    const files = listSessionFiles(projectPath);
    if (files.length === 0) continue;

    const pGrand = {};
    const pPrevGrand = {};
    let pSessions = 0;
    let pPrompts = 0;
    let cwd = null;
    let lastActive = null;
    let active = false;

    for (const f of files) {
      const s = parseSession(f);
      if (!s) continue;
      if (s.cwd && !cwd) cwd = s.cwd;
      if (s.end && (!lastActive || s.end > lastActive)) lastActive = s.end;

      // Month-to-date aggregation (independent of the selected range).
      for (const [day, d] of Object.entries(s.days)) {
        if (day >= M.monthStart && day <= M.today) {
          for (const [fam, b] of Object.entries(d.byFamily)) {
            if (!monthGrand[fam]) monthGrand[fam] = emptyBundle();
            addBundle(monthGrand[fam], b);
          }
        }
      }

      // Previous-period aggregation (for deltas), independent of current range.
      if (prev) {
        const pa = aggregateSession(s, prev.from, prev.to);
        if (pa.has) {
          prevPrompts += pa.userPrompts;
          for (const [fam, b] of Object.entries(pa.byFamily)) {
            if (!prevGrand[fam]) prevGrand[fam] = emptyBundle();
            addBundle(prevGrand[fam], b);
            if (!pPrevGrand[fam]) pPrevGrand[fam] = emptyBundle();
            addBundle(pPrevGrand[fam], b);
          }
        }
      }

      const agg = aggregateSession(s, from, to);
      if (!agg.has) continue;
      active = true;
      pSessions += 1;
      pPrompts += agg.userPrompts;
      for (const [fam, b] of Object.entries(agg.byFamily)) {
        if (!pGrand[fam]) pGrand[fam] = emptyBundle();
        addBundle(pGrand[fam], b);
        if (!grand[fam]) grand[fam] = emptyBundle();
        addBundle(grand[fam], b);
      }
      for (const [n, c] of Object.entries(agg.tools)) tools[n] = (tools[n] || 0) + c;
      mergeByName(bySkill, agg.bySkill);
      mergeByName(byMcp, agg.byMcp);
      userPrompts += agg.userPrompts;
      assistantMessages += agg.assistantMessages;
      toolUses += agg.toolUses;
      sessionCount += 1;

      for (const [day, d] of Object.entries(s.days)) {
        if (!inRange(day, from, to)) continue;
        if (!dayMap[day]) dayMap[day] = { byFamily: {}, messages: 0, userPrompts: 0 };
        dayMap[day].messages += d.assistantMessages;
        dayMap[day].userPrompts += d.userPrompts;
        for (const [fam, b] of Object.entries(d.byFamily)) {
          if (!dayMap[day].byFamily[fam]) dayMap[day].byFamily[fam] = emptyBundle();
          addBundle(dayMap[day].byFamily[fam], b);
        }
        if (!dataStart || day < dataStart) dataStart = day;
        if (!dataEnd || day > dataEnd) dataEnd = day;
      }
    }

    if (active) projectCount += 1;
    const priced = priceBundles(pGrand);
    const prevCost = prev ? priceBundles(pPrevGrand).cost : null;
    projects.push({
      id: e.name,
      name: projectName(e.name, cwd),
      cwd: cwd || projectName(e.name, null),
      sessions: pSessions,
      userPrompts: pPrompts,
      cost: priced.cost,
      cacheSavings: priced.cacheSavings,
      lastActive,
      costPrev: prevCost,
      costPct: prev && prevCost > 0 ? (priced.cost - prevCost) / prevCost : null,
    });
  }

  const totals = priceBundles(grand);
  projects.sort((a, b) => b.cost - a.cost || (b.lastActive || '').localeCompare(a.lastActive || ''));

  const delta = prev ? makeDelta(prev, totals.cost, priceBundles(prevGrand).cost, userPrompts, prevPrompts) : null;

  const monthPriced = priceBundles(monthGrand);
  const monthly = getMonthlyBudget();
  const projectedCost = M.daysElapsed > 0 ? (monthPriced.cost / M.daysElapsed) * M.daysInMonth : monthPriced.cost;
  const budget = {
    monthly,
    monthStart: M.monthStart,
    today: M.today,
    daysElapsed: M.daysElapsed,
    daysInMonth: M.daysInMonth,
    mtdCost: monthPriced.cost,
    projectedCost,
    remaining: monthly != null ? monthly - monthPriced.cost : null,
    pctUsed: monthly ? monthPriced.cost / monthly : null,
    pctProjected: monthly ? projectedCost / monthly : null,
  };

  const daily = Object.entries(dayMap)
    .map(([date, v]) => ({ date, cost: priceBundles(v.byFamily).cost, messages: v.messages, userPrompts: v.userPrompts }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const topTools = Object.entries(tools)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return {
    projectCount,
    totals: {
      cost: totals.cost,
      costByFamily: totals.costByFamily,
      tokens: totals.tokens,
      models: totals.models,
      userPrompts,
      assistantMessages,
      toolUses,
      sessions: sessionCount,
      start: dataStart,
      end: dataEnd,
    },
    cacheSavings: totals.cacheSavings,
    perSession: {
      cost: sessionCount ? totals.cost / sessionCount : 0,
      prompt: userPrompts ? totals.cost / userPrompts : 0,
    },
    daily,
    topTools,
    topSkills: priceByName(bySkill),
    topMcp: priceByName(byMcp),
    projects,
    budget,
    delta,
    efficiency: efficiencyStats(grand, userPrompts, toolUses),
  };
}

// --- Sidebar list + global date bounds --------------------------------------
function listProjects(from, to) {
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return { projects: [], bounds: { min: null, max: null } };
  }

  const projects = [];
  let minDate = null;
  let maxDate = null;

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const projectPath = path.join(PROJECTS_DIR, e.name);
    const files = listSessionFiles(projectPath);
    if (files.length === 0) continue;

    const grand = {};
    let cwd = null;
    let sessions = 0;
    let prompts = 0;
    let lastActive = null;

    for (const f of files) {
      const s = parseSession(f);
      if (!s) continue;
      if (s.cwd && !cwd) cwd = s.cwd;
      if (s.start) {
        const d = s.start.slice(0, 10);
        if (!minDate || d < minDate) minDate = d;
      }
      if (s.end) {
        const d = s.end.slice(0, 10);
        if (!maxDate || d > maxDate) maxDate = d;
        if (!lastActive || s.end > lastActive) lastActive = s.end;
      }
      const agg = aggregateSession(s, from, to);
      if (!agg.has) continue;
      sessions += 1;
      prompts += agg.userPrompts;
      for (const [fam, b] of Object.entries(agg.byFamily)) {
        if (!grand[fam]) grand[fam] = emptyBundle();
        addBundle(grand[fam], b);
      }
    }

    const priced = priceBundles(grand);
    projects.push({
      id: e.name,
      name: projectName(e.name, cwd),
      cwd: cwd || projectName(e.name, null),
      sessions,
      userPrompts: prompts,
      cost: priced.cost,
      cacheSavings: priced.cacheSavings,
      tokens: priced.tokens,
      lastActive,
    });
  }

  projects.sort((a, b) => b.cost - a.cost || (b.lastActive || '').localeCompare(a.lastActive || ''));
  return { projects, bounds: { min: minDate, max: maxDate } };
}

// --- Single-session drill-down ---------------------------------------------
function sessionDetail(folder, sessionId) {
  const dir = resolveProjectDir(folder);
  if (!dir) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  const file = path.join(dir, sessionId + '.jsonl');
  const rel = path.relative(dir, file);
  if (rel.includes(path.sep) || rel.startsWith('..')) return null;
  if (!fs.existsSync(file)) return null;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const out = {
    id: sessionId,
    title: null,
    firstPrompt: null,
    cwd: null,
    gitBranch: null,
    start: null,
    end: null,
    prompts: [],
    tools: {},
    timeline: [],
  };
  const grand = {};
  let cumCost = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.cwd && !out.cwd) out.cwd = o.cwd;
    if (o.gitBranch && !out.gitBranch) out.gitBranch = o.gitBranch;
    if (o.timestamp) {
      if (!out.start || o.timestamp < out.start) out.start = o.timestamp;
      if (!out.end || o.timestamp > out.end) out.end = o.timestamp;
    }
    if (o.type === 'ai-title' && o.aiTitle) out.title = o.aiTitle;

    if (o.type === 'user') {
      const content = o.message && o.message.content;
      if (typeof content === 'string' && content.trim()) {
        if (!out.firstPrompt) out.firstPrompt = content;
        out.prompts.push({ ts: o.timestamp || null, text: content.slice(0, 4000) });
      }
    }

    if (o.type === 'assistant' && o.message) {
      const msg = o.message;
      const family = modelFamily(msg.model);
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b && b.type === 'tool_use') {
            const name = b.name || 'unknown';
            out.tools[name] = (out.tools[name] || 0) + 1;
          }
        }
      }
      const u = msg.usage;
      if (u) {
        const fb = usageToBundle(u);
        const msgCost = priceBundles({ [family]: fb }).cost;
        cumCost += msgCost;
        out.timeline.push({ ts: o.timestamp || null, cost: msgCost, cumCost });
        if (!grand[family]) grand[family] = emptyBundle();
        addBundle(grand[family], fb);
      }
    }
  }

  const priced = priceBundles(grand);
  return {
    id: out.id,
    projectId: folder,
    title: out.title || (out.firstPrompt ? out.firstPrompt.slice(0, 80) : '(untitled)'),
    firstPrompt: out.firstPrompt,
    cwd: out.cwd || projectName(folder, null),
    gitBranch: out.gitBranch,
    start: out.start,
    end: out.end,
    totals: {
      cost: priced.cost,
      costByFamily: priced.costByFamily,
      tokens: priced.tokens,
      models: priced.models,
      userPrompts: out.prompts.length,
      toolUses: Object.values(out.tools).reduce((a, b) => a + b, 0),
    },
    cacheSavings: priced.cacheSavings,
    prompts: out.prompts,
    topTools: Object.entries(out.tools)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    timeline: out.timeline,
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
      ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.png' ? 'image/png'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  const from = url.searchParams.get('from') || null;
  const to = url.searchParams.get('to') || null;

  try {
    if (pathname === '/api/projects') {
      const { projects, bounds } = listProjects(from, to);
      return sendJSON(res, 200, {
        projectsDir: PROJECTS_DIR,
        pricing: getPricing(),
        pricingFromFile: pricingIsFromFile(),
        bounds,
        projects,
      });
    }
    if (pathname === '/api/overview') {
      const ov = overview(from, to);
      if (!ov) return sendJSON(res, 404, { error: 'no projects' });
      return sendJSON(res, 200, ov);
    }
    if (pathname.startsWith('/api/session/')) {
      const rest = pathname.slice('/api/session/'.length);
      const slash = rest.indexOf('/');
      if (slash < 0) return sendJSON(res, 400, { error: 'bad session path' });
      const projectId = rest.slice(0, slash);
      const sessionId = rest.slice(slash + 1);
      const detail = sessionDetail(projectId, sessionId);
      if (!detail) return sendJSON(res, 404, { error: 'session not found' });
      return sendJSON(res, 200, detail);
    }
    if (pathname.startsWith('/api/project/')) {
      const id = pathname.slice('/api/project/'.length);
      const detail = projectDetail(id, from, to);
      if (!detail) return sendJSON(res, 404, { error: 'project not found' });
      return sendJSON(res, 200, detail);
    }
    if (pathname === '/' || pathname === '/index.html') {
      return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
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

// Pure helpers are exported for the test suite (see test/). Requiring this file
// does not start the server — that only happens when run as the main module.
module.exports = {
  DEFAULT_PRICING,
  getPricing,
  validatePricing,
  pricingIsFromFile,
  getMonthlyBudget,
  currentMonthInfo,
  shiftDay,
  previousPeriod,
  makeDelta,
  modelFamily,
  emptyBundle,
  addBundle,
  usageToBundle,
  nestFam,
  mergeByName,
  priceBundles,
  priceByName,
  efficiencyStats,
  inRange,
  aggregateSession,
};

if (require.main !== module) return;

// Localhost by default on shared hosts; auto-pick a free port when PORT unset.
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
    console.log(`Claude Ledger → http://${shown}:${port}`);
    console.log(`Reading projects from: ${PROJECTS_DIR}`);
    if (HOST === '127.0.0.1') {
      console.log(
        `Localhost-only. From your laptop:  ssh -L ${port}:localhost:${port} <you>@<this-host>  then open http://localhost:${port}`
      );
    }
  });
}
listen(Number(PORT) || 4317, 50);
