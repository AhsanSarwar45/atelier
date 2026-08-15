#!/usr/bin/env bash
# Runs the workbench end-to-end test against an instance built from THIS
# worktree, isolated from any other beads-web running on this machine:
# its own ports and its own XDG_DATA_HOME, so it shares neither settings.db
# nor workbench.db with them.
#
# Usage: scripts/workbench-e2e.sh [-g <grep>]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="${WORKBENCH_E2E_RUN:-$ROOT/tests/.e2e-run}"

export BEADS_WEB_HOST="${BEADS_WEB_HOST:-127.0.0.1}"
export BEADS_WEB_PORT="${BEADS_WEB_PORT:-3018}"
export BEADS_WORKBENCH_PORT="${BEADS_WORKBENCH_PORT:-3019}"
export XDG_DATA_HOME="$RUN/xdg"
export BEADS_E2E_URL="http://$BEADS_WEB_HOST:$BEADS_WEB_PORT"

mkdir -p "$XDG_DATA_HOME" "$ROOT/tests/results"

SERVER_LOG="$RUN/server.log"
: > "$SERVER_LOG"

"$ROOT/server/target/debug/beads-server" >> "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  # The sidecar is a child of the server; kill_on_drop only fires on a clean
  # exit, so sweep the port explicitly.
  pkill -f "workbench/src/server.ts" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  curl -sf "$BEADS_E2E_URL/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "$BEADS_E2E_URL/api/health" >/dev/null || { echo "server did not come up"; tail -30 "$SERVER_LOG"; exit 1; }

for _ in $(seq 1 60); do
  curl -sf "$BEADS_E2E_URL/api/workbench/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "$BEADS_E2E_URL/api/workbench/health" || { echo "sidecar did not come up"; tail -30 "$SERVER_LOG"; exit 1; }
echo

cd "$ROOT"
npx playwright test tests/e2e/workbench.spec.ts "$@"
