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
# → http://localhost:4317
```

Configuration via environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4317` | HTTP port |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Where to scan for transcripts |

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
