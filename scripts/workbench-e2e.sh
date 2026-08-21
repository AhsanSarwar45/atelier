#!/usr/bin/env bash
# Runs the workbench end-to-end test against an instance built from THIS
# worktree, isolated from any other Atelier running on this machine:
# its own ports and its own XDG_DATA_HOME, so it shares neither settings.db
# nor workbench.db with them.
#
# Usage: scripts/workbench-e2e.sh [<spec> ...] [-g <grep>]
#
# With no spec named it runs the workbench case. Any argument that is a path to
# a test file is taken as the spec to run instead — the stack is the same one
# whatever is being proved on it, and a case that needs an instance built from
# THIS worktree has no other way in.
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

# Where the stack looks for chats begun in a terminal: a scratch directory of
# this run's own, never the tool's. The cases that need a chat somebody else is
# working in write a record and a marker there themselves, and the tool's own
# directory is where the manager's REAL chats live — a run that wrote into it
# would be handing markers to the agent he is talking to, and the `.key` files
# beside them are the credentials of his own messaging socket.
#
# Set outright, never defaulted. The app reads CLAUDE_CONFIG_DIR when it is set
# and only falls back to ~/.claude, so on a machine that has moved its config
# a `${CLAUDE_CONFIG_DIR:-…}` here would inherit the REAL directory and hand
# the whole run to it — the one outcome the paragraph above exists to prevent.
# Where the real one is is remembered first, so the fixture can refuse it by
# name wherever it has been moved to (bw-jaoz.11).
export BEADS_E2E_REAL_CONFIG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
export CLAUDE_CONFIG_DIR="$RUN/claude"
export BEADS_E2E_MARKERS="$CLAUDE_CONFIG_DIR/sessions"

# A run starts from nothing: sessions left in the store by the last one are
# offered again by the restore list, and a test that resumes one of those is
# testing last week. The scratch records go the same way, or the chats one run
# leaves behind are rows the next run counts.
rm -rf "$XDG_DATA_HOME" "$RUN/claude"
mkdir -p "$XDG_DATA_HOME" "$ROOT/tests/results" "$BEADS_E2E_MARKERS" "$CLAUDE_CONFIG_DIR/projects"

SERVER_LOG="$RUN/server.log"
: > "$SERVER_LOG"

# By port, never by name: another Atelier serves the owner's board on this
# machine. A run that leaves a helper behind, or a hand-started instance, keeps
# its port — and the server we are about to start cannot bind it, so the browser
# is served by yesterday's code while every log here says the run is fresh.
free_port() {
  local pid
  # `|| true` on the assignment: nothing listening means grep exits non-zero,
  # and this script runs under `set -e`.
  pid=$(ss -lntpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2) || true
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && sleep 0.5 || true
}
free_port "$BEADS_WEB_PORT"
free_port "$BEADS_WORKBENCH_PORT"
for p in "$BEADS_WEB_PORT" "$BEADS_WORKBENCH_PORT"; do
  if ss -lntH "sport = :$p" 2>/dev/null | grep -q .; then
    echo "port $p is still held by something this run cannot stop"; exit 1
  fi
done

"$ROOT/server/target/debug/atelier" >> "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
# By port, never by name: another Atelier serves the owner's board on this
# machine. A test may also have restarted the instance, so the pid we spawned
# is not necessarily the one still listening.
cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  free_port "$BEADS_WEB_PORT"
  free_port "$BEADS_WORKBENCH_PORT"
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
# A named spec wins; naming none runs the workbench case.
specs=()
rest=()
for arg in "$@"; do
  if [ -f "$arg" ]; then specs+=("$arg"); else rest+=("$arg"); fi
done
[ ${#specs[@]} -eq 0 ] && specs=(tests/e2e/workbench.spec.ts)
ran=0
npx playwright test "${specs[@]}" ${rest[@]+"${rest[@]}"} || ran=$?

# A case that stands up a project of its own takes it away again. One left
# behind is a row on the reader's own project list for ever, and the cases that
# borrow "whatever is listed" would then be borrowing it (bw-jaoz.8).
listed=$(curl -sf "$BEADS_E2E_URL/api/projects?include_test=true" || true)
# The braces keep grep's "found nothing" — the good answer here — from ending
# the run under `set -e -o pipefail`.
left=$(printf '%s' "$listed" | { grep -o '"local_path":"[^"]*\.held-run[^"]*"' || true; } | wc -l)
if [ "${left:-0}" -ne 0 ]; then
  echo "the run left $left project(s) of its own on the list"
  exit 1
fi
exit "$ran"
