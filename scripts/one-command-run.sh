#!/usr/bin/env bash
#
# One typed command, and the whole product is up.
#
# What this catches is the shape the product used to have: a server started as
# one thing and a frontend started as another, with the reader expected to run
# both and then work out which port to open. Everything needed to end that was
# already true — the screens are embedded in the binary and the chat helper is
# a child of the same process — but there was no command that said so, no way
# to ask the program what it could do, and no browser pointed anywhere
# (bw-8um.3.12).
#
# So the check takes the binary and NOTHING else, in a fresh folder outside
# every checkout with a home directory made a second ago, types the one
# command, and asks: does the board come up, is the chat behind it, is there
# any second process the reader would have had to start, and did the browser
# get pointed at the port it is really serving on.
#
#   bash scripts/one-command-run.sh
#
# ATELIER_BINARY  a release binary to check instead of building one
# KEEP            leave the fresh folder behind, to look at what was written
#
# The ports are picked free rather than fixed at 3008. A check that asked 3008
# would be answered by whatever copy of the app the reader already has running
# there, and would pass without the binary under test ever starting. That the
# reader is told 3008 when they set nothing is checked separately, off the help
# screen, where it is a sentence rather than a running server.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO="$PWD"

failures=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; failures=$((failures + 1)); }
say()  { printf '\n%s\n' "$*"; }

free_ports() {
  python3 - "$1" <<'PY'
import socket
import sys
held = [socket.socket() for _ in range(int(sys.argv[1]))]
for sock in held:
    sock.bind(("127.0.0.1", 0))
print(*(sock.getsockname()[1] for sock in held))
for sock in held:
    sock.close()
PY
}

# Every process started under one, however deep. What the reader would have
# had to start by hand shows up here or nowhere.
descendants() {
  local parent=$1 kid
  for kid in $(pgrep -P "$parent" 2>/dev/null); do
    echo "$kid"
    descendants "$kid"
  done
}

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

# ------------------------------------------------------- what it says it does

say "What it can be asked to do"

HELP="$("$BINARY" --help 2>&1)"
if printf '%s' "$HELP" | grep -q 'atelier run'; then
  pass "'--help' offers 'run' among its commands"
else
  fail "'--help' does not offer 'run':"
  printf '%s\n' "$HELP" | sed 's/^/      /'
fi

if printf '%s' "$HELP" | grep -q 'nothing else to start'; then
  pass "it says there is no second thing for the reader to start"
else
  fail "'--help' never says the frontend needs no separate process"
fi

# The port a reader who configures nothing is told to open. It is a sentence
# here and a bind() in the program, and the two must be the same number.
if printf '%s' "$HELP" | grep -q 'default 3008'; then
  pass "it names 3008 as the port to open when nothing is set"
else
  fail "'--help' does not name the default port"
fi

if "$BINARY" srve >/dev/null 2>&1; then
  fail "a word it has no meaning for started the server anyway"
else
  pass "a word it has no meaning for is refused rather than quietly ignored"
fi

# ------------------------------------------------------- a computer with none

say "A computer that has never held this project"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/atelier-one-command.XXXXXX")" || exit 1
HOME_DIR="$WORK/home"
mkdir -p "$HOME_DIR"
cp "$BINARY" "$WORK/atelier"
chmod +x "$WORK/atelier"
pass "one file copied to $WORK, with a home directory made a second ago"

read -r PORT HELPER_PORT SECOND_PORT SECOND_HELPER_PORT <<<"$(free_ports 4)"
if [ -z "${SECOND_HELPER_PORT:-}" ]; then
  fail "could not find free ports to serve on"
  echo; echo "$failures failure(s)"; exit 1
fi

