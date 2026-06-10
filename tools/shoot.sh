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
  --virtual-time-budget=8000 --window-size=1600,9200 \
  --screenshot="$OUT" "http://127.0.0.1:$PORT/" 2>/dev/null

echo "Wrote $OUT"
node -e "const b=require('fs').readFileSync('$OUT');console.log('  '+b.readUInt32BE(16)+'x'+b.readUInt32BE(20),Math.round(b.length/1024)+'KB')"

# Also capture a deep-linked session drill-down — verifies the ?project=&session=
# URL routing and showcases the per-session view the overview can't show.
SESSION_OUT="$DIR/docs/session.png"
PID=$(curl -s "http://127.0.0.1:$PORT/api/projects" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const p=j.projects.find(x=>x.sessions>=3)||j.projects[0];process.stdout.write(p?p.id:"")})')
SID=$(curl -s "http://127.0.0.1:$PORT/api/project/$PID" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const ss=(j.sessions||[]).slice().sort((a,b)=>b.cost-a.cost)[0];process.stdout.write(ss?ss.id:"")})')
"$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars \
  --virtual-time-budget=8000 --window-size=1600,3200 \
  --screenshot="$SESSION_OUT" "http://127.0.0.1:$PORT/?project=$PID&session=$SID" 2>/dev/null
echo "Wrote $SESSION_OUT (project=$PID session=$SID)"
node -e "const b=require('fs').readFileSync('$SESSION_OUT');console.log('  '+b.readUInt32BE(16)+'x'+b.readUInt32BE(20),Math.round(b.length/1024)+'KB')"
