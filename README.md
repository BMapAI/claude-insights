# Claude Ledger

A zero-dependency, read-only cost / ROI analyzer for [Claude Code](https://claude.com/claude-code).
It reads the session transcripts under `~/.claude/projects`, prices token usage per
model, and serves a small local web dashboard showing what your usage cost — per
project, per session, and across all projects.

## Run

Requires **Node 22+**. From a checkout of this repo:

```bash
npm start
# or: node server.js
# → http://127.0.0.1:4317
```

It reads your `~/.claude/projects` transcripts and writes nothing to `~/.claude`.
Open the printed URL in a browser.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Localhost-only by default; set `0.0.0.0` for LAN access (no auth — see below). |
| `PORT` | auto (`4317`, bumps if busy) | HTTP port. If unset, an in-use port auto-increments so multiple users on one host don't collide. Set it to pin a fixed port. |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Where to scan for transcripts |
| `PRICING_FILE` | `./pricing.json` | Path to the rates file (see Pricing below) |
| `CONFIG_FILE` | `./config.json` | Path to the settings file (budget; see below) |
| `MONTHLY_BUDGET` | _(unset)_ | Monthly budget in USD; overrides `config.json`. Powers the "This month" bar + projection. |
| `PLAN_MONTHLY_FEE` | _(unset)_ | Flat monthly subscription fee in USD; overrides `config.json`. Powers the "Plan value" leverage panel. |
| `LEDGER_PERSIST` | _(unset)_ | Set to `1` to persist durable history to `~/.claude-ledger/rollups.json` (see Durable history). |
| `CLAUDE_LEDGER_DATA` | _(unset)_ | Path to the durable-history store; overrides `LEDGER_PERSIST`'s default location. |

## Team / shared-server use

Each person's Claude transcripts are private at the OS level (`~/.claude/**` is
owner-only). So the tool runs **per person, each sees only their own usage** — a
single instance can't read a teammate's data.

Recommended setup on a shared box:

1. **Check out the code once** anywhere readable (e.g. `/var/www/claude-ledger`)
   — the app writes nothing to its own folder, so it can be shared read-only and
   updated with a single `git pull`.
2. **Each teammate runs their own instance** — it reads *their* `~/.claude`:
   ```bash
   node /var/www/claude-ledger/server.js
   ```
   It binds to localhost and auto-picks a free port, so simultaneous users don't
   collide and nobody's prompts/costs are exposed to the rest of the machine.
3. **View it over an SSH tunnel** from your laptop (the start-up log prints the
   exact command):
   ```bash
   ssh -L 4317:localhost:4317 <you>@<this-host>
   # then open http://localhost:4317
   ```

**Prerequisite:** each user needs **Node 22+** on their `PATH` (a per-user nvm
install or a system-wide Node).

> Setting `HOST=0.0.0.0` exposes the dashboard — including your prompt text and
> spend — to anyone who can reach the host on that port. There is no built-in
> auth, so only do this behind a trusted network / restrictive security group.

## Budget & projection

The All-projects view has a **This month** panel showing month-to-date spend and a
**projected month-end total** (linear extrapolation: `mtd / days_elapsed ×
days_in_month`). It's always the current calendar month, regardless of the selected
date range.

Set a monthly budget to get a budget bar (used vs. projected, with an over-pace
warning). Either edit `config.json`:

```json
{ "monthlyBudget": 500 }
```

…or set it per instance without touching files: `MONTHLY_BUDGET=500 node server.js`
(the env var wins). Leave it unset/`null` to just show the projection.

## Plan value (subscription users)

If you're on a flat-fee plan (Max/Pro), the dollar figures are **API-equivalent
list-price usage, not your bill**. Set your monthly fee to reframe that as leverage over
the subscription — how much metered API the same work would have cost:

```json
{ "planMonthlyFee": 200 }
```

…or `PLAN_MONTHLY_FEE=200 node server.js`. The All-projects view then shows a **Plan
value** panel: month-to-date API-equivalent spend, your flat fee, and how many times
over the fee your usage represents (with a projected month-end multiple). Leave it
unset/`null` to hide the panel.

## Pricing model

Rates live in `pricing.json` (USD per 1M tokens) and are **hot-reloaded** — edit
the file and the next request reprices, no restart needed. Delete the file to fall
back to the built-in defaults in `server.js`.

