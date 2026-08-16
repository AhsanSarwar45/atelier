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
# The links test builds its own reporting tree; the real one is never written to.
export REPORTS_DIR="${REPORTS_DIR:-$ROOT/tests/.workbench-run-links/reporting}"

# A run starts from nothing: sessions left in the store by the last one are
# offered again by the restore list, and a test that resumes one of those is
# testing last week.
rm -rf "$XDG_DATA_HOME"
mkdir -p "$XDG_DATA_HOME" "$ROOT/tests/results"

SERVER_LOG="$RUN/server.log"
: > "$SERVER_LOG"

"$ROOT/server/target/debug/beads-server" >> "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
# By port, never by name: another beads-web serves the owner's board on this
# machine. A test may also have restarted the instance, so the pid we spawned
# is not necessarily the one still listening.
kill_port() {
  local pid
  pid=$(ss -lntpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
}
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  kill_port "$BEADS_WEB_PORT"
  kill_port "$BEADS_WORKBENCH_PORT"
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
