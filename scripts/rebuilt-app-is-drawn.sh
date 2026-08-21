#!/usr/bin/env bash
#
# A rebuilt app is what the browser draws.
#
# Every answer the server gave used to say nothing about how long it stayed
# good, so browsers applied a guess of their own and kept pages for as long as
# they liked. After the binary was rebuilt with the report screen in it, a
# report link opened the board tab: the tab did not exist in the code the
# browser still held. A hard reload fixed it, which nobody should have to know
# (bw-8um.3.11).
#
# The unit tests hold the rule. This holds the running server to it, over a
# real socket, on all four of the routes it answers on — because the fault was
# never in the rule, it was in there being no rule at any of the four places a
# response is built.
#
#   bash scripts/rebuilt-app-is-drawn.sh
#
# ATELIER_BINARY  a binary to check instead of building one
#
# The port is picked free rather than fixed at 3008: a check that asked 3008
# would be answered by whatever copy the reader already has running there, and
# would pass without the binary under test ever starting.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO="$PWD"

failures=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; failures=$((failures + 1)); }
say()  { printf '\n%s\n' "$*"; }

free_port() {
  python3 - <<'PY'
import socket
held = socket.socket()
held.bind(("127.0.0.1", 0))
print(held.getsockname()[1])
held.close()
PY
}

# ---------------------------------------------------------------- the binary

say "A binary to ask"

BINARY="${ATELIER_BINARY:-}"
if [ -z "$BINARY" ]; then
  if [ ! -d "$REPO/out" ]; then
    fail "there is no built frontend at out/ — run 'npm run build' first"
    echo; echo "$failures failure(s)"; exit 1
  fi
  echo "  building (this takes a few minutes the first time)…"
  if ! (cd "$REPO/server" && cargo build --release >/dev/null 2>&1); then
    fail "the release build did not finish; run 'cd server && cargo build --release' to see why"
    echo; echo "$failures failure(s)"; exit 1
  fi
  BINARY="$REPO/server/target/release/atelier"
fi
if [ ! -x "$BINARY" ]; then
  fail "no binary at $BINARY"
  echo; echo "$failures failure(s)"; exit 1
fi
pass "built: $(basename "$BINARY")"

# ------------------------------------------------------------- a server of it

WORK="$(mktemp -d "${TMPDIR:-/tmp}/atelier-stale-copy.XXXXXX")" || exit 1
PORT="$(free_port)"
HELPER_PORT="$(free_port)"
SERVER=""
cleanup() {
  [ -n "$SERVER" ] && { kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null; }
  rm -rf "$WORK"
}
trap cleanup EXIT

# Its own data folder and its own home: this must not touch the reader's
# projects, their settings or their reports.
env -i PATH="$PATH" \
  HOME="$WORK/home" \
  ATELIER_HOST=127.0.0.1 \
  ATELIER_PORT="$PORT" \
  ATELIER_DATA_DIR="$WORK/data" \
  BEADS_WORKBENCH_PORT="$HELPER_PORT" \
  "$BINARY" run --no-browser >"$WORK/said.txt" 2>&1 &
SERVER=$!

for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null && break
  kill -0 "$SERVER" 2>/dev/null || break
  sleep 1
done
if ! curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
  fail "the server never came up on $PORT:"
  sed 's/^/      /' "$WORK/said.txt"
  echo; echo "$failures failure(s)"; exit 1
fi
pass "serving on 127.0.0.1:$PORT"

headers_of() { curl -sS -D - -o /dev/null "$@" 2>/dev/null | tr -d '\r'; }
value_of() { printf '%s\n' "$1" | grep -i "^$2:" | head -1 | cut -d' ' -f2-; }
status_of() { printf '%s\n' "$1" | head -1 | awk '{print $2}'; }

# --------------------------------------------------- every page is asked about

say "Every screen is checked with the server on each visit"

# The four ways a response is built: the file itself, the name with .html put
# back on, a folder's index, and the fallback for an address the browser
# invented. The fault was that the rule was in none of them.
for route in "/" "/index.html" "/project" "/settings" "/a-path-only-the-browser-knows"; do
  head="$(headers_of "http://127.0.0.1:$PORT$route")"
  kept="$(value_of "$head" "cache-control")"
  tag="$(value_of "$head" "etag")"
  if [ -z "$kept" ]; then
    fail "$route says nothing about how long it stays good — a browser will keep it as long as it likes"
  elif [ "$kept" != "no-cache, must-revalidate" ]; then
    fail "$route is kept without asking: $kept"
  elif [ -z "$tag" ]; then
    fail "$route has no tag, so asking whether it is still good costs the whole page"
  else
    pass "$route: $kept, tag $tag"
  fi
done

# ------------------------------------------------------------ the fault itself

say "A browser holding the previous build"

HOME_HEAD="$(headers_of "http://127.0.0.1:$PORT/")"
CURRENT_TAG="$(value_of "$HOME_HEAD" "etag")"

# What a rebuilt app looks like from the browser's side: it offers the copy it
# has, and the copy it has is not this one. Before the fix it never asked at
# all, and went on drawing the screen it kept.
STALE='"0000000000000000000000000000"'
stale="$(headers_of -H "If-None-Match: $STALE" "http://127.0.0.1:$PORT/")"
if [ "$(status_of "$stale")" = "200" ]; then
  pass "a browser holding an older copy is sent the new one (200)"
else
  fail "a browser holding an older copy was told to keep it ($(status_of "$stale")) — this is the fault"
fi

body="$(curl -sS -H "If-None-Match: $STALE" "http://127.0.0.1:$PORT/" 2>/dev/null | head -c 200)"
if printf '%s' "$body" | grep -qi '<!doctype html'; then
  pass "and what came back is the page, not an empty answer"
else
  fail "the answer to an older copy was not a page:"
  printf '%s\n' "$body" | sed 's/^/      /'
fi

# The other half: asking must be cheap, or every visit pays for the whole page.
current="$(headers_of -H "If-None-Match: $CURRENT_TAG" "http://127.0.0.1:$PORT/")"
if [ "$(status_of "$current")" = "304" ]; then
  pass "a browser holding this build is told to keep it (304, no page sent)"
else
  fail "a browser holding the current page was sent it again ($(status_of "$current")) — asking costs a full page every visit"
fi

# ------------------------------------------------- what never needs asking about

say "Files named after the build that made them"

ASSET="$(curl -sS "http://127.0.0.1:$PORT/" 2>/dev/null \
  | grep -o '/_next/static/[^"]*\.js' | head -1)"
if [ -z "$ASSET" ]; then
  fail "the page names no built script, so there is nothing to check this on"
else
  head="$(headers_of "http://127.0.0.1:$PORT$ASSET")"
  kept="$(value_of "$head" "cache-control")"
  if [ "$kept" = "public, max-age=31536000, immutable" ]; then
    pass "$(basename "$ASSET"): $kept"
  else
    fail "$(basename "$ASSET") is asked about on every visit ($kept) — its name already carries its contents"
  fi
fi

# An address that is a file and not a page: same name every build, so it is
# checked like a page rather than kept for a year.
head="$(headers_of "http://127.0.0.1:$PORT/favicon.svg")"
kept="$(value_of "$head" "cache-control")"
if [ "$(status_of "$head")" = "404" ]; then
  pass "there is no favicon.svg to check"
elif [ "$kept" = "no-cache, must-revalidate" ]; then
  pass "favicon.svg: $kept"
else
  fail "favicon.svg keeps its name across builds but is kept blind: $kept"
fi

say "$failures failure(s)"
[ "$failures" = "0" ]
