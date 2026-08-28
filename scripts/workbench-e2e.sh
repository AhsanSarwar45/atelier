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
export ATELIER_PORT="$BEADS_WEB_PORT"
export ATELIER_DATA_DIR="$RUN/data"
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
export BEADS_E2E_REAL_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export CLAUDE_CONFIG_DIR="$RUN/claude"
export CODEX_HOME="$RUN/codex"
export BEADS_E2E_MARKERS="$CLAUDE_CONFIG_DIR/sessions"

# A run starts from nothing: sessions left in the store by the last one are
# offered again by the restore list, and a test that resumes one of those is
# testing last week. The scratch records go the same way, or the chats one run
# leaves behind are rows the next run counts.
rm -rf "$XDG_DATA_HOME" "$ATELIER_DATA_DIR" "$RUN/claude" "$RUN/codex"
mkdir -p "$XDG_DATA_HOME" "$ROOT/tests/results" "$BEADS_E2E_MARKERS" "$CLAUDE_CONFIG_DIR/projects" "$CODEX_HOME"

SERVER_LOG="$RUN/server.log"
: > "$SERVER_LOG"

# By port, never by name: another Atelier serves the owner's board on this
# machine. A run that leaves a helper behind, or a hand-started instance, keeps
# its port — and the server we are about to start cannot bind it, so the browser
# is served by yesterday's code while every log here says the run is fresh.
# An occupied port belongs to someone else. Fail rather than trying to make it
# ours; this harness has authority only over the process tree it starts below.
for p in "$BEADS_WEB_PORT" "$BEADS_WORKBENCH_PORT"; do
  if ss -lntH "sport = :$p" 2>/dev/null | grep -q .; then
    echo "port $p is occupied; choose a different isolated E2E port"; exit 1
  fi
done

# Real-provider cases opt in explicitly. They receive copies of only the two
# bearer credential files, never the owner's settings, transcripts, sockets,
# or writable config homes. Refreshes made by a test therefore cannot modify
# the credentials the owner is using. Copy only after the non-owned port check,
# so an early refusal cannot leave credentials behind.
if [ "${BEADS_E2E_LIVE_PROVIDERS:-0}" = 1 ]; then
  claude_auth="$BEADS_E2E_REAL_CONFIG/.credentials.json"
  codex_auth="$BEADS_E2E_REAL_CODEX_HOME/auth.json"
  [ -f "$claude_auth" ] || { echo "live provider E2E needs $claude_auth"; exit 1; }
  [ -f "$codex_auth" ] || { echo "live provider E2E needs $codex_auth"; exit 1; }
  install -m 600 "$claude_auth" "$CLAUDE_CONFIG_DIR/.credentials.json"
  install -m 600 "$codex_auth" "$CODEX_HOME/auth.json"
fi

"$ROOT/server/target/debug/atelier" >> "$SERVER_LOG" 2>&1 &
SERVER_PID=$!
# Print descendants leaves-first so providers stop before the sidecar and the
# sidecar before the app. Every PID comes from the server we started above.
descendants_of() {
  local parent="$1" child
  while read -r child; do
    [ -n "$child" ] || continue
    descendants_of "$child"
    printf '%s\n' "$child"
  done < <(pgrep -P "$parent" 2>/dev/null || true)
}

cleanup() {
  local code=$? pid p held=0
  local owned=()
  trap - EXIT
  mapfile -t owned < <(descendants_of "$SERVER_PID")
  owned+=("$SERVER_PID")
  # A restart test replaces the original server. Those replacements cannot be
  # descendants of a process they deliberately stopped, so the restart helper
  # records each exact PID for this disposable run. Take each replacement's
  # own children first, then the recorded server — never a name-matched process
  # and never anything outside this run directory.
  if [ -f "$RUN/restart-pids" ]; then
    while read -r pid; do
      [ -n "$pid" ] || continue
      mapfile -t restarted < <(descendants_of "$pid")
      owned+=("${restarted[@]}" "$pid")
    done < "$RUN/restart-pids"
  fi
  for pid in "${owned[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait "$SERVER_PID" 2>/dev/null || true
  rm -f "$CLAUDE_CONFIG_DIR/.credentials.json" "$CODEX_HOME/auth.json"
  for _ in $(seq 1 20); do
    held=0
    for p in "$BEADS_WEB_PORT" "$BEADS_WORKBENCH_PORT"; do
      ss -lntH "sport = :$p" 2>/dev/null | grep -q . && held=1
    done
    [ "$held" -eq 0 ] && break
    sleep 0.1
  done
  for p in "$BEADS_WEB_PORT" "$BEADS_WORKBENCH_PORT"; do
    if ss -lntH "sport = :$p" 2>/dev/null | grep -q .; then
      echo "isolated E2E port $p is still occupied after owned-process cleanup"
      held=1
    fi
  done
  [ "$held" -eq 0 ] || code=1
  exit "$code"
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
