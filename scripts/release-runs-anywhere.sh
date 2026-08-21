#!/usr/bin/env bash
#
# The released program, alone on a computer that has never held this project.
#
# What this catches is a path baked in at build time. The binary used to start
# its chat helper from `/home/<whoever built it>/dev/…`, and the reports from a
# folder beside it, so every copy but the maintainer's came up with a dead Chat
# tab and no way to make a report (bw-8um.3, bw-8um.3.9). Nothing in a normal
# run notices, because on the machine it was built on those paths are all there.
#
# So the check takes the binary and NOTHING else: one file, copied into a fresh
# folder outside every checkout, started with a home directory that did not
# exist a second ago and an environment stripped of everything a build left
# behind. Then it asks the program the only questions that matter — does it
# serve, and is its chat helper running behind it.
#
#   bash scripts/release-runs-anywhere.sh
#
# ATELIER_BINARY  a release binary to check instead of building one
# KEEP            leave the fresh folder behind, to look at what was written
#
# The port is picked free rather than fixed at 3008. A check that asked 3008
# would be answered by whatever copy of the app the reader already has running
# there, and would pass without the binary under test ever starting.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO="$PWD"

failures=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; failures=$((failures + 1)); }
say()  { printf '\n%s\n' "$*"; }

# ---------------------------------------------------------------- the binary

say "A release binary"

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
  fail "no release binary at $BINARY"
  echo; echo "$failures failure(s)"; exit 1
fi
pass "built: $(basename "$BINARY"), $(du -h "$BINARY" | cut -f1)"

# The maintainer's own checkout, written into the binary, is the exact fault
# this whole check exists for — and it can be seen without running anything.
if grep -aqF "$REPO" "$BINARY"; then
  fail "the binary names this checkout: $(grep -aoF "$REPO" "$BINARY" | head -1)"
else
  pass "the binary names no path inside this checkout"
fi

# ------------------------------------------------------- a computer with none

say "A computer that has never held this project"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/atelier-anywhere.XXXXXX")" || exit 1
HOME_DIR="$WORK/home"
mkdir -p "$HOME_DIR"
cp "$BINARY" "$WORK/atelier"
chmod +x "$WORK/atelier"
pass "one file copied to $WORK, with a home directory made a second ago"

# Two free ports: one the app serves on, one its chat helper listens on. Both
# are picked rather than fixed for the same reason — the reader's own copy of
# the app sits on 3008 with its helper on 3009, and a fixed pair would let this
# whole check be answered by that copy without the binary under test ever
# starting.
read -r PORT HELPER_PORT <<<"$(python3 - <<'PY'
import socket
held = [socket.socket() for _ in range(2)]
for sock in held:
    sock.bind(("127.0.0.1", 0))
print(*(sock.getsockname()[1] for sock in held))
for sock in held:
    sock.close()
PY
)"
if [ -z "${PORT:-}" ] || [ -z "${HELPER_PORT:-}" ]; then
  fail "could not find free ports to serve on"
  echo; echo "$failures failure(s)"; exit 1
fi

SERVER=""
cleanup() {
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null
  [ -n "$SERVER" ] && wait "$SERVER" 2>/dev/null
  if [ -n "${KEEP:-}" ]; then
    echo "left behind: $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# `env -i` is the point of the whole check: CARGO_MANIFEST_DIR, every BEADS_*
# and ATELIER_* switch, and whatever else a build or a session left in the
# environment are all gone. PATH stays because node and Claude Code are the
# reader's own programs, not this project's.
LOG="$WORK/said.txt"
env -i \
  PATH="$PATH" \
  HOME="$HOME_DIR" \
  ATELIER_HOST=127.0.0.1 \
  ATELIER_PORT="$PORT" \
  BEADS_WORKBENCH_PORT="$HELPER_PORT" \
  "$WORK/atelier" >"$LOG" 2>&1 &
SERVER=$!

# ------------------------------------------------------------- does it answer

say "Does it answer"

serving=0
for _ in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health")" = "200" ]; then
    serving=1
    break
  fi
  kill -0 "$SERVER" 2>/dev/null || break
  sleep 1
done

if [ "$serving" = "1" ]; then
  pass "it serves on port $PORT"
else
  fail "it never served on port $PORT; it said:"
  sed 's/^/      /' "$LOG"
  echo; echo "$failures failure(s)"; exit 1
fi

code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
if [ "$code" = "200" ]; then
  pass "the screens are inside it too (/ answers $code)"
else
  fail "the screens are not served (/ answers $code)"
fi

# ------------------------------------------------------------ and its helper

say "Is the chat helper behind it"

# The first run fetches the one kit the helper needs, which costs the network
# once. Three minutes is for that; every run after it is immediate.
answered=0
for _ in $(seq 1 180); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/workbench/health")
  if [ "$code" = "200" ]; then
    answered=1
    break
  fi
  kill -0 "$SERVER" 2>/dev/null || break
  sleep 1
done

if [ "$answered" = "1" ]; then
  pass "the chat helper answers (/api/workbench/health returns 200)"
else
  fail "the chat helper never answered; the program said:"
  sed 's/^/      /' "$LOG"
fi

# What it wrote, and where — under the home directory made for this run and
# nowhere near this checkout.
LAID="$HOME_DIR/.local/share/atelier/helper/workbench/src/server.ts"
if [ -f "$LAID" ]; then
  pass "it wrote its helper out for itself, under the home it was given"
else
  fail "no helper was written to $LAID"
fi

KIT="$HOME_DIR/.local/share/atelier/helper/workbench/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"
if [ -f "$KIT" ]; then
  pass "it fetched the one kit it does not carry, into the home it was given"
else
  fail "the kit was never fetched to $KIT"
fi

TOOLS="$HOME_DIR/.local/share/atelier/tools/build.py"
if [ -f "$TOOLS" ]; then
  pass "it wrote the report tools out too"
else
  fail "no report tools were written to $TOOLS"
fi

say "$failures failure(s)"
[ "$failures" = "0" ]