SERVER=""
cleanup() {
  if [ -n "$SERVER" ]; then
    kill "$SERVER" 2>/dev/null
    wait "$SERVER" 2>/dev/null
  fi
  if [ -n "${KEEP:-}" ]; then
    echo "left behind: $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# `env -i` is the point of the whole check: every ATELIER_* and BEADS_* switch
# and whatever else a build or a session left in the environment are gone. PATH
# stays because node and Claude Code are the reader's own programs.
LOG="$WORK/said.txt"
say "The one command"
echo "  atelier run --no-browser"
env -i \
  PATH="$PATH" \
  HOME="$HOME_DIR" \
  ATELIER_HOST=127.0.0.1 \
  ATELIER_PORT="$PORT" \
  BEADS_WORKBENCH_PORT="$HELPER_PORT" \
  "$WORK/atelier" run --no-browser >"$LOG" 2>&1 &
SERVER=$!

# ------------------------------------------------------------- does it answer

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

FRONT="$WORK/front.html"
code=$(curl -s -o "$FRONT" -w '%{http_code}' "http://127.0.0.1:$PORT/")
if [ "$code" = "200" ]; then
  pass "the board screen answers on the same port (/ returns $code)"
else
  fail "the board screen is not served (/ returns $code)"
fi

# A page is not the app. The built screen loads its own code, and that code has
# to come out of this binary too — which is the half a separately-started
# frontend used to serve.
BUNDLE="$(grep -o '/_next/static/chunks/[A-Za-z0-9._-]*\.js' "$FRONT" | head -1)"
if [ -n "$BUNDLE" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$BUNDLE")" = "200" ]; then
  pass "the screen's own code is served out of the binary as well ($BUNDLE)"
else
  fail "the front page names no code of its own, or the binary does not serve it"
fi

# ------------------------------------------------------------ and its helper

# The first run fetches the one kit the helper needs, which costs the network
# once. Three minutes is for that; every run after it is immediate.
answered=0
for _ in $(seq 1 180); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/workbench/health")" = "200" ]; then
    answered=1
    break
  fi
  kill -0 "$SERVER" 2>/dev/null || break
  sleep 1
done

if [ "$answered" = "1" ]; then
  pass "the chat is behind it, from the same command (/api/workbench/health returns 200)"
else
  fail "the chat never answered; the program said:"
  sed 's/^/      /' "$LOG"
fi

# ------------------------------------------- nothing the reader had to start

say "What else is running"

KIDS="$(descendants "$SERVER")"
COUNT=$(printf '%s' "$KIDS" | grep -c . )
LISTED="$(for pid in $KIDS; do ps -o args= -p "$pid" 2>/dev/null; done)"

if [ "$COUNT" = "1" ]; then
  pass "one process was started under it, and one only"
else
  fail "$COUNT processes are running under it:"
  printf '%s\n' "$LISTED" | sed 's/^/      /'
fi

if printf '%s' "$LISTED" | grep -q 'helper/workbench/src/server.ts'; then
  pass "and that one is the chat helper, started for the reader"
else
  fail "the one process under it is not the chat helper:"
  printf '%s\n' "$LISTED" | sed 's/^/      /'
fi

# The old shape: a frontend served by its own program, on its own port, started
# by hand. Any of these running means the single command did not cover it.
if printf '%s' "$LISTED" | grep -Eq 'next|vite|webpack|http-server|serve -|npm run'; then
  fail "a separate frontend process is running:"
  printf '%s\n' "$LISTED" | grep -E 'next|vite|webpack|http-server|serve -|npm run' | sed 's/^/      /'
else
  pass "no second process for the frontend — the screens come out of the binary"
fi

kill "$SERVER" 2>/dev/null
wait "$SERVER" 2>/dev/null
SERVER=""

# ------------------------------------------------ and it opens the right port

say "And it opens the board"

# A browser cannot be opened in a check, so the check stands in as one: the
# program looks for a browser on PATH, and the first thing it finds here writes
# down what it was asked to open instead of opening it. What matters is the
# address — the reader must land on the port this run is really serving.
SHIM="$WORK/browser"
OPENED="$WORK/opened.txt"
mkdir -p "$SHIM"
for launcher in xdg-open gio gnome-open kde-open wslview; do
  cat > "$SHIM/$launcher" <<SHIMMED
#!/usr/bin/env bash
printf '%s\n' "\$@" >> "$OPENED"
SHIMMED
  chmod +x "$SHIM/$launcher"
done

env -i \
  PATH="$SHIM:$PATH" \
  HOME="$HOME_DIR" \
  ATELIER_HOST=127.0.0.1 \
  ATELIER_PORT="$SECOND_PORT" \
  BEADS_WORKBENCH_PORT="$SECOND_HELPER_PORT" \
  "$WORK/atelier" run >"$WORK/said-again.txt" 2>&1 &
SERVER=$!

for _ in $(seq 1 60); do
  [ -s "$OPENED" ] && break
  kill -0 "$SERVER" 2>/dev/null || break
  sleep 1
done

if grep -q "localhost:$SECOND_PORT" "$OPENED" 2>/dev/null; then
  pass "it opened the board at the port it is serving ($(head -1 "$OPENED"))"
else
  fail "it opened nothing, or not the port it is serving on ($SECOND_PORT):"
  sed 's/^/      /' "$OPENED" 2>/dev/null
  sed 's/^/      /' "$WORK/said-again.txt"
fi

say "$failures failure(s)"
[ "$failures" = "0" ]
