# Claude Insights

A zero-dependency cost / ROI analyzer for [Claude Code](https://claude.com/claude-code) projects.

It reads the session transcripts under `~/.claude/projects`, attributes token usage
to per-model pricing, and serves a small web dashboard where you can pick a project
(or view all at once) and see what it actually cost.

## Features

- **Per-project overview** — total cost, sessions, prompts, cost/prompt, tool calls,
  token usage, cache savings, spend-by-model split, daily-spend chart, top tools, and a
  per-session table.
- **All-projects rollup** — combined totals plus a projects-by-spend leaderboard
  (click a row to drill in).
- **Accurate cost model** — uses the per-message `cache_creation` 5m/1h breakdown when
  present, so cache-write costs are exact rather than estimated.
- **Read-only** — never writes to `~/.claude`; only reads the transcripts.
- **No dependencies** — Node standard library only.

## Run

```bash
node server.js
# → http://127.0.0.1:4317
```

Configuration via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Localhost-only by default; set `0.0.0.0` for LAN access (no auth — see below). |
| `PORT` | auto (`4317`, bumps if busy) | HTTP port. If unset, an in-use port auto-increments so multiple users on one host don't collide. Set it to pin a fixed port. |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Where to scan for transcripts |

## Team / shared-server use

Each person's Claude transcripts are private at the OS level (`~/.claude/**` is
owner-only). So the tool runs **per person, each sees only their own usage** — a
single instance can't read a teammate's data.

Recommended setup on a shared box:

1. **Check out the code once** anywhere readable (e.g. `/var/www/claude-insights`)
   — the app writes nothing to its own folder, so it can be shared read-only and
   updated with a single `git pull`.
2. **Each teammate runs their own instance** — it reads *their* `~/.claude`:
   ```bash
   node /var/www/claude-insights/server.js
   ```
   It binds to localhost and auto-picks a free port, so simultaneous users don't
   collide and nobody's prompts/costs are exposed to the rest of the machine.
3. **View it over an SSH tunnel** from your laptop (the start-up log prints the
   exact command):
   ```bash
   ssh -L 4317:localhost:4317 <you>@<this-host>
   # then open http://localhost:4317
   ```

**Prerequisite:** each user needs **Node 18+** on their `PATH` (a per-user nvm
install or a system-wide Node).

> Setting `HOST=0.0.0.0` exposes the dashboard — including your prompt text and
> spend — to anyone who can reach the host on that port. There is no built-in
> auth, so only do this behind a trusted network / restrictive security group.

## Pricing model

USD per 1M tokens. Cache reads bill at ~0.1× the input rate; cache writes at
1.25× (5-minute TTL) or 2× (1-hour TTL).

| Model | Input | Output |
|---|---|---|
| Opus | $5 | $25 |
| Sonnet | $3 | $15 |
| Haiku | $1 | $5 |

## How it works

- `server.js` — scans `~/.claude/projects/*`, parses each `.jsonl` session transcript,
  and aggregates token usage into cost. Parsed sessions are cached by file mtime + size,
  so only the first scan is slow. Three endpoints: `/api/projects`, `/api/overview`,
  and `/api/project/:id`.
- `public/index.html` — the dashboard (vanilla JS, no build step).

## License

MIT