```json
{
  "opus":   { "input": 5, "output": 25 },
  "sonnet": { "input": 3, "output": 15 },
  "haiku":  { "input": 1, "output": 5 },
  "cacheReadMultiplier": 0.1,
  "cacheWrite5mMultiplier": 1.25,
  "cacheWrite1hMultiplier": 2.0
}
```

Cache reads bill at `cacheReadMultiplier` × the input rate; cache writes at the 5m
or 1h multiplier (chosen per message from the transcript's `cache_creation`
breakdown, falling back to 5m).

> **These figures are estimates, not your bill.** Defaults are public list prices
> and may drift as models/pricing change; unknown model names fall back to Opus
> rates. Numbers exclude negotiated discounts, batch pricing, or subscription
> plans. Use it for relative comparison and trend-spotting, not invoice
> reconciliation — and edit `pricing.json` to match your actual rates.

## Data history & retention

Ledger can only show what's still on disk. Claude Code **deletes local session
transcripts after 30 days by default** (the `cleanupPeriodDays` setting), so by
default the dashboard's history is effectively capped at the last ~30 days —
anything older has already been cleaned up before Ledger can read it. This affects
the **All time** / **90d** filters and the **period-over-period deltas**, which
silently have no data beyond the retention window.

To keep a longer history, raise `cleanupPeriodDays` in your Claude Code settings
(`~/.claude/settings.json` for all projects, or `.claude/settings.json` per project)
**before** older sessions age out:

```json
{ "cleanupPeriodDays": 365 }
```

Note this grows `~/.claude/projects` unbounded — it keeps every transcript for the
configured number of days.

## Durable history (optional)

Raising `cleanupPeriodDays` keeps transcripts longer but grows `~/.claude`
unbounded, and there's still a hard wall once they're deleted. As an alternative,
Ledger can **persist a compact rollup** of each settled session's per-day token
aggregates to a small JSON store *outside* `~/.claude`, then fold those aged-out
sessions back into every total and chart — so history survives transcript cleanup
without keeping the raw transcripts around.

It's **opt-in** (the app is read-only by default). Enable it either way:

```bash
LEDGER_PERSIST=1 node server.js                            # writes ~/.claude-ledger/rollups.json
CLAUDE_LEDGER_DATA=/path/to/rollups.json node server.js    # or choose the path
```

- **Tokens are stored, never dollars**, so `pricing.json` stays authoritative —
  editing rates reprices archived history too.
- Only **settled** sessions (last activity before today) are written, and only
  when their transcript changed — an in-progress session doesn't rewrite the store
  on every refresh. As a rough guide, ~300 sessions is ~0.5 MB.
- Archived sessions appear in every total, chart, and the projects leaderboard,
  but aren't clickable in the per-project session table (the transcript is gone, so
  there's no drill-down to open).
- The store lives outside `~/.claude`, so Claude Code's cleanup never touches it.
  Delete the file to start over; it's rebuilt from whatever transcripts remain.

## Metrics endpoint (Prometheus)

`GET /metrics` exposes all-time, all-projects gauges in Prometheus text format, so
you can scrape Ledger and graph spend/usage over time in Grafana — independent of
the transcript window:

```
claude_ledger_spend_usd 5588.43
claude_ledger_tokens 7002664958
claude_ledger_sessions 305
claude_ledger_project_spend_usd{project="maestro"} 3804.63
```

…plus prompts, tool calls, cache savings, tool error rate, recovery spend,
commits, and files edited. Read-only like the rest of the app.

## How it works

- `server.js` scans `~/.claude/projects/*`, parses each `.jsonl` transcript, and keeps
  per-day / per-hour / per-model token counts. Cost is priced at query time, so date
  filtering and `pricing.json` edits take effect without re-parsing. Parsed sessions are
  cached by file mtime + size, so only the first scan is slow.
- HTTP endpoints (all accept `?from=YYYY-MM-DD&to=YYYY-MM-DD`): `/api/projects`,
  `/api/overview`, `/api/project/:id`, `/api/session/:project/:id`, plus `/metrics`.
- `public/index.html` is the dashboard — vanilla JS, no build step.

## License

MIT
