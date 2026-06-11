#!/usr/bin/env node
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
// Sidecar sources outside projects/: the prompt/command history log and the
// plan-mode markdown dir. Default to siblings of projects/ (the ~/.claude root);
// each is overridable and treated as optional (missing → empty analytics).
const CLAUDE_DIR = process.env.CLAUDE_DIR || path.dirname(PROJECTS_DIR);
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(CLAUDE_DIR, 'history.jsonl');
const PLANS_DIR = process.env.PLANS_DIR || path.join(CLAUDE_DIR, 'plans');
const FILE_HISTORY_DIR = process.env.FILE_HISTORY_DIR || path.join(CLAUDE_DIR, 'file-history');
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(CLAUDE_DIR, 'sessions');
const TASKS_DIR = process.env.TASKS_DIR || path.join(CLAUDE_DIR, 'tasks');
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
  // Server-side tools, billed per request (not per token). Anthropic web search
  // is ~$10 / 1,000 requests; web fetch carries no separate per-request fee by
  // default (its tokens are already in usage). Override in pricing.json.
  webSearchPer1k: 10,
  webFetchPer1k: 0,
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
  for (const k of ['cacheReadMultiplier', 'cacheWrite5mMultiplier', 'cacheWrite1hMultiplier', 'webSearchPer1k', 'webFetchPer1k']) {
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

// Flat monthly plan fee (USD): PLAN_MONTHLY_FEE env wins, else config.json's
// planMonthlyFee. null = no plan set (the plan-value panel stays hidden). For
// Max/Pro users the priced cost is API-equivalent usage, not a bill; this anchors it.
function getPlanFee() {
  const env = process.env.PLAN_MONTHLY_FEE;
  if (env != null && env !== '') {
    const n = Number(env);
    return isFinite(n) && n >= 0 ? n : null;
  }
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (c.planMonthlyFee == null) return null;
    const n = Number(c.planMonthlyFee);
    return isFinite(n) && n >= 0 ? n : null;
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

// Day-of-week for a YYYY-MM-DD key: 0=Sun … 6=Sat (UTC, to match the day-keys).
function weekdayOf(dayStr) {
  const wd = new Date(dayStr + 'T00:00:00Z').getUTCDay();
  return Number.isInteger(wd) ? wd : 0;
}

// Hour-of-day (0–23) sliced straight from an ISO-Z timestamp's "HH" field. UTC,
// to stay aligned with dayOf's day-keys (the whole app buckets in UTC on purpose).
function hourOf(ts) {
  if (typeof ts === 'string' && ts.length >= 13 && ts[10] === 'T') {
    const h = Number(ts.slice(11, 13));
    if (Number.isInteger(h) && h >= 0 && h < 24) return h;
  }
  return 0;
}

// Validate a YYYY-MM-DD date param: well-formed AND a real calendar day, so
// 2026-13-40 and 2026-02-30 are rejected rather than silently rolled over by
// Date. An invalid value would otherwise slip into inRange's string compare and
// quietly empty or skew every result, so the HTTP layer rejects it with a 400.
function isValidDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
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

// True when the model id maps to a known pricing family. Unknown ids are still
// priced (as Opus — the safe over-estimate), but flagged so the UI can say so
// rather than silently inflating cost when a new model id appears.
function modelFamilyKnown(model) {
  const m = (model || '').toLowerCase();
  return m.includes('opus') || m.includes('sonnet') || m.includes('haiku');
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

// Get-or-create the bundle for one model family inside a { family: bundle } map.
function famBundleIn(map, fam) {
  if (!map[fam]) map[fam] = emptyBundle();
  return map[fam];
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

// Like priceByName, but for exact model ids: flags any id that fell back to Opus
// pricing because it matched no known family, so an unknown/new model is visible
// in the UI instead of silently priced as the most expensive family.
function pricedModels(map) {
  return priceByName(map).map((m) => ({ ...m, unknown: !modelFamilyKnown(m.name) }));
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

// Tool reliability + recovery spend. `tools` is { name: callCount } (every
// tool_use), `toolErrors` is { name: failedResultCount }, and `errorFollowup` is
// a { family: bundle } map of the turns that ran right after a failed result.
function reliabilityStats(tools, toolErrors, errorFollowup) {
  let totalCalls = 0;
  let totalErrors = 0;
  const byTool = Object.entries(tools || {}).map(([name, calls]) => {
    const errors = (toolErrors && toolErrors[name]) || 0;
    totalCalls += calls;
    totalErrors += errors;
    return { name, calls, errors, rate: calls > 0 ? errors / calls : 0 };
  });
  // Errors for a tool that was never seen as a tool_use (e.g. id unmatched) still count.
  for (const [name, errors] of Object.entries(toolErrors || {})) {
    if (tools && tools[name] != null) continue;
    totalErrors += errors;
    byTool.push({ name, calls: 0, errors, rate: 0 });
  }
  byTool.sort((a, b) => b.errors - a.errors || b.calls - a.calls);
  return {
    totalCalls,
    totalErrors,
    errorRate: totalCalls > 0 ? totalErrors / totalCalls : 0,
    wastedCost: priceBundles(errorFollowup || {}).cost,
    byTool: byTool.filter((t) => t.errors > 0),
  };
}

// Turn-latency / time-cost summary from a flat list of turn durations (ms).
// avg is skewed by the long tail, so we also report median + p90, plus $/hour
// and a duration histogram showing where the waiting goes.
const DURATION_BUCKETS = [
  [0, 10000, '<10s'],
  [10000, 30000, '10–30s'],
  [30000, 60000, '30–60s'],
  [60000, 180000, '1–3m'],
  [180000, 600000, '3–10m'],
  [600000, Infinity, '>10m'],
];
function timeStats(durations, userPrompts, cost) {
  const arr = (durations || []).slice().sort((a, b) => a - b);
  const turns = arr.length;
  const totalMs = arr.reduce((s, x) => s + x, 0);
  const quantile = (p) => (turns ? arr[Math.min(turns - 1, Math.floor(p * turns))] : 0);
  const hours = totalMs / 3600000;
  const hist = DURATION_BUCKETS.map(([lo, hi, label]) => ({
    label,
    count: arr.reduce((n, x) => n + (x >= lo && x < hi ? 1 : 0), 0),
  }));
  return {
    turns,
    totalMs,
    avgMs: turns ? totalMs / turns : 0,
    medianMs: quantile(0.5),
    p90Ms: quantile(0.9),
    perPromptMs: userPrompts > 0 ? totalMs / userPrompts : 0,
    costPerHour: hours > 0 ? cost / hours : 0,
    hist,
  };
}

// --- Per-turn signals -------------------------------------------------------
// Lighter-weight tallies that ride alongside the token bundles: how turns ended,
// context compactions, extended-thinking usage, pasted images, and server-side
// web tools. `s` holds the accumulated raw counts; assistantMessages is the
// denominator for the thinking share. Honest framing matters here:
//  - thinkingShare is the FRACTION OF TURNS that used extended thinking, not a
//    token/cost share — the thinking text is stripped from transcripts, so its
//    token cost can't be isolated (it's already inside output_tokens).
//  - webCost is an ESTIMATE priced from pricing.json's per-request rates and is
//    reported separately because server-tool requests aren't part of usage.
function turnSignals(s, assistantMessages) {
  const P = getPricing();
  const stopReasons = Object.entries(s.stopReasons || {})
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
  const totalStops = stopReasons.reduce((n, x) => n + x.count, 0);
  const truncated = (s.stopReasons && s.stopReasons.max_tokens) || 0;
  const refused = (s.stopReasons && s.stopReasons.refusal) || 0;
  const compactions = s.compactions || 0;
  const webSearch = s.webSearch || 0;
  const webFetch = s.webFetch || 0;
  const webCost = (webSearch / 1000) * (P.webSearchPer1k || 0) + (webFetch / 1000) * (P.webFetchPer1k || 0);
  return {
    stopReasons, totalStops, truncated, refused,
    truncationRate: totalStops > 0 ? truncated / totalStops : 0,
    compactions,
    compactTrigger: s.compactTrigger || {},
    compactAvgPreTokens: compactions > 0 ? Math.round((s.compactPreTokens || 0) / compactions) : 0,
    compactMs: s.compactMs || 0,
    thinkingTurns: s.thinkingTurns || 0,
    thinkingBlocks: s.thinkingBlocks || 0,
    thinkingShare: assistantMessages > 0 ? (s.thinkingTurns || 0) / assistantMessages : 0,
    imageTurns: s.imageTurns || 0,
    images: s.images || 0,
    webSearch, webFetch, webCost,
  };
}

// --- Output metrics (the "R" in ROI) ----------------------------------------
// What the spend produced, tallied from tool_use blocks: files touched by an
// editing tool, git commits, and PRs opened. A rough activity proxy — not a
// measure of value or quality — so cost can be expressed per unit of work.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
function isCommitCommand(cmd) { return typeof cmd === 'string' && /\bgit\s+commit\b/.test(cmd); }
function isPrCommand(cmd) { return typeof cmd === 'string' && /\bgh\s+pr\s+create\b/.test(cmd); }
function recordOutput(day, name, input) {
  const inp = input || {};
  if (EDIT_TOOLS.has(name)) {
    day.edits += 1;
    const fp = inp.file_path || inp.notebook_path;
    if (fp) day.editsByFile[fp] = (day.editsByFile[fp] || 0) + 1;
  } else if (name === 'Bash') {
    if (isCommitCommand(inp.command)) day.commits += 1;
    if (isPrCommand(inp.command)) day.prs += 1;
  }
}
// Summarize accumulated output counts + the distinct-file map into per-cost ratios.
function outputStats(o, cost) {
  const filesEdited = Object.keys((o && o.editsByFile) || {}).length;
  const commits = (o && o.commits) || 0;
  return {
    commits,
    prs: (o && o.prs) || 0,
    edits: (o && o.edits) || 0,
    filesEdited,
    costPerCommit: commits > 0 ? cost / commits : 0,
    costPerFile: filesEdited > 0 ? cost / filesEdited : 0,
  };
}

// --- ROI verdict ("is the AI paying off?") ----------------------------------
// A glanceable good/ok/warn grade synthesized from metrics already computed. The
// honest stance: grade only what's observable — value-for-money (usage vs the
// plan fee), and spend efficiency (cache reuse + retry/friction). OUTPUT volume
// is shown but NOT graded (there's no honest baseline for "is N commits good",
// and quality is unobservable — that's the user's call). Thresholds live here so
// they're easy to find and tune.
const VERDICT = {
  leverageStrong: 3,    // range usage >= 3x the prorated plan fee → strong
  leverageOk: 1,        // >= 1x → you got more than you paid for; < 1x → underwater
  cacheGood: 0.70,      // cache hit rate at/above this is "lean"
  cacheWeak: 0.40,      // below this is "leaky"
  frictionLean: 0.10,   // recovery/retry spend / total cost at/below this is "lean"
  frictionLeaky: 0.25,  // at/above this is "leaky"
  avgMonthDays: 30.44,  // to prorate a monthly fee across an arbitrary range
  trendMargin: 0.05,    // min change in (cacheHit − friction) to call a direction
};

// rangeDays: the inclusive day-span the verdict covers (selected range, or the
// data span when the range is unbounded). planFee is the monthly subscription
// fee or null. Returns null when there's nothing to grade.
function computeVerdict(m) {
  const cost = m.cost || 0;
  if (cost <= 0) return null;

  // Value for money — only honestly gradeable against a flat fee. Prorate the
  // monthly fee across the range so it lines up with the range's API-equiv spend.
  let value = null;
  if (m.planFee != null && m.planFee > 0 && m.rangeDays > 0) {
    const proratedFee = m.planFee * (m.rangeDays / VERDICT.avgMonthDays);
    const leverage = proratedFee > 0 ? cost / proratedFee : null;
    let tone = 'ok';
    if (leverage >= VERDICT.leverageStrong) tone = 'good';
    else if (leverage < VERDICT.leverageOk) tone = 'warn';
    value = { tone, leverage, proratedFee, monthlyFee: m.planFee };
  }

  // Efficiency — lean vs leaky spend (high cache reuse + low retry friction).
  const friction = cost > 0 ? (m.wastedCost || 0) / cost : 0;
  const hit = m.cacheHitRate || 0;
  let effTone = 'ok';
  if (friction >= VERDICT.frictionLeaky || hit < VERDICT.cacheWeak) effTone = 'warn';
  else if (friction <= VERDICT.frictionLean && hit >= VERDICT.cacheGood) effTone = 'good';
  const efficiency = { tone: effTone, cacheHitRate: hit, friction };

  // Output — counted, deliberately not graded.
  const output = {
    tone: 'info',
    commits: m.output.commits,
    prs: m.output.prs,
    filesEdited: m.output.filesEdited,
    costPerCommit: m.output.costPerCommit,
    costPerFile: m.output.costPerFile,
  };

  // Savings — concrete dollar value the tooling delivered, fee or no fee: cache
  // reuse (vs paying list input price for every cached read) and the model-routing
  // headroom (same tokens priced entirely on Sonnet). Surfaced so the headline
  // still says something useful when no plan fee is set to grade value against.
  const sonnetIf = m.whatIf && m.whatIf.sonnet != null ? m.whatIf.sonnet : null;
  const savings = {
    cache: m.cacheSavings || 0,
    modelHeadroom: sonnetIf != null ? Math.max(0, cost - sonnetIf) : 0,
  };

  // Headline: synthesize one glanceable status + tone from the graded signals.
  // value:warn (underwater) is the strongest negative; then efficiency:warn.
  let status, tone;
  if (value && value.tone === 'warn') { status = 'below_fee'; tone = 'warn'; }
  else if (efficiency.tone === 'warn') { status = 'worth_a_look'; tone = 'warn'; }
  else if (value && value.tone === 'good') { status = 'paying_off'; tone = 'good'; }
  else if (!value) { status = efficiency.tone === 'good' ? 'lean_no_fee' : 'set_fee'; tone = efficiency.tone === 'good' ? 'good' : 'ok'; }
  else { status = 'paying_off'; tone = 'ok'; } // value ok, efficiency ok/good

  // Direction — is spend efficiency improving vs the prior equal-length period?
  // Graded on the same lean-spend score the Efficiency row uses (cache reuse
  // minus retry friction), so "improving" means unambiguously leaner spend, not
  // a quality claim. Null when there's no prior period with data to compare.
  let direction = null;
  if (m.prev) {
    const cur = efficiency.cacheHitRate - efficiency.friction;
    const prv = (m.prev.cacheHitRate || 0) - (m.prev.friction || 0);
    const delta = cur - prv;
    let dTone = 'ok', trend = 'steady';
    if (delta >= VERDICT.trendMargin) { dTone = 'good'; trend = 'improving'; }
    else if (delta <= -VERDICT.trendMargin) { dTone = 'warn'; trend = 'worsening'; }
    direction = { tone: dTone, trend, delta, prevCacheHitRate: m.prev.cacheHitRate, prevFriction: m.prev.friction };
  }

  return { tone, status, value, efficiency, output, savings, direction, rangeDays: m.rangeDays };
}

// --- Insights ("worth a look") ----------------------------------------------
// Surface what stands out in the current range so the dashboard points you at it
// instead of presenting every panel with equal weight. Derived from the same
// aggregates shown elsewhere and ranked by dollar impact so the top of the list
// is the most worth noticing. Each signal observes; where there's a clear, honest
// next step it also carries an `action` — a drill-down within the dashboard, a
// `pricing.json` fix, or a well-worn usage practice — never a quality judgment
// and never anything the read-only app does on your behalf. Informational signals
// (no obvious move) carry no action and the UI just omits the line.
function median(nums) {
  if (!nums.length) return 0;
  const a = nums.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function fmtMsShort(ms) {
  if (ms >= 3600000) return `${(ms / 3600000).toFixed(1)}h`;
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
function computeInsights(v) {
  const out = [];
  const cost = (v.totals && v.totals.cost) || 0;
  const usd = (x) => `$${(x || 0).toFixed(2)}`;
  const pct = (x) => `${Math.round(x * 100)}%`;

  // A single day's spend dwarfs the rest of the range.
  if (Array.isArray(v.daily)) {
    const active = v.daily.filter((d) => d.cost > 0);
    if (active.length >= 4) {
      const med = median(active.map((d) => d.cost));
      const top = active.reduce((a, b) => (b.cost > a.cost ? b : a));
      if (med > 0 && top.cost >= 2.5 * med) {
        out.push({ kind: 'spike', sev: top.cost, tone: 'warn', title: 'Spend spike',
          detail: `${top.date} cost ${usd(top.cost)} — ${(top.cost / med).toFixed(1)}× your median active day (${usd(med)}).`,
          action: `Open ${top.date} in Activity to see its hour-by-hour breakdown and what ran that day.` });
      }
    }
  }
  // One session dominates (per-project view).
  if (Array.isArray(v.sessions) && v.sessions.length >= 4) {
    const med = median(v.sessions.map((s) => s.cost));
    const top = v.sessions.reduce((a, b) => (b.cost > a.cost ? b : a));
    if (med > 0 && top.cost >= 3 * med) {
      out.push({ kind: 'session', sev: top.cost, tone: 'info', title: 'Pricey session',
        detail: `"${(top.title || 'untitled').slice(0, 60)}" cost ${usd(top.cost)} — ${(top.cost / med).toFixed(1)}× your median session.`,
        action: 'Open it from the Sessions table to see where the turns and tokens went.' });
    }
  }
  // Spend concentrated in one project (all-projects view).
  if (Array.isArray(v.projects) && v.projects.length >= 2 && cost > 0) {
    const top = v.projects.reduce((a, b) => (b.cost > a.cost ? b : a));
    if (top.cost / cost >= 0.6) {
      out.push({ kind: 'concentration', sev: top.cost, tone: 'info', title: 'Concentrated spend',
        detail: `${top.name} is ${pct(top.cost / cost)} of all spend (${usd(top.cost)}).`,
        action: `Open ${top.name} to break its spend down by session and model.` });
    }
  }
  // Recovery spend after failed tool calls (friction).
  if (v.reliability && v.reliability.wastedCost > 0 && v.reliability.totalErrors >= 3) {
    const w = v.reliability.wastedCost;
    if (w >= Math.max(0.5, 0.03 * cost)) {
      out.push({ kind: 'recovery', sev: w, tone: 'warn', title: 'Recovery spend',
        detail: `${usd(w)}${cost > 0 ? ` (${pct(w / cost)})` : ''} spent recovering from ${v.reliability.totalErrors} failed tool calls.`,
        action: 'Check Tool reliability below — the top failing tool is where the retry cost concentrates.' });
    }
  }
  // Big move vs the prior equal-length period. When prompt counts are available,
  // separate "more usage" (cost tracks prompt growth) from "pricier turns" (cost
  // outran prompts) — the same dollar move means different things and is the most
  // useful thing to know about a spike.
  if (v.delta && v.delta.costPct != null && Math.abs(v.delta.costPct) >= 0.4 && Math.abs(v.delta.costChange) > 0) {
    const up = v.delta.costChange > 0;
    let detail = `Spend ${up ? 'up' : 'down'} ${pct(Math.abs(v.delta.costPct))} vs the prior ${v.delta.days}d (${usd(Math.abs(v.delta.costChange))}).`;
    if (up && v.delta.promptsPct != null) {
      detail += v.delta.promptsPct >= v.delta.costPct - 0.1
        ? ` Prompts rose ${pct(v.delta.promptsPct)} too — mostly more work, not pricier turns.`
        : ` Prompts changed only ${pct(v.delta.promptsPct)}, so each turn cost more.`;
    }
    out.push({ kind: 'trend', sev: Math.abs(v.delta.costChange), tone: up ? 'warn' : 'good',
      title: up ? 'Trending up' : 'Trending down', detail,
      // Only the upward move warrants a "look into it"; trending down is just good news.
      action: up ? 'Compare the model split and top sessions against the prior period to see what grew.' : undefined });
  }
  // Automation dominates spend.
  if (Array.isArray(v.topEntrypoints) && v.topEntrypoints.length > 1 && cost > 0) {
    const auto = v.topEntrypoints.find((e) => e.name === 'sdk-cli');
    if (auto && auto.cost / cost >= 0.45) {
      out.push({ kind: 'automation', sev: auto.cost, tone: 'info', title: 'Heavy automation',
        detail: `Automated (sdk-cli) runs drove ${pct(auto.cost / cost)} of spend (${usd(auto.cost)}).` });
    }
  }
  // Spend on an unrecognized model id (the estimate may be off).
  if (Array.isArray(v.topModels) && cost > 0) {
    const unknown = v.topModels.filter((m) => m.unknown).reduce((s, m) => s + m.cost, 0);
    if (unknown / cost >= 0.05) {
      out.push({ kind: 'unknown-model', sev: unknown, tone: 'warn', title: 'Unrecognized model',
        detail: `${pct(unknown / cost)} of spend is on a model id priced as Opus by fallback — the estimate may be off.`,
        action: "Add this model's real rates to pricing.json so the estimate stops falling back to Opus." });
    }
  }
  // A few slow turns dominate the wait (latency tail, not cost).
  if (v.time && v.time.turns >= 10 && v.time.medianMs > 0 && v.time.p90Ms >= 180000 && v.time.p90Ms >= 5 * v.time.medianMs) {
    out.push({ kind: 'latency', sev: 0, tone: 'info', title: 'Slow-turn tail',
      detail: `p90 turn is ${fmtMsShort(v.time.p90Ms)} vs a ${fmtMsShort(v.time.medianMs)} median — a few long turns dominate the wait.` });
  }
  // Subagent-heavy spend (the Task-agent analogue of the automation insight).
  // Dollar-valued, so it ranks among the cost insights.
  if (Array.isArray(v.topAgentKinds) && cost > 0) {
    const sub = v.topAgentKinds.find((a) => a.name === 'subagent');
    if (sub && sub.cost / cost >= 0.45) {
      out.push({ kind: 'subagent', sev: sub.cost, tone: 'info', title: 'Subagent-heavy',
        detail: `Task subagents drove ${pct(sub.cost / cost)} of spend (${usd(sub.cost)}).` });
    }
  }
  // Server-side web tools — billed per request, separate from token cost. The
  // estimated dollar figure is its severity.
  if (v.signals && (v.signals.webSearch + v.signals.webFetch) > 0 && v.signals.webCost >= Math.max(0.5, 0.02 * cost)) {
    const reqs = v.signals.webSearch + v.signals.webFetch;
    out.push({ kind: 'web', sev: v.signals.webCost, tone: 'info', title: 'Web-tool spend',
      detail: `${reqs} web search/fetch request${reqs === 1 ? '' : 's'} (~${usd(v.signals.webCost)}, estimated, billed separately from tokens).` });
  }
  // Truncated turns: answers cut off at the token limit — work may be incomplete.
  // No clean dollar value, so it ranks below the cost insights (sev 0), like latency.
  if (v.signals && v.signals.truncated >= 3 && v.signals.truncationRate >= 0.02) {
    out.push({ kind: 'truncation', sev: 0, tone: 'warn', title: 'Truncated turns',
      detail: `${v.signals.truncated} turn${v.signals.truncated === 1 ? '' : 's'} (${pct(v.signals.truncationRate)}) hit the token limit and were cut off — those answers may be incomplete.`,
      action: 'Break very large turns into smaller asks, or compact sooner, so answers are not cut off.' });
  }
  // Frequent context compaction: long sessions repeatedly summarizing context.
  if (v.signals && v.signals.compactions >= 3) {
    const ctx = v.signals.compactAvgPreTokens > 0 ? ` (avg ~${Math.round(v.signals.compactAvgPreTokens / 1000)}K tokens before each)` : '';
    out.push({ kind: 'compaction', sev: 0, tone: 'info', title: 'Frequent compaction',
      detail: `${v.signals.compactions} context compactions${ctx} — long sessions are repeatedly hitting the context limit.`,
      action: 'Start a fresh session per task — long-running sessions repeatedly hit the context limit.' });
  }
  // High session concurrency: parallel work burns spend faster (all-projects view).
  if (v.concurrency && v.concurrency.maxConcurrent >= 4) {
    out.push({ kind: 'concurrency', sev: 0, tone: 'info', title: 'Parallel sessions',
      detail: `Up to ${v.concurrency.maxConcurrent} sessions ran at once (${v.concurrency.parallelSessions} of ${v.concurrency.totalSessions} overlapped another).` });
  }
  // Model-routing headroom: an Opus-dominated bill where the same tokens priced
  // entirely on Sonnet would cost materially less. The biggest honest cost lever
  // — surfaced as where the headroom is, not a quality verdict (that's yours).
  if (v.efficiency && v.efficiency.whatIf && v.costByFamily && cost > 0) {
    const opusCost = v.costByFamily.opus || 0;
    const sonnet = v.efficiency.whatIf.sonnet;
    const savings = sonnet != null ? cost - sonnet : 0;
    if (opusCost / cost >= 0.6 && savings >= Math.max(2, 0.20 * cost)) {
      out.push({ kind: 'model-mix', sev: savings, tone: 'info', title: 'Opus-heavy spend',
        detail: `Opus drove ${pct(opusCost / cost)} of spend (${usd(opusCost)}). The same tokens priced entirely on Sonnet ≈ ${usd(sonnet)} — about ${usd(savings)} less.`,
        action: 'Route routine work (edits, boilerplate, simple Q&A) to Sonnet and keep Opus for the hard problems — that is where the headroom is, not a quality call.' });
    }
  }
  // Leaky cache: paying the cache-write premium (writes cost more than fresh
  // input) without reading it back. A high write share + low hit rate means
  // caches expire before reuse — long idle gaps, frequent restarts, one-shot runs.
  if (v.efficiency && v.efficiency.composition && cost > 0) {
    const cw = v.efficiency.composition.cacheWrite || 0;
    const hit = v.efficiency.cacheHitRate || 0;
    if (cw / cost >= 0.25 && hit < 0.40 && cw >= 2) {
      out.push({ kind: 'cache-write', sev: cw, tone: 'warn', title: 'Leaky cache',
        detail: `Cache writes were ${usd(cw)} (${pct(cw / cost)} of spend) but only ${pct(hit)} of input was served from cache — you're paying the write premium without reading it back.`,
        action: 'Cached context only pays off when re-read within its 5m/1h window — keep a task in one active session rather than long idle gaps or frequent restarts.' });
    }
  }
  // Spend with no code trace: money that produced no commits or file edits in
  // range — research, planning, Q&A, or work that landed outside git. Neutral by
  // design (Ledger counts artifacts, it doesn't judge). The all-projects view
  // sums the zero-output projects; the per-project view flags itself.
  if (Array.isArray(v.projects) && v.projects.length && cost > 0) {
    const zero = v.projects.filter((p) => !(p.commits || 0) && !(p.filesEdited || 0) && (p.cost || 0) > 0);
    const zeroCost = zero.reduce((s, p) => s + p.cost, 0);
    if (zeroCost >= 5 && zeroCost / cost >= 0.25) {
      out.push({ kind: 'no-output', sev: zeroCost, tone: 'info', title: 'Spend without a code trace',
        detail: `${usd(zeroCost)} across ${zero.length} project${zero.length === 1 ? '' : 's'} produced no commits or file edits in range — research, planning, or Q&A as far as git/file activity shows.`,
        action: 'Open those projects to confirm the work landed elsewhere (a plan, a discussion) rather than stalling.' });
    }
  } else if (v.output && cost >= 5 && !(v.output.commits || 0) && !(v.output.filesEdited || 0)) {
    out.push({ kind: 'no-output', sev: cost, tone: 'info', title: 'Spend without a code trace',
      detail: `${usd(cost)} in range produced no commits or file edits — research, planning, or Q&A as far as git/file activity shows.`,
      action: 'Check whether the work landed elsewhere (a plan, a discussion) rather than stalling.' });
  }

  return out.sort((a, b) => b.sev - a.sev).slice(0, 5);
}

// --- Work log ("what I built") ----------------------------------------------
// The accomplishment side of ROI: a shareable summary of what the spend produced
// — commits, PRs, files, the sessions worked on, and recurring title words — for
// the selected range. Derived from existing aggregates; exported as Markdown.
const TITLE_STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'are', 'from', 'into', 'your', 'our',
  'out', 'off', 'via', 'add', 'use', 'get', 'set', 'new', 'can', 'but', 'not', 'you', 'was', 'were', 'has',
  'have', 'had', 'will', 'should', 'what', 'when', 'why', 'how', 'its', 'all', 'any', 'per', 'now', 'one']);
function titleWords(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !TITLE_STOP.has(w));
}
// Pick a human title for a session: the AI title if present, else the first
// prompt — but skip local-command wrappers / system blocks (e.g. "<command-name>",
// "<local-command-caveat>"), which aren't meaningful work descriptions.
function sessionTitle(s) {
  if (s.title) return s.title;
  const fp = String(s.firstPrompt || '').trim();
  if (!fp || fp[0] === '<' || /<\/?(command-|local-command|system-reminder)/.test(fp)) return '(untitled)';
  return fp.slice(0, 80);
}
function topThemes(counts, n) {
  return Object.entries(counts || {})
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n || 6)
    .map(([term, count]) => ({ term, count }));
}
function buildWorkLog(v) {
  const all = (v.projects || []).filter((p) => (p.cost || 0) > 0 || p.commits || p.filesEdited);
  return {
    from: v.from || null,
    to: v.to || null,
    cost: v.cost || 0,
    activeMs: v.time ? v.time.totalMs : 0,
    sessions: v.sessions || 0,
    projectCount: all.length,
    commits: (v.output && v.output.commits) || 0,
    prs: (v.output && v.output.prs) || 0,
    filesEdited: (v.output && v.output.filesEdited) || 0,
    themes: v.themes || [],
    projects: all.slice()
      .sort((a, b) => (b.commits || 0) - (a.commits || 0) || b.cost - a.cost)
      .slice(0, 12)
      .map((p) => ({ name: p.name, commits: p.commits || 0, prs: p.prs || 0, filesEdited: p.filesEdited || 0, sessions: p.sessions, cost: p.cost, titles: (p.topTitles || []).slice(0, 3) })),
  };
}
function worklogMarkdown(wl) {
  if (!wl) return '';
  const usd = (x) => `$${(x || 0).toFixed(2)}`;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const range = wl.from || wl.to ? `${wl.from || '…'} → ${wl.to || '…'}` : 'all time';
  const head = [plural(wl.commits, 'commit'), wl.prs ? plural(wl.prs, 'PR') : null, plural(wl.filesEdited, 'file'),
    plural(wl.sessions, 'session'), usd(wl.cost), wl.activeMs > 0 ? `${(wl.activeMs / 3600000).toFixed(1)}h active` : null].filter(Boolean).join(' · ');
  const lines = [`# Work log — ${range}`, '', `**${head}** across ${plural(wl.projectCount, 'project')}.`];
  if (wl.themes.length) lines.push('', `Recurring themes: ${wl.themes.map((t) => `${t.term} ×${t.count}`).join(', ')}.`);
  if (wl.projects.length) {
    lines.push('', '## By project', '');
    for (const p of wl.projects) {
      const bits = [plural(p.commits, 'commit'), p.prs ? plural(p.prs, 'PR') : null, plural(p.filesEdited, 'file'),
        plural(p.sessions, 'session'), usd(p.cost)].filter(Boolean).join(', ');
      lines.push(`- **${clean(p.name)}** — ${bits}`);
      for (const t of p.titles) lines.push(`  - ${clean(t)}`);
    }
  }
  return lines.join('\n') + '\n';
}

// --- Activity by day × hour -------------------------------------------------
// Per-day, per-hour { byFamily token-bundle, messages }, keyed by the actual
// date (not weekday). Priced at query time like everything else. The client
// renders it adaptively from the date span: a 24-hour view for a single day, a
// date × hour heatmap for a short range, or a clickable day list (drilling into
// one day's hours) for longer ranges.
function emptyHourRow() {
  return Array.from({ length: 24 }, () => ({ byFamily: {}, messages: 0 }));
}
// Fold one parsed day's per-hour buckets into that date's 24-hour row.
function accumulateDayHours(dayHours, day, dayData) {
  const row = dayHours[day] || (dayHours[day] = emptyHourRow());
  for (const [h, hb] of Object.entries(dayData.hours || {})) {
    const cell = row[h];
    if (!cell) continue; // ignore an out-of-range hour key, just in case
    cell.messages += hb.messages || 0;
    for (const [fam, b] of Object.entries(hb.byFamily || {})) addBundle(famBundleIn(cell.byFamily, fam), b);
  }
}
// Price into { 'YYYY-MM-DD': { cost: number[24], messages: number[24] } }.
function priceHourly(dayHours) {
  const out = {};
  for (const [day, row] of Object.entries(dayHours)) {
    out[day] = {
      cost: row.map((cell) => priceBundles(cell.byFamily).cost),
      messages: row.map((cell) => cell.messages),
    };
  }
  return out;
}

// --- Transcript parsing (cached by file mtime + size) -----------------------
// Stores raw token counts per day per model family; cost is computed later.
const sessionCache = new Map();

function dayOf(ts, fallback) {
  return (ts || fallback || '1970-01-01T00:00:00Z').slice(0, 10);
}

// Iterate the non-blank lines of a (possibly large) transcript without the
// up-front array that raw.split('\n') allocates for every line at once — peak
// memory stays at the file string plus one line, which matters for big files.
function forEachLine(raw, cb) {
  let start = 0;
  const n = raw.length;
  while (start < n) {
    let nl = raw.indexOf('\n', start);
    if (nl === -1) nl = n;
    const line = raw.slice(start, nl);
    if (line.trim()) cb(line);
    start = nl + 1;
  }
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
    parseErrors: 0, // malformed JSONL lines skipped — counted so the drop isn't silent
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
      // hours: { 0..23 -> { byFamily, messages } } for the day×hour activity grid.
      // toolErrors: { toolName -> failed-call count }.
      // errorFollowup: { family -> bundle } — usage of assistant turns that ran
      //   right after a failed tool result (a proxy for retry/recovery spend).
      // byModel: { exactModelId -> { family -> bundle } } for the precise model mix.
      // byEntry: { entrypoint -> { family -> bundle } } — interactive (cli) vs
      //   automated (sdk-cli) spend.
      // byBranch: { gitBranch -> { family -> bundle } } — spend per git branch, so
      //   cost can be read per feature, not just per session.
      // byAgentKind: { 'main'|'subagent' -> { family -> bundle } } — how much spend
      //   was delegated to Task subagents (isSidechain) vs the main thread.
      // byTier: { service_tier -> { family -> bundle } } — standard vs priority/batch,
      //   which carry different price multipliers; surfaces a silent tier change.
      // turnMs/turns/durations: wall-clock turn latency from `turn_duration`
      //   system records (durations kept for percentiles).
      data.days[key] = {
        userPrompts: 0, assistantMessages: 0, toolUses: 0, tools: {},
        byFamily: {}, bySkill: {}, byMcp: {}, byModel: {}, byEntry: {}, hours: {},
        byBranch: {}, byAgentKind: {}, byTier: {},
        toolErrors: {}, errorFollowup: {},
        // Per-turn signals — counts, not token bundles. stopReasons: { reason ->
        //   count } (how assistant turns ended; max_tokens = truncated, refusal).
        // compactions / compactTrigger / compactPreTokens / compactMs: context
        //   auto-compaction events (compact_boundary) and their metadata.
        // thinkingTurns / thinkingBlocks: extended-thinking usage (the thinking
        //   TEXT is stripped from transcripts, so this is frequency, not tokens).
        // imageTurns / images: user-pasted image blocks (tool-result images excluded).
        // webSearch / webFetch: server-side tool requests (billed per request).
        stopReasons: {}, compactions: 0, compactTrigger: {}, compactPreTokens: 0, compactMs: 0,
        thinkingTurns: 0, thinkingBlocks: 0, imageTurns: 0, images: 0,
        webSearch: 0, webFetch: 0,
        turnMs: 0, turns: 0, durations: [],
        // Output metrics (the "R" in ROI): git commits, PRs opened, and files
        // touched by Edit/Write. editsByFile keys give the distinct-file count
        // when days are unioned across a date range.
        commits: 0, prs: 0, edits: 0, editsByFile: {},
      };
    }
    return data.days[key];
  };
  const getFam = (day, fam) => famBundleIn(day.byFamily, fam);
  const getHour = (day, ts) => {
    const h = hourOf(ts);
    if (!day.hours[h]) day.hours[h] = { byFamily: {}, messages: 0 };
    return day.hours[h];
  };

  // Session-local, used while walking the linear log:
  //  toolNames maps a tool_use id -> tool name so a later tool_result (which only
  //  carries the id) can be charged to the right tool.
  //  pendingError flags that the most recent tool result failed, so the *next*
  //  assistant turn's usage counts as recovery spend.
  const toolNames = {};
  let pendingError = false;

  forEachLine(raw, (line) => {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      data.parseErrors += 1;
      return;
    }

    if (o.cwd && !data.cwd) data.cwd = o.cwd;
    if (o.gitBranch && !data.gitBranch) data.gitBranch = o.gitBranch;
    if (o.timestamp) {
      if (!data.start || o.timestamp < data.start) data.start = o.timestamp;
      if (!data.end || o.timestamp > data.end) data.end = o.timestamp;
    }
    if (o.type === 'ai-title' && o.aiTitle) data.title = o.aiTitle;

    // Wall-clock turn latency (Claude Code emits one per completed turn).
    if (o.type === 'system' && o.subtype === 'turn_duration' && typeof o.durationMs === 'number' && o.durationMs >= 0) {
      const day = getDay(o.timestamp);
      day.turnMs += o.durationMs;
      day.turns += 1;
      day.durations.push(o.durationMs);
    }

    // Context compaction: Claude Code emits one compact_boundary when the running
    // context is summarized. compactMetadata carries the trigger (manual vs auto)
    // and preTokens (how full the context got before it was compacted).
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const day = getDay(o.timestamp);
      day.compactions += 1;
      const cm = o.compactMetadata || {};
      const trig = cm.trigger || 'unknown';
      day.compactTrigger[trig] = (day.compactTrigger[trig] || 0) + 1;
      if (typeof cm.preTokens === 'number' && cm.preTokens > 0) day.compactPreTokens += cm.preTokens;
      if (typeof cm.durationMs === 'number' && cm.durationMs > 0) day.compactMs += cm.durationMs;
    }

    if (o.type === 'user') {
      const content = o.message && o.message.content;
      if (typeof content === 'string' && content.trim()) {
        if (!data.firstPrompt) data.firstPrompt = content;
        getDay(o.timestamp).userPrompts += 1;
      } else if (Array.isArray(content)) {
        // Array-content user messages carry tool results AND user-pasted images.
        // Tally failed results (recovery spend) and top-level image blocks — the
        // latter is a multimodal-input signal. Images returned *inside* a
        // tool_result (screenshots, image file reads) are nested one level deeper
        // and deliberately not counted as "you working with an image".
        let imgs = 0;
        for (const b of content) {
          if (!b) continue;
          if (b.type === 'tool_result' && b.is_error) {
            pendingError = true;
            const name = toolNames[b.tool_use_id] || 'unknown';
            const day = getDay(o.timestamp);
            day.toolErrors[name] = (day.toolErrors[name] || 0) + 1;
          } else if (b.type === 'image') {
            imgs += 1;
          }
        }
        if (imgs > 0) {
          const day = getDay(o.timestamp);
          day.imageTurns += 1;
          day.images += imgs;
        }
      }
    }

    if (o.type === 'assistant' && o.message) {
      const msg = o.message;
      const family = modelFamily(msg.model);
      const day = getDay(o.timestamp);
      const hour = getHour(day, o.timestamp);
      day.assistantMessages += 1;
      hour.messages += 1;

      // How the turn ended: end_turn / tool_use are normal; max_tokens means the
      // answer was truncated and refusal means it was declined — both friction.
      if (msg.stop_reason) day.stopReasons[msg.stop_reason] = (day.stopReasons[msg.stop_reason] || 0) + 1;

      if (Array.isArray(msg.content)) {
        let thinkBlocks = 0;
        for (const b of msg.content) {
          if (b && b.type === 'tool_use') {
            day.toolUses += 1;
            const name = b.name || 'unknown';
            day.tools[name] = (day.tools[name] || 0) + 1;
            if (b.id) toolNames[b.id] = name; // for later tool_result matching
            recordOutput(day, name, b.input); // commits / PRs / files touched
          } else if (b && b.type === 'thinking') {
            thinkBlocks += 1; // extended-thinking usage (text itself is stripped)
          }
        }
        if (thinkBlocks > 0) { day.thinkingTurns += 1; day.thinkingBlocks += thinkBlocks; }
      }

      const u = msg.usage;
      if (u) {
        const bundle = usageToBundle(u);
        // Server-side tools (web search / fetch) are billed per request, separate
        // from token usage, so count them rather than folding into the bundle.
        const st = u.server_tool_use;
        if (st) {
          day.webSearch += st.web_search_requests || 0;
          day.webFetch += st.web_fetch_requests || 0;
        }
        addBundle(getFam(day, family), bundle);
        addBundle(famBundleIn(hour.byFamily, family), bundle);
        // Track the exact model id (opus-4-8 vs opus-4-7, etc.); skip synthetic
        // messages, which carry no billable tokens.
        if (msg.model && msg.model !== '<synthetic>') addBundle(nestFam(day.byModel, msg.model, family), bundle);
        // Interactive (cli) vs automated (sdk-cli) spend, keyed by entrypoint.
        addBundle(nestFam(day.byEntry, o.entrypoint || 'unknown', family), bundle);
        // Spend per git branch / subagent vs main thread / service tier — same
        // tokens, sliced by a few more dimensions present on the line. Branch can
        // change mid-session, so read it per message (falling back to the
        // session's first-seen branch, then 'unknown').
        addBundle(nestFam(day.byBranch, o.gitBranch || data.gitBranch || 'unknown', family), bundle);
        addBundle(nestFam(day.byAgentKind, o.isSidechain ? 'subagent' : 'main', family), bundle);
        addBundle(nestFam(day.byTier, (u.service_tier || 'standard'), family), bundle);
        // Spend on the turn that followed a failed tool result = recovery cost.
        if (pendingError) {
          addBundle(famBundleIn(day.errorFollowup, family), bundle);
          pendingError = false;
        }
        // Attribute the same tokens to the skill / MCP server that drove the turn,
        // when Claude Code tagged the message. Both ride on usage-bearing messages.
        if (o.attributionSkill) addBundle(nestFam(day.bySkill, o.attributionSkill, family), bundle);
        if (o.attributionMcpServer) addBundle(nestFam(day.byMcp, o.attributionMcpServer, family), bundle);
      }
    }
  });

  if (data.parseErrors > 0) {
    console.warn(`[ledger] ${data.id}: skipped ${data.parseErrors} malformed transcript line(s)`);
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

// --- Command history + plans (sidecar sources) ------------------------------
// history.jsonl is Claude Code's submitted-prompt log — one
// { display, project (cwd), sessionId, timestamp } per prompt. It outlives the
// transcripts (which Claude Code prunes after cleanupPeriodDays), so it's a more
// durable activity spine. We deliberately keep ONLY the slash-command name (the
// first token, when the prompt is a command) plus per-prompt counts — never the
// prompt text itself. plans/ holds plan-mode markdown; we read titles + sizes.
const COMMAND_RE = /^(\/[A-Za-z0-9:_-]+)/;
let historyCache = { mtimeMs: null, size: null, entries: null };
function loadHistoryEntries() {
  let st;
  try { st = fs.statSync(HISTORY_FILE); } catch { return []; }
  if (historyCache.entries && historyCache.mtimeMs === st.mtimeMs && historyCache.size === st.size) {
    return historyCache.entries;
  }
  let raw;
  try { raw = fs.readFileSync(HISTORY_FILE, 'utf8'); } catch { return []; }
  const entries = [];
  forEachLine(raw, (line) => {
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const ts = o.timestamp;
    const day = typeof ts === 'number' && isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : null;
    const display = typeof o.display === 'string' ? o.display.trim() : '';
    const m = COMMAND_RE.exec(display);
    entries.push({
      day,
      project: typeof o.project === 'string' ? o.project : null,
      command: m ? m[1] : null, // command NAME only — no args, no prompt text
      pasted: !!(o.pastedContents && typeof o.pastedContents === 'object' && Object.keys(o.pastedContents).length),
    });
  });
  historyCache = { mtimeMs: st.mtimeMs, size: st.size, entries };
  return entries;
}

// Command/prompt analytics for a range. scope === undefined → all projects;
// a string → only prompts whose project cwd equals it exactly (per-project view).
// Entries without a parseable timestamp can only be counted for an all-time range.
function analyzeHistory(from, to, scope) {
  const entries = loadHistoryEntries();
  const commands = {};
  const days = new Set();
  let prompts = 0, commandPrompts = 0, pasted = 0;
  for (const e of entries) {
    if (scope !== undefined && e.project !== scope) continue;
    if (e.day) { if (!inRange(e.day, from, to)) continue; }
    else if (from || to) continue;
    prompts += 1;
    if (e.pasted) pasted += 1;
    if (e.day) days.add(e.day);
    if (e.command) { commandPrompts += 1; commands[e.command] = (commands[e.command] || 0) + 1; }
  }
  const topCommands = Object.entries(commands)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return {
    available: entries.length > 0,
    prompts, commandPrompts, pasted, activeDays: days.size,
    distinctCommands: topCommands.length,
    topCommands: topCommands.slice(0, 20),
  };
}

// Plan-mode files: title (first markdown heading, else filename) + byte size +
// mtime day. Cached on the directory's mtime (catches add/remove — the common
// case; an in-place content edit is rare and not worth re-reading every file for).
let plansCache = { mtimeMs: null, plans: null };
function loadPlans() {
  let st;
  try { st = fs.statSync(PLANS_DIR); } catch { return []; }
  if (plansCache.plans && plansCache.mtimeMs === st.mtimeMs) return plansCache.plans;
  let names;
  try { names = fs.readdirSync(PLANS_DIR); } catch { return []; }
  const plans = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const fp = path.join(PLANS_DIR, name);
    let s;
    try { s = fs.statSync(fp); } catch { continue; }
    if (!s.isFile()) continue;
    let title = name.replace(/\.md$/, '');
    try {
      const m = fs.readFileSync(fp, 'utf8').slice(0, 4096).match(/^#\s+(.+)$/m);
      if (m) title = m[1].trim();
    } catch { /* keep filename title */ }
    plans.push({ title, bytes: s.size, day: new Date(s.mtimeMs).toISOString().slice(0, 10) });
  }
  plansCache = { mtimeMs: st.mtimeMs, plans };
  return plans;
}

// Plan analytics for a range (filtered by file mtime day).
function analyzePlans(from, to) {
  const plans = loadPlans();
  const ranged = plans.filter((p) => inRange(p.day, from, to));
  return {
    available: plans.length > 0,
    total: plans.length,
    inRange: ranged.length,
    bytesInRange: ranged.reduce((s, p) => s + p.bytes, 0),
    recent: ranged.slice().sort((a, b) => b.day.localeCompare(a.day)).slice(0, 10)
      .map((p) => ({ title: p.title, bytes: p.bytes, day: p.day })),
  };
}

// --- File-history churn (the VOLUME side of output) -------------------------
// file-history/<sessionId>/<fileHash>@vN holds full snapshots of each edited file
// at each version. Diffing consecutive versions of a fileHash gives lines
// added/removed — a real output-volume signal, a step up from "files touched".
// The diff is an order-insensitive multiset diff (cheap, O(lines)): a changed
// line counts as +1 added / +1 removed and moves are ignored, so it's an
// APPROXIMATE churn, labeled as such in the UI. Per-session results are cached on
// the session dir's mtime, so only sessions with a new version are re-read.
const VERSION_RE = /^(.*)@v(\d+)$/;
const MAX_CHURN_FILE_BYTES = 2 * 1024 * 1024; // skip pathologically large snapshots
function lineCounts(txt) {
  const m = new Map();
  let start = 0;
  const n = txt.length;
  while (start <= n) {
    let nl = txt.indexOf('\n', start);
    if (nl === -1) nl = n;
    const line = txt.slice(start, nl);
    m.set(line, (m.get(line) || 0) + 1);
    if (nl === n) break;
    start = nl + 1;
  }
  return m;
}
function lineChurn(oldText, newText) {
  const a = lineCounts(oldText);
  const b = lineCounts(newText);
  let added = 0, removed = 0;
  for (const [line, bc] of b) { const ac = a.get(line) || 0; if (bc > ac) added += bc - ac; }
  for (const [line, ac] of a) { const bc = b.get(line) || 0; if (ac > bc) removed += ac - bc; }
  return { added, removed };
}
function computeSessionChurn(dirPath) {
  let names;
  try { names = fs.readdirSync(dirPath); } catch { return null; }
  const groups = new Map(); // fileHash -> [{ v, file }]
  for (const name of names) {
    const m = VERSION_RE.exec(name);
    if (!m) continue;
    const hash = m[1];
    if (!groups.has(hash)) groups.set(hash, []);
    groups.get(hash).push({ v: Number(m[2]), file: path.join(dirPath, name) });
  }
  let added = 0, removed = 0, revisions = 0, filesRevised = 0, skipped = 0;
  for (const versions of groups.values()) {
    versions.sort((a, b) => a.v - b.v);
    revisions += versions.length;
    let prev = null, changed = false;
    for (const { file } of versions) {
      let txt;
      try {
        const st = fs.statSync(file);
        if (st.size > MAX_CHURN_FILE_BYTES) { skipped += 1; break; }
        txt = fs.readFileSync(file, 'utf8');
      } catch { break; }
      if (prev != null) {
        const c = lineChurn(prev, txt);
        added += c.added; removed += c.removed;
        if (c.added || c.removed) changed = true;
      }
      prev = txt;
    }
    if (changed) filesRevised += 1;
  }
  return { added, removed, net: added - removed, revisions, filesRevised, skipped };
}
const churnCache = new Map(); // sessionId -> { mtimeMs, day, churn }
function sessionChurn(sessionId) {
  const dirPath = path.join(FILE_HISTORY_DIR, sessionId);
  let st;
  try { st = fs.statSync(dirPath); } catch { return null; }
  if (!st.isDirectory()) return null;
  const cached = churnCache.get(sessionId);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached;
  const churn = computeSessionChurn(dirPath);
  if (!churn) return null;
  const entry = { mtimeMs: st.mtimeMs, day: new Date(st.mtimeMs).toISOString().slice(0, 10), churn };
  churnCache.set(sessionId, entry);
  return entry;
}
// Aggregate churn over a range, optionally scoped to a Set of session ids (the
// per-project view). Range-filtered by each session dir's mtime day (when its
// last edit landed). scope === undefined → every session in file-history.
function analyzeChurn(from, to, scope) {
  let names;
  try { names = fs.readdirSync(FILE_HISTORY_DIR); }
  catch { return { available: false, added: 0, removed: 0, net: 0, filesRevised: 0, revisions: 0, sessions: 0, skipped: 0 }; }
  let added = 0, removed = 0, filesRevised = 0, revisions = 0, sessions = 0, skipped = 0;
  for (const sid of names) {
    if (scope !== undefined && !scope.has(sid)) continue;
    const e = sessionChurn(sid);
    if (!e) continue;
    if (e.day && !inRange(e.day, from, to)) continue;
    const c = e.churn;
    if (!c.filesRevised && !c.added && !c.removed) continue; // tracked but no captured edits
    added += c.added; removed += c.removed;
    filesRevised += c.filesRevised; revisions += c.revisions; skipped += c.skipped;
    sessions += 1;
  }
  return { available: names.length > 0, added, removed, net: added - removed, filesRevised, revisions, sessions, skipped };
}

// --- Sessions & tasks: concurrency + live state -----------------------------
// Concurrency (how many sessions ran in parallel) is computed from transcript
// session [start,end] intervals — range-accurate, no extra source. The live
// registry (sessions/) and background-task dirs (tasks/) are read directly as a
// snapshot of "now".
function sessionConcurrency(intervals) {
  const clean = intervals.filter((it) => it && isFinite(it.start) && isFinite(it.end) && it.end >= it.start);
  const evs = [];
  for (const it of clean) { evs.push([it.start, 1]); evs.push([it.end, -1]); }
  // Tie-break ends (-1) before starts (+1): a session ending exactly as another
  // starts is not counted as overlapping.
  evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, max = 0;
  for (const [, d] of evs) { cur += d; if (cur > max) max = cur; }
  let parallel = 0;
  for (let i = 0; i < clean.length; i++) {
    for (let j = 0; j < clean.length; j++) {
      if (i === j) continue;
      if (clean[i].start < clean[j].end && clean[j].start < clean[i].end) { parallel += 1; break; }
    }
  }
  return { maxConcurrent: max, parallelSessions: parallel, totalSessions: clean.length };
}
function loadLiveSessions() {
  let names;
  try { names = fs.readdirSync(SESSIONS_DIR); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let o;
    try { o = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8')); } catch { continue; }
    out.push({
      name: typeof o.name === 'string' ? o.name : null,
      cwd: typeof o.cwd === 'string' ? o.cwd : null,
      status: o.status || 'unknown',
      kind: o.kind || null,
      entrypoint: o.entrypoint || null,
      version: o.version || null,
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : null,
    });
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}
function analyzeTasks(from, to) {
  let entries;
  try { entries = fs.readdirSync(TASKS_DIR, { withFileTypes: true }); }
  catch { return { available: false, total: 0, inRange: 0 }; }
  let total = 0, ranged = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    total += 1;
    let day = null;
    try { day = new Date(fs.statSync(path.join(TASKS_DIR, e.name)).mtimeMs).toISOString().slice(0, 10); } catch { /* ignore */ }
    if (day && inRange(day, from, to)) ranged += 1;
  }
  return { available: total > 0, total, inRange: ranged };
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
  const byModel = {};
  const byEntry = {};
  const byBranch = {};
  const byAgentKind = {};
  const byTier = {};
  const tools = {};
  const toolErrors = {};
  const errorFollowup = {};
  const editsByFile = {};
  const stopReasons = {};
  const compactTrigger = {};
  let userPrompts = 0;
  let assistantMessages = 0;
  let toolUses = 0;
  let commits = 0;
  let prs = 0;
  let edits = 0;
  let compactions = 0, compactPreTokens = 0, compactMs = 0;
  let thinkingTurns = 0, thinkingBlocks = 0, imageTurns = 0, images = 0;
  let webSearch = 0, webFetch = 0;
  let has = false;
  for (const [day, d] of Object.entries(s.days)) {
    if (!inRange(day, from, to)) continue;
    if (d.userPrompts || d.assistantMessages) has = true;
    userPrompts += d.userPrompts;
    assistantMessages += d.assistantMessages;
    toolUses += d.toolUses;
    commits += d.commits || 0;
    prs += d.prs || 0;
    edits += d.edits || 0;
    compactions += d.compactions || 0;
    compactPreTokens += d.compactPreTokens || 0;
    compactMs += d.compactMs || 0;
    thinkingTurns += d.thinkingTurns || 0;
    thinkingBlocks += d.thinkingBlocks || 0;
    imageTurns += d.imageTurns || 0;
    images += d.images || 0;
    webSearch += d.webSearch || 0;
    webFetch += d.webFetch || 0;
    for (const [r, c] of Object.entries(d.stopReasons || {})) stopReasons[r] = (stopReasons[r] || 0) + c;
    for (const [t, c] of Object.entries(d.compactTrigger || {})) compactTrigger[t] = (compactTrigger[t] || 0) + c;
    for (const [n, c] of Object.entries(d.tools)) tools[n] = (tools[n] || 0) + c;
    for (const [n, c] of Object.entries(d.editsByFile || {})) editsByFile[n] = (editsByFile[n] || 0) + c;
    for (const [n, c] of Object.entries(d.toolErrors || {})) toolErrors[n] = (toolErrors[n] || 0) + c;
    for (const [fam, b] of Object.entries(d.byFamily)) addBundle(famBundleIn(byFamily, fam), b);
    for (const [fam, b] of Object.entries(d.errorFollowup || {})) addBundle(famBundleIn(errorFollowup, fam), b);
    mergeByName(bySkill, d.bySkill || {});
    mergeByName(byMcp, d.byMcp || {});
    mergeByName(byModel, d.byModel || {});
    mergeByName(byEntry, d.byEntry || {});
    mergeByName(byBranch, d.byBranch || {});
    mergeByName(byAgentKind, d.byAgentKind || {});
    mergeByName(byTier, d.byTier || {});
  }
  return { byFamily, bySkill, byMcp, byModel, byEntry, byBranch, byAgentKind, byTier, tools, toolErrors, errorFollowup, editsByFile, stopReasons, compactTrigger, compactions, compactPreTokens, compactMs, thinkingTurns, thinkingBlocks, imageTurns, images, webSearch, webFetch, userPrompts, assistantMessages, toolUses, commits, prs, edits, has };
}

// --- Shared aggregation -----------------------------------------------------
// projectDetail() and overview() once reimplemented the same per-session fold
// and finalize tail. They now share three pieces: an accumulator (token bundles
// + counts + per-day chart + day×hour activity + latency + prev-period), foldSession()
// to roll one session's in-range aggregate into it, and finalizeCommon() to turn
// it into the output block both views return. Each function keeps only what's
// unique to it (the session table; the project leaderboard + budget/plan/worklog).
function newAccumulator() {
  return {
    grand: {}, prevGrand: {}, prevErrorFollowup: {},
    bySkill: {}, byMcp: {}, byModel: {}, byEntry: {},
    byBranch: {}, byAgentKind: {}, byTier: {},
    tools: {}, toolErrors: {}, errorFollowup: {},
    stopReasons: {}, compactTrigger: {},
    dayMap: {}, dayHours: {}, durations: [],
    editsByFile: {},
    userPrompts: 0, assistantMessages: 0, toolUses: 0,
    commits: 0, prs: 0, edits: 0,
    compactions: 0, compactPreTokens: 0, compactMs: 0,
    thinkingTurns: 0, thinkingBlocks: 0, imageTurns: 0, images: 0,
    webSearch: 0, webFetch: 0,
    prevPrompts: 0, turnMs: 0, sessionCount: 0,
    dataStart: null, dataEnd: null,
  };
}

// Fold a session's previous-period aggregate into the accumulator. Independent
// of the current range (a session can contribute to "prev" but not "current"),
// so callers run it before the in-range has-check.
function foldPrev(acc, pa) {
  if (!pa || !pa.has) return;
  acc.prevPrompts += pa.userPrompts;
  for (const [fam, b] of Object.entries(pa.byFamily)) addBundle(famBundleIn(acc.prevGrand, fam), b);
  // Prior-period recovery spend, so the verdict can grade the efficiency trend.
  for (const [fam, b] of Object.entries(pa.errorFollowup)) addBundle(famBundleIn(acc.prevErrorFollowup, fam), b);
}

// Fold a session's in-range aggregate (agg = aggregateSession(s, from, to), with
// agg.has already confirmed) plus its per-day buckets into the accumulator.
function foldSession(acc, s, agg, from, to) {
  acc.sessionCount += 1;
  acc.userPrompts += agg.userPrompts;
  acc.assistantMessages += agg.assistantMessages;
  acc.toolUses += agg.toolUses;
  acc.commits += agg.commits;
  acc.prs += agg.prs;
  acc.edits += agg.edits;
  for (const [n, c] of Object.entries(agg.editsByFile)) acc.editsByFile[n] = (acc.editsByFile[n] || 0) + c;
  for (const [n, c] of Object.entries(agg.tools)) acc.tools[n] = (acc.tools[n] || 0) + c;
  for (const [n, c] of Object.entries(agg.toolErrors)) acc.toolErrors[n] = (acc.toolErrors[n] || 0) + c;
  for (const [fam, b] of Object.entries(agg.byFamily)) addBundle(famBundleIn(acc.grand, fam), b);
  for (const [fam, b] of Object.entries(agg.errorFollowup)) addBundle(famBundleIn(acc.errorFollowup, fam), b);
  mergeByName(acc.bySkill, agg.bySkill);
  mergeByName(acc.byMcp, agg.byMcp);
  mergeByName(acc.byModel, agg.byModel);
  mergeByName(acc.byEntry, agg.byEntry);
  mergeByName(acc.byBranch, agg.byBranch);
  mergeByName(acc.byAgentKind, agg.byAgentKind);
  mergeByName(acc.byTier, agg.byTier);
  // Per-turn signal counters (scalars + two count maps).
  acc.compactions += agg.compactions;
  acc.compactPreTokens += agg.compactPreTokens;
  acc.compactMs += agg.compactMs;
  acc.thinkingTurns += agg.thinkingTurns;
  acc.thinkingBlocks += agg.thinkingBlocks;
  acc.imageTurns += agg.imageTurns;
  acc.images += agg.images;
  acc.webSearch += agg.webSearch;
  acc.webFetch += agg.webFetch;
  for (const [r, c] of Object.entries(agg.stopReasons)) acc.stopReasons[r] = (acc.stopReasons[r] || 0) + c;
  for (const [t, c] of Object.entries(agg.compactTrigger)) acc.compactTrigger[t] = (acc.compactTrigger[t] || 0) + c;

  // Per-day rollup: the daily chart, the day×hour activity grid, latency samples, and the
  // span of days that actually carried activity.
  for (const [day, d] of Object.entries(s.days)) {
    if (!inRange(day, from, to)) continue;
    if (!acc.dayMap[day]) acc.dayMap[day] = { byFamily: {}, messages: 0, userPrompts: 0 };
    acc.dayMap[day].messages += d.assistantMessages;
    acc.dayMap[day].userPrompts += d.userPrompts;
    for (const [fam, b] of Object.entries(d.byFamily)) addBundle(famBundleIn(acc.dayMap[day].byFamily, fam), b);
    accumulateDayHours(acc.dayHours, day, d);
    if (d.durations && d.durations.length) for (const x of d.durations) acc.durations.push(x);
    acc.turnMs += d.turnMs || 0;
    if (!acc.dataStart || day < acc.dataStart) acc.dataStart = day;
    if (!acc.dataEnd || day > acc.dataEnd) acc.dataEnd = day;
  }
}

// Turn an accumulator into the output block shared by both views. Each priced
// stat is computed once here (the old code priced several of them twice — once
// standalone, once inside the insights args); same numbers, half the work.
function finalizeCommon(acc, prev) {
  const totals = priceBundles(acc.grand);
  const daily = Object.entries(acc.dayMap)
    .map(([date, v]) => {
      const pr = priceBundles(v.byFamily);
      return { date, cost: pr.cost, costByFamily: pr.costByFamily, messages: v.messages, userPrompts: v.userPrompts };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const topTools = Object.entries(acc.tools)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  const reliability = reliabilityStats(acc.tools, acc.toolErrors, acc.errorFollowup);
  const time = timeStats(acc.durations, acc.userPrompts, totals.cost);
  const topModels = pricedModels(acc.byModel);
  const topEntrypoints = priceByName(acc.byEntry);
  const topBranches = priceByName(acc.byBranch);
  const topAgentKinds = priceByName(acc.byAgentKind);
  const topTiers = priceByName(acc.byTier);
  const delta = prev ? makeDelta(prev, totals.cost, priceBundles(acc.prevGrand).cost, acc.userPrompts, acc.prevPrompts) : null;
  const output = outputStats({ commits: acc.commits, prs: acc.prs, edits: acc.edits, editsByFile: acc.editsByFile }, totals.cost);
  return {
    totals,
    daily,
    topTools,
    hourly: priceHourly(acc.dayHours),
    topModels,
    topEntrypoints,
    topBranches,
    topAgentKinds,
    topTiers,
    topSkills: priceByName(acc.bySkill),
    topMcp: priceByName(acc.byMcp),
    reliability,
    time,
    signals: turnSignals(acc, acc.assistantMessages),
    efficiency: efficiencyStats(acc.grand, acc.userPrompts, acc.toolUses),
    output,
    delta,
  };
}

// --- Project-level aggregation ---------------------------------------------
function projectDetail(folder, from, to) {
  const projectPath = resolveProjectDir(folder);
  if (!projectPath) return null;
  const files = listSessionFiles(projectPath);
  const items = [];
  for (const f of files) {
    const s = parseSession(f);
    if (!s) continue;
    items.push(s);
  }
  if (items.length === 0) return null;

  const prev = previousPeriod(from, to);
  const acc = newAccumulator();
  let cwd = null;
  let gitBranch = null;
  const sessions = []; // the per-session table

  for (const s of items) {
    if (s.cwd && !cwd) cwd = s.cwd;
    if (s.gitBranch && !gitBranch) gitBranch = s.gitBranch;

    foldPrev(acc, prev ? aggregateSession(s, prev.from, prev.to) : null);
    const agg = aggregateSession(s, from, to);
    if (!agg.has) continue;
    foldSession(acc, s, agg, from, to);

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

  const c = finalizeCommon(acc, prev);
  sessions.sort((a, b) => (b.end || '').localeCompare(a.end || ''));

  return {
    id: folder,
    name: projectName(folder, cwd),
    cwd: cwd || projectName(folder, null),
    gitBranch,
    totals: {
      cost: c.totals.cost,
      costByFamily: c.totals.costByFamily,
      tokens: c.totals.tokens,
      models: c.totals.models,
      userPrompts: acc.userPrompts,
      assistantMessages: acc.assistantMessages,
      toolUses: acc.toolUses,
      sessions: acc.sessionCount,
      sessionsTotal: items.length,
      start: acc.dataStart,
      end: acc.dataEnd,
    },
    cacheSavings: c.totals.cacheSavings,
    perSession: {
      cost: acc.sessionCount ? c.totals.cost / acc.sessionCount : 0,
      prompt: acc.userPrompts ? c.totals.cost / acc.userPrompts : 0,
    },
    daily: c.daily,
    hourly: c.hourly,
    topTools: c.topTools,
    topModels: c.topModels,
    topEntrypoints: c.topEntrypoints,
    topBranches: c.topBranches,
    topAgentKinds: c.topAgentKinds,
    topTiers: c.topTiers,
    topSkills: c.topSkills,
    topMcp: c.topMcp,
    reliability: c.reliability,
    time: c.time,
    signals: c.signals,
    sessions,
    delta: c.delta,
    efficiency: c.efficiency,
    output: c.output,
    insights: computeInsights({ totals: { cost: c.totals.cost }, daily: c.daily, sessions, delta: c.delta, time: c.time, reliability: c.reliability, topModels: c.topModels, topEntrypoints: c.topEntrypoints, signals: c.signals, topAgentKinds: c.topAgentKinds, efficiency: c.efficiency, costByFamily: c.totals.costByFamily, output: c.output }),
    history: analyzeHistory(from, to, cwd || ''),
    churn: analyzeChurn(from, to, new Set(items.map((s) => s.id))),
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

  const M = currentMonthInfo();
  const prev = previousPeriod(from, to); // equal-length window before [from,to]
  const gacc = newAccumulator();         // global totals across all projects
  const monthGrand = {};                 // month-to-date tokens, independent of the range
  const themeWords = {};                 // title-word frequency for work-log themes
  let projectCount = 0;
  const projects = [];
  const intervals = []; // [start,end] ms per in-range session, for concurrency

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const projectPath = path.join(PROJECTS_DIR, e.name);
    const files = listSessionFiles(projectPath);
    const items = [];
    for (const f of files) {
      const s = parseSession(f);
      if (!s) continue;
      items.push(s);
    }
    if (items.length === 0) continue;

    const pacc = newAccumulator(); // this project's slice; merged-by-folding below
    let cwd = null;
    let lastActive = null;
    const pTitles = []; // { title, cost } — work-log highlights for this project

    for (const s of items) {
      if (s.cwd && !cwd) cwd = s.cwd;
      if (s.end && (!lastActive || s.end > lastActive)) lastActive = s.end;

      // Month-to-date aggregation (independent of the selected range).
      for (const [day, d] of Object.entries(s.days)) {
        if (day >= M.monthStart && day <= M.today) {
          for (const [fam, b] of Object.entries(d.byFamily)) addBundle(famBundleIn(monthGrand, fam), b);
        }
      }

      // Fold each session into both this project's accumulator and the global
      // one (agg computed once, reused). Prev-period folds regardless of range.
      const pa = prev ? aggregateSession(s, prev.from, prev.to) : null;
      foldPrev(pacc, pa);
      foldPrev(gacc, pa);
      const agg = aggregateSession(s, from, to);
      if (!agg.has) continue;
      foldSession(pacc, s, agg, from, to);
      foldSession(gacc, s, agg, from, to);
      if (s.start && s.end) intervals.push({ start: Date.parse(s.start), end: Date.parse(s.end) });

      const wlTitle = sessionTitle(s);
      pTitles.push({ title: wlTitle, cost: priceBundles(agg.byFamily).cost });
      if (wlTitle !== '(untitled)') for (const w of titleWords(wlTitle)) themeWords[w] = (themeWords[w] || 0) + 1;
    }

    if (pacc.sessionCount > 0) projectCount += 1;
    const priced = priceBundles(pacc.grand);
    const prevCost = prev ? priceBundles(pacc.prevGrand).cost : null;
    projects.push({
      id: e.name,
      name: projectName(e.name, cwd),
      cwd: cwd || projectName(e.name, null),
      sessions: pacc.sessionCount,
      userPrompts: pacc.userPrompts,
      cost: priced.cost,
      cacheSavings: priced.cacheSavings,
      turnMs: pacc.turnMs,
      lastActive,
      commits: pacc.commits,
      prs: pacc.prs,
      filesEdited: Object.keys(pacc.editsByFile).length,
      topTitles: pTitles.sort((a, b) => b.cost - a.cost).slice(0, 3).map((t) => t.title),
      costPrev: prevCost,
      costPct: prev && prevCost > 0 ? (priced.cost - prevCost) / prevCost : null,
    });
  }

  const c = finalizeCommon(gacc, prev);
  const concurrency = sessionConcurrency(intervals); // also feeds the insights engine
  projects.sort((a, b) => b.cost - a.cost || (b.lastActive || '').localeCompare(a.lastActive || ''));

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

  // Plan mode: for flat-fee (Max/Pro) users the dollar figure is hypothetical
  // API-list-price usage, not a bill. Express it as leverage over the flat fee —
  // roughly how much metered API the same work would have cost.
  const planFee = getPlanFee();
  const plan = planFee != null ? {
    monthlyFee: planFee,
    mtdApiEquiv: monthPriced.cost,
    projectedApiEquiv: projectedCost,
    leverage: planFee > 0 ? monthPriced.cost / planFee : null,
    projectedLeverage: planFee > 0 ? projectedCost / planFee : null,
    monthStart: M.monthStart,
    today: M.today,
  } : null;

  // ROI verdict — graded over the effective range (the selected range, or the
  // data span when unbounded) so value-for-money lines up with the range's spend.
  const effFrom = from || gacc.dataStart;
  const effTo = to || gacc.dataEnd;
  let rangeDays = 1;
  if (effFrom && effTo) {
    const d = Math.round((Date.parse(effTo + 'T00:00:00Z') - Date.parse(effFrom + 'T00:00:00Z')) / 86400000) + 1;
    if (Number.isFinite(d) && d > 0) rangeDays = d;
  }
  // Prior-period efficiency snapshot for the direction trend (only when the
  // prior equal-length window actually has spend to compare against).
  let prevEff = null;
  if (prev) {
    const prevCost = priceBundles(gacc.prevGrand).cost;
    if (prevCost > 0) {
      prevEff = {
        cacheHitRate: efficiencyStats(gacc.prevGrand, 0, 0).cacheHitRate,
        friction: priceBundles(gacc.prevErrorFollowup).cost / prevCost,
      };
    }
  }
  const verdict = computeVerdict({
    cost: c.totals.cost,
    cacheHitRate: c.efficiency.cacheHitRate,
    wastedCost: c.reliability.wastedCost,
    output: c.output,
    cacheSavings: c.totals.cacheSavings,
    whatIf: c.efficiency.whatIf,
    planFee,
    rangeDays,
    prev: prevEff,
  });

  return {
    projectCount,
    verdict,
    totals: {
      cost: c.totals.cost,
      costByFamily: c.totals.costByFamily,
      tokens: c.totals.tokens,
      models: c.totals.models,
      userPrompts: gacc.userPrompts,
      assistantMessages: gacc.assistantMessages,
      toolUses: gacc.toolUses,
      sessions: gacc.sessionCount,
      start: gacc.dataStart,
      end: gacc.dataEnd,
    },
    cacheSavings: c.totals.cacheSavings,
    perSession: {
      cost: gacc.sessionCount ? c.totals.cost / gacc.sessionCount : 0,
      prompt: gacc.userPrompts ? c.totals.cost / gacc.userPrompts : 0,
    },
    daily: c.daily,
    hourly: c.hourly,
    topTools: c.topTools,
    topModels: c.topModels,
    topEntrypoints: c.topEntrypoints,
    topBranches: c.topBranches,
    topAgentKinds: c.topAgentKinds,
    topTiers: c.topTiers,
    topSkills: c.topSkills,
    topMcp: c.topMcp,
    reliability: c.reliability,
    time: c.time,
    signals: c.signals,
    projects,
    budget,
    plan,
    delta: c.delta,
    efficiency: c.efficiency,
    output: c.output,
    insights: computeInsights({ totals: { cost: c.totals.cost }, daily: c.daily, projects, delta: c.delta, time: c.time, reliability: c.reliability, topModels: c.topModels, topEntrypoints: c.topEntrypoints, signals: c.signals, topAgentKinds: c.topAgentKinds, efficiency: c.efficiency, costByFamily: c.totals.costByFamily, concurrency }),
    history: analyzeHistory(from, to),
    plans: analyzePlans(from, to),
    churn: analyzeChurn(from, to),
    concurrency,
    liveSessions: loadLiveSessions(),
    tasks: analyzeTasks(from, to),
    worklog: buildWorkLog({ from, to, cost: c.totals.cost, sessions: gacc.sessionCount, output: c.output, time: c.time, projects, themes: topThemes(themeWords, 6) }),
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
    const items = [];
    for (const f of files) {
      const s = parseSession(f);
      if (!s) continue;
      items.push(s);
    }
    if (items.length === 0) continue;

    const grand = {};
    let cwd = null;
    let sessions = 0;
    let prompts = 0;
    let lastActive = null;

    for (const s of items) {
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
  const byModel = {};
  const byEntry = {};
  const byBranch = {};
  const byAgentKind = {};
  const byTier = {};
  const toolErrors = {};
  const errorFollowup = {};
  const toolNames = {};
  const durations = [];
  const output = { commits: 0, prs: 0, edits: 0, editsByFile: {} };
  const stopReasons = {};
  const compactTrigger = {};
  let assistantMessages = 0;
  let compactions = 0, compactPreTokens = 0, compactMs = 0;
  let thinkingTurns = 0, thinkingBlocks = 0, imageTurns = 0, images = 0;
  let webSearch = 0, webFetch = 0;
  let pendingError = false;
  let cumCost = 0;

  let parseErrors = 0;
  forEachLine(raw, (line) => {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      parseErrors += 1;
      return;
    }
    if (o.cwd && !out.cwd) out.cwd = o.cwd;
    if (o.gitBranch && !out.gitBranch) out.gitBranch = o.gitBranch;
    if (o.timestamp) {
      if (!out.start || o.timestamp < out.start) out.start = o.timestamp;
      if (!out.end || o.timestamp > out.end) out.end = o.timestamp;
    }
    if (o.type === 'ai-title' && o.aiTitle) out.title = o.aiTitle;

    if (o.type === 'system' && o.subtype === 'turn_duration' && typeof o.durationMs === 'number' && o.durationMs >= 0) {
      durations.push(o.durationMs);
    }
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      compactions += 1;
      const cm = o.compactMetadata || {};
      const trig = cm.trigger || 'unknown';
      compactTrigger[trig] = (compactTrigger[trig] || 0) + 1;
      if (typeof cm.preTokens === 'number' && cm.preTokens > 0) compactPreTokens += cm.preTokens;
      if (typeof cm.durationMs === 'number' && cm.durationMs > 0) compactMs += cm.durationMs;
    }

    if (o.type === 'user') {
      const content = o.message && o.message.content;
      if (typeof content === 'string' && content.trim()) {
        if (!out.firstPrompt) out.firstPrompt = content;
        out.prompts.push({ ts: o.timestamp || null, text: content.slice(0, 4000) });
      } else if (Array.isArray(content)) {
        let imgs = 0;
        for (const b of content) {
          if (!b) continue;
          if (b.type === 'tool_result' && b.is_error) {
            pendingError = true;
            const name = toolNames[b.tool_use_id] || 'unknown';
            toolErrors[name] = (toolErrors[name] || 0) + 1;
          } else if (b.type === 'image') {
            imgs += 1;
          }
        }
        if (imgs > 0) { imageTurns += 1; images += imgs; }
      }
    }

    if (o.type === 'assistant' && o.message) {
      const msg = o.message;
      const family = modelFamily(msg.model);
      assistantMessages += 1;
      if (msg.stop_reason) stopReasons[msg.stop_reason] = (stopReasons[msg.stop_reason] || 0) + 1;
      if (Array.isArray(msg.content)) {
        let thinkBlocks = 0;
        for (const b of msg.content) {
          if (b && b.type === 'tool_use') {
            const name = b.name || 'unknown';
            out.tools[name] = (out.tools[name] || 0) + 1;
            if (b.id) toolNames[b.id] = name;
            recordOutput(output, name, b.input);
          } else if (b && b.type === 'thinking') {
            thinkBlocks += 1;
          }
        }
        if (thinkBlocks > 0) { thinkingTurns += 1; thinkingBlocks += thinkBlocks; }
      }
      const u = msg.usage;
      if (u) {
        const fb = usageToBundle(u);
        const st = u.server_tool_use;
        if (st) { webSearch += st.web_search_requests || 0; webFetch += st.web_fetch_requests || 0; }
        const msgCost = priceBundles({ [family]: fb }).cost;
        cumCost += msgCost;
        out.timeline.push({ ts: o.timestamp || null, cost: msgCost, cumCost });
        if (!grand[family]) grand[family] = emptyBundle();
        addBundle(grand[family], fb);
        if (msg.model && msg.model !== '<synthetic>') addBundle(nestFam(byModel, msg.model, family), fb);
        addBundle(nestFam(byEntry, o.entrypoint || 'unknown', family), fb);
        addBundle(nestFam(byBranch, o.gitBranch || out.gitBranch || 'unknown', family), fb);
        addBundle(nestFam(byAgentKind, o.isSidechain ? 'subagent' : 'main', family), fb);
        addBundle(nestFam(byTier, (u.service_tier || 'standard'), family), fb);
        if (pendingError) {
          addBundle(famBundleIn(errorFollowup, family), fb);
          pendingError = false;
        }
      }
    }
  });

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
    parseErrors,
    prompts: out.prompts,
    topTools: Object.entries(out.tools)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    topModels: pricedModels(byModel),
    topEntrypoints: priceByName(byEntry),
    topBranches: priceByName(byBranch),
    topAgentKinds: priceByName(byAgentKind),
    topTiers: priceByName(byTier),
    reliability: reliabilityStats(out.tools, toolErrors, errorFollowup),
    time: timeStats(durations, out.prompts.length, priced.cost),
    signals: turnSignals({ stopReasons, compactTrigger, compactions, compactPreTokens, compactMs, thinkingTurns, thinkingBlocks, imageTurns, images, webSearch, webFetch }, assistantMessages),
    output: outputStats(output, priced.cost),
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

// --- CSV export -------------------------------------------------------------
// Minimal RFC-4180-ish serializer: quote a cell only when it contains a comma,
// quote, or newline, and double any embedded quotes — so a project title with a
// comma can't shift columns. columns: [{ label, key? , value?(row) }].
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(rows, columns) {
  const head = columns.map((c) => csvCell(c.label)).join(',');
  const lines = (rows || []).map((r) =>
    columns.map((c) => csvCell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','));
  return [head, ...lines].join('\n') + '\n';
}
function sendCSV(res, filename, text) {
  const safe = String(filename).replace(/[^A-Za-z0-9._-]+/g, '-');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${safe}"`,
    'Cache-Control': 'no-store',
  });
  res.end(text);
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

// --- Prometheus metrics -----------------------------------------------------
// Exposition for GET /metrics so Ledger can be a scrape target — graph spend and
// usage in Grafana over time, independent of the transcript window. All-time,
// all-projects gauges.
function promMetrics(ov) {
  if (!ov) return '';
  const t = ov.totals;
  const lines = [];
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const m = (name, help, samples) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, ...samples.map(([lbl, v]) => `${name}${lbl} ${v}`));
  };
  const usd = (x) => (x || 0).toFixed(4);
  const tokens = t.tokens.input + t.tokens.output + t.tokens.cacheRead + t.tokens.cacheWrite;
  m('claude_ledger_spend_usd', 'Estimated spend in USD (all time, list prices).', [['', usd(t.cost)]]);
  m('claude_ledger_tokens', 'Total tokens (all time).', [['', tokens]]);
  m('claude_ledger_sessions', 'Sessions (all time).', [['', t.sessions]]);
  m('claude_ledger_prompts', 'User prompts (all time).', [['', t.userPrompts]]);
  m('claude_ledger_tool_calls', 'Tool calls (all time).', [['', t.toolUses]]);
  m('claude_ledger_cache_savings_usd', 'Cache savings vs uncached reads (USD).', [['', usd(ov.cacheSavings)]]);
  m('claude_ledger_tool_error_rate', 'Tool error rate, 0-1 (all time).', [['', (ov.reliability.errorRate || 0).toFixed(6)]]);
  m('claude_ledger_recovery_spend_usd', 'Spend recovering from failed tools (USD).', [['', usd(ov.reliability.wastedCost)]]);
  m('claude_ledger_commits', 'Git commits observed (all time).', [['', ov.output.commits]]);
  m('claude_ledger_files_edited', 'Distinct files edited (all time).', [['', ov.output.filesEdited]]);
  m('claude_ledger_project_spend_usd', 'Spend per project in USD (all time).',
    ov.projects.map((p) => [`{project="${esc(p.name)}"}`, usd(p.cost)]));
  return lines.join('\n') + '\n';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);
  const from = url.searchParams.get('from') || null;
  const to = url.searchParams.get('to') || null;

  try {
    if ((from && !isValidDay(from)) || (to && !isValidDay(to))) {
      return sendJSON(res, 400, { error: 'invalid date parameter; expected YYYY-MM-DD' });
    }
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
    if (pathname === '/api/worklog.md') {
      const ov = overview(from, to);
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="claude-ledger-worklog.md"', 'Cache-Control': 'no-store' });
      return res.end(ov ? worklogMarkdown(ov.worklog) : '');
    }
    if (pathname === '/api/overview.csv') {
      const ov = overview(from, to);
      if (!ov) return sendCSV(res, 'claude-ledger.csv', '');
      return sendCSV(res, 'claude-ledger-projects.csv', toCSV(ov.projects, [
        { label: 'Project', value: (p) => p.name },
        { label: 'Path', value: (p) => p.cwd },
        { label: 'Cost (USD)', value: (p) => p.cost.toFixed(4) },
        { label: 'Sessions', key: 'sessions' },
        { label: 'Prompts', key: 'userPrompts' },
        { label: 'Cache saved (USD)', value: (p) => p.cacheSavings.toFixed(4) },
        { label: 'Active time (ms)', value: (p) => Math.round(p.turnMs || 0) },
        { label: 'Last active', value: (p) => p.lastActive || '' },
      ]));
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
    if (pathname.startsWith('/api/project/') && pathname.endsWith('.csv')) {
      const id = pathname.slice('/api/project/'.length, -'.csv'.length);
      const detail = projectDetail(id, from, to);
      if (!detail) return sendJSON(res, 404, { error: 'project not found' });
      return sendCSV(res, `claude-ledger-${detail.name}-sessions.csv`, toCSV(detail.sessions, [
        { label: 'Title', value: (s) => s.title },
        { label: 'Prompts', key: 'userPrompts' },
        { label: 'Tools', key: 'toolUses' },
        { label: 'Tokens', value: (s) => s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite },
        { label: 'Cost (USD)', value: (s) => s.cost.toFixed(4) },
        { label: 'Start', value: (s) => s.start || '' },
        { label: 'End', value: (s) => s.end || '' },
      ]));
    }
    if (pathname.startsWith('/api/project/')) {
      const id = pathname.slice('/api/project/'.length);
      const detail = projectDetail(id, from, to);
      if (!detail) return sendJSON(res, 404, { error: 'project not found' });
      return sendJSON(res, 200, detail);
    }
    if (pathname === '/metrics') {
      const ov = overview(null, null);
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(ov ? promMetrics(ov) : '');
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
  getPlanFee,
  currentMonthInfo,
  shiftDay,
  weekdayOf,
  hourOf,
  isValidDay,
  previousPeriod,
  makeDelta,
  modelFamily,
  modelFamilyKnown,
  emptyBundle,
  addBundle,
  famBundleIn,
  usageToBundle,
  nestFam,
  mergeByName,
  priceBundles,
  priceByName,
  pricedModels,
  efficiencyStats,
  reliabilityStats,
  timeStats,
  turnSignals,
  recordOutput,
  outputStats,
  computeVerdict,
  VERDICT,
  computeInsights,
  promMetrics,
  buildWorkLog,
  worklogMarkdown,
  topThemes,
  titleWords,
  sessionTitle,
  isCommitCommand,
  isPrCommand,
  emptyHourRow,
  accumulateDayHours,
  priceHourly,
  inRange,
  aggregateSession,
  parseSession,
  projectDetail,
  overview,
  listProjects,
  sessionDetail,
  loadHistoryEntries,
  analyzeHistory,
  loadPlans,
  analyzePlans,
  lineChurn,
  computeSessionChurn,
  analyzeChurn,
  sessionConcurrency,
  loadLiveSessions,
  analyzeTasks,
  toCSV,
  csvCell,
  server,
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
