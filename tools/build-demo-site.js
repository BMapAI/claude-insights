'use strict';

/*
 * Builds a static GitHub Pages demo of the dashboard.
 *
 * GitHub Pages has no server, so we BAKE the synthetic demo into static JSON:
 * run the real analyzer (server.js) over generated demo data for every date
 * preset, write one file per /api response into <site>/demo/, and copy the
 * dashboard. A dormant "demo mode" in index.html (active on github.io or with
 * ?demo) routes its fetches to these files and freezes "now" to the build date
 * so the relative presets resolve to the baked ranges.
 *
 * Usage:  node tools/build-demo-site.js [siteDir]   (default: <repo>/site)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const repo = path.join(__dirname, '..');
const siteDir = process.argv[2] || path.join(repo, 'site');
const demoData = path.join(os.tmpdir(), 'claude-demo-build', 'projects');

// 1) Generate synthetic transcripts + sidecars (history/plans/file-history/…).
cp.execFileSync(process.execPath, [path.join(__dirname, 'gen-demo.js'), demoData], { stdio: 'inherit' });

// 2) Point the analyzer at the demo data, then load it. PROJECTS_DIR/CLAUDE_DIR/
//    pricing/config are read at module load, so set them BEFORE require().
//    CLAUDE_DIR defaults to dirname(PROJECTS_DIR) — where gen-demo wrote sidecars.
process.env.CLAUDE_PROJECTS_DIR = demoData;
process.env.PRICING_FILE = path.join(demoData, 'no-such-pricing.json'); // built-in default rates
process.env.CONFIG_FILE = path.join(demoData, 'no-such-config.json');   // no file budget/plan
process.env.MONTHLY_BUDGET = '400';   // drives the budget bar
process.env.PLAN_MONTHLY_FEE = '100'; // drives the plan-value (leverage) panel
delete process.env.LEDGER_PERSIST;
delete process.env.CLAUDE_LEDGER_DATA;
const L = require(path.join(repo, 'server.js'));

// UTC-stable preset → {from,to}; MUST match presetRangeUTC() in index.html.
function presetRangeUTC(name, nowYMD) {
  const shift = (ymd, days) => new Date(Date.parse(ymd + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  const [Y, M] = nowYMD.split('-').map(Number);
  const p2 = (n) => String(n).padStart(2, '0');
  if (name === 'all') return { from: null, to: null };
  if (name === 'today') return { from: nowYMD, to: nowYMD };
  if (name === 'yesterday') { const y = shift(nowYMD, -1); return { from: y, to: y }; }
  if (name === 'week' || name === 'lastweek') {
    const dow = (new Date(nowYMD + 'T00:00:00Z').getUTCDay() + 6) % 7; // Mon=0
    const monday = shift(nowYMD, -dow);
    if (name === 'week') return { from: monday, to: nowYMD };
    return { from: shift(monday, -7), to: shift(monday, -1) };
  }
  if (name === 'month') return { from: `${Y}-${p2(M)}-01`, to: nowYMD };
  if (name === 'lastmonth') {
    const ly = M === 1 ? Y - 1 : Y, lm = M === 1 ? 12 : M - 1;
    const last = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
    return { from: `${ly}-${p2(lm)}-01`, to: `${ly}-${p2(lm)}-${p2(last)}` };
  }
  const days = { '7': 6, '30': 29, '90': 89 }[name] || 0;
  return { from: shift(nowYMD, -days), to: nowYMD };
}
const PRESETS = ['all', 'today', 'yesterday', 'week', 'lastweek', 'month', 'lastmonth', '7', '30', '90'];
const nowYMD = new Date().toISOString().slice(0, 10); // build date == gen-demo's "today"
const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');

// 3) Bake one JSON per /api response, for every preset.
const demoDir = path.join(siteDir, 'demo');
fs.rmSync(siteDir, { recursive: true, force: true });
fs.mkdirSync(demoDir, { recursive: true });
const write = (name, obj) => fs.writeFileSync(path.join(demoDir, name), JSON.stringify(obj));

const pricing = L.getPricing();
const sessionsSeen = new Set();
let files = 0;
for (const name of PRESETS) {
  const { from, to } = presetRangeUTC(name, nowYMD);
  const F = from || 'all', T = to || 'all';
  const list = L.listProjects(from, to);
  // /api/projects shape (projectsDir is a friendly label, not the build path).
  write(`projects__${F}__${T}.json`, { projectsDir: '~/.claude/projects', pricing, pricingFromFile: false, bounds: list.bounds, projects: list.projects });
  files++;
  write(`overview__${F}__${T}.json`, L.overview(from, to) || {});
  files++;
  for (const p of list.projects) {
    const det = L.projectDetail(p.id, from, to);
    if (!det) continue;
    write(`project__${slug(p.id)}__${F}__${T}.json`, det);
    files++;
    for (const s of det.sessions || []) {
      const key = p.id + '/' + s.id;
      if (sessionsSeen.has(key)) continue;
      sessionsSeen.add(key);
      const sd = L.sessionDetail(p.id, s.id);
      if (sd) { write(`session__${slug(p.id)}__${slug(s.id)}.json`, sd); files++; }
    }
  }
}
write('manifest.json', { now: nowYMD, presets: PRESETS, builtFor: 'github-pages' });

// 4) Ship the dashboard + a Pages .nojekyll (so demo/ isn't filtered by Jekyll).
fs.copyFileSync(path.join(repo, 'public', 'index.html'), path.join(siteDir, 'index.html'));
fs.writeFileSync(path.join(siteDir, '.nojekyll'), '');

console.log(`Built demo site → ${siteDir}`);
console.log(`  ${files} baked snapshots across ${PRESETS.length} presets + manifest, index.html, .nojekyll`);
