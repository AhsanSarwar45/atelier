#!/usr/bin/env bash
# A disposable instance for measuring what the app does to its own store.
#
# Unlike scripts/files-perf-stack.sh this one does NOT wipe the data directory:
# the point is to start against a copy of an owner-sized workbench.db and watch
# what the idle app reads. Put the copy at $RUN/data/workbench.db first.
#
#   BEADS_WEB_PORT=3313 ATELIER_BINARY=server/target-sym/release/atelier \
#     WORKBENCH_E2E_RUN=$PWD/tests/.perf-run-bw-y18u scripts/store-perf-stack.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="${WORKBENCH_E2E_RUN:-$ROOT/tests/.perf-run}"

export BEADS_WEB_HOST="${BEADS_WEB_HOST:-127.0.0.1}"
export BEADS_WEB_PORT="${BEADS_WEB_PORT:?name a free port}"
export ATELIER_PORT="$BEADS_WEB_PORT"
export XDG_DATA_HOME="$RUN/xdg"
export ATELIER_DATA_DIR="$RUN/data"
export ATELIER_PRESENTATION_MEDIA_DIR="$RUN/presentation-media"
export CLAUDE_CONFIG_DIR="$RUN/claude"
export CODEX_HOME="$RUN/codex"
export HISTFILE="$RUN/bash_history"

if ss -lntH "sport = :$BEADS_WEB_PORT" 2>/dev/null | grep -q .; then
  echo "port $BEADS_WEB_PORT is occupied; choose another"; exit 1
fi

mkdir -p "$XDG_DATA_HOME" "$ATELIER_DATA_DIR" "$CLAUDE_CONFIG_DIR/projects" "$CODEX_HOME"
: > "$HISTFILE"

BIN="${ATELIER_BINARY:-$ROOT/server/target/release/atelier}"
[ -x "$BIN" ] || { echo "no binary at $BIN"; exit 1; }

"$BIN" >> "$RUN/server.log" 2>&1 &
echo $! > "$RUN/server.pid"
for _ in $(seq 1 240); do
  if grep -q 'Atelier is listening' "$RUN/server.log" 2>/dev/null; then
    echo "up at http://$BEADS_WEB_HOST:$BEADS_WEB_PORT (pid $(cat "$RUN/server.pid"))"
    exit 0
  fi
  sleep 0.5
done
echo "server did not come up"; tail -20 "$RUN/server.log"; exit 1
