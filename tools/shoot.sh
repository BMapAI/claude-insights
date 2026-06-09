#!/usr/bin/env bash
# LOCAL, GIT-IGNORED screenshot tool — regenerates docs/overview.png from
# synthetic demo data (so the README screenshot never leaks real prompts/costs).
#
#   bash tools/shoot.sh
#
# Requires: node + a Chrome/Chromium binary on PATH.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="/tmp/claude-demo/projects"
PORT=4765
OUT="$DIR/docs/overview.png"

# Pick whatever Chrome is available.
CHROME="$(command -v google-chrome-stable || command -v google-chrome || command -v chromium-browser || command -v chromium || true)"
if [ -z "$CHROME" ]; then echo "No Chrome/Chromium found on PATH." >&2; exit 1; fi

node "$DIR/tools/gen-demo.js" "$DEMO"

# PRICING_FILE=/nonexistent → built-in default rates, so the sidebar shows a clean
# projects path with no "· pricing.json" badge. MONTHLY_BUDGET drives the budget bar;
# PLAN_MONTHLY_FEE drives the plan-value (API-equivalent leverage) panel.
CLAUDE_PROJECTS_DIR="$DEMO" PRICING_FILE=/nonexistent MONTHLY_BUDGET=400 PLAN_MONTHLY_FEE=100 PORT=$PORT \
  node "$DIR/server.js" >/tmp/ledger-shot-server.log 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT
# Wait for the server to accept connections (robust; avoids a fixed sleep).
curl -s --retry 40 --retry-connrefused --retry-delay 1 -o /dev/null "http://127.0.0.1:$PORT/api/projects"

"$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
  --virtual-time-budget=8000 --window-size=1600,4150 \
  --screenshot="$OUT" "http://127.0.0.1:$PORT/" 2>/dev/null

echo "Wrote $OUT"
node -e "const b=require('fs').readFileSync('$OUT');console.log('  '+b.readUInt32BE(16)+'x'+b.readUInt32BE(20),Math.round(b.length/1024)+'KB')"
