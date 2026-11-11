#!/usr/bin/env bash
# The live preview: the screen served from this checkout, the data from the
# Atelier already running.
#
# It is how a merge is seen without a rebuild — the installed service keeps the
# projects, the tasks and the chats, and this serves the code on top of them, so
# saving a file changes the screen and nothing has to be built, installed or
# restarted.
#
#   npm run dev:live                  # 127.0.0.1:3007, Atelier on 127.0.0.1:3008
#   ATELIER_URL=… npm run dev:live    # an Atelier somewhere else
#   PORT=3017 npm run dev:live        # a second preview, e.g. from a worktree
set -euo pipefail

BOARD="${ATELIER_URL:-http://127.0.0.1:3008}"
PORT="${PORT:-3007}"

if ! curl -sf -o /dev/null "$BOARD/api/projects"; then
  echo "Atelier is unavailable at $BOARD."
  echo "Start Atelier there, or set ATELIER_URL to a running instance."
  exit 1
fi

echo "Preview:  http://127.0.0.1:$PORT"
echo "Reading:  $BOARD"

# The browser is served by this dev server and talks to that Atelier directly, so
# it must allow it — the server sends Access-Control-Allow-Origin: *.
NEXT_PUBLIC_BACKEND_URL="$BOARD" exec npx next dev -p "$PORT"
