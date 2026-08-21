#!/usr/bin/env bash
#
# The board opens on your phone, because the app told you the address.
#
# It has always answered the whole network — the default bind address is
# 0.0.0.0 — but the only address it ever printed was localhost, which on a
# phone is the phone. Whoever wanted the board in their hand had to go and find
# this machine's address themselves (bw-hkai.1).
#
# The number it printed is a lease the router can take back, so the name this
# computer answers to goes ahead of it — and asking a copy the computer started
# by itself where it is has to be one word (bw-sxdg.1).
#
# The unit tests hold the rule about what to print. This holds the running
# program to the only thing that matters: the address it printed is an address
# that answers, fetched over that address and not over loopback.
#
#   bash scripts/reachable-from-the-network.sh
#
# ATELIER_BINARY  a binary to check instead of building one
#
# A machine with no route out has no network address to print, and the check
# says so and skips that half rather than failing on a fact about the machine.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO="$PWD"

failures=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; failures=$((failures + 1)); }
skip() { printf '  \033[33m–\033[0m %s\n' "$*"; }
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

# What another device on this network would reach this computer at. Asked the
# same way the program asks, and independently of it, so the check has its own
# answer to compare against rather than believing whatever was printed.
this_machine() {
  python3 - <<'PY'
import socket
try:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.connect(("203.0.113.1", 80))
    print(sock.getsockname()[0])
    sock.close()
except OSError:
    pass
PY
}

# The name this computer answers to on the local network, worked out here so
# the check has its own answer rather than believing whatever was printed.
own_local_name() {
  local said
  said="$(hostname 2>/dev/null)" || return 0
  said="${said%%.*}"
  [ -n "$said" ] && printf '%s.local' "$(printf '%s' "$said" | tr 'A-Z' 'a-z')"
}

# The addresses a name really resolves to here, loopback dropped — a name that
# only answers to this machine itself is a name a phone cannot use.
addresses_of() {
  python3 - "$1" <<'PY'
import socket, sys
try:
    found = {a[4][0] for a in socket.getaddrinfo(sys.argv[1], None)}
except OSError:
    found = set()
print(" ".join(sorted(f for f in found if not f.startswith("127.") and f != "::1")))
PY
}

# Every address a piece of output offers, so two of them can be compared.
addresses_in() { grep -o "http://[^ ]*:$PORT" "$1" | sort -u; }

# ---------------------------------------------------------------- the binary

say "A binary to start"

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

WORK="$(mktemp -d "${TMPDIR:-/tmp}/atelier-reachable.XXXXXX")" || exit 1
SERVER=""
cleanup() {
  [ -n "$SERVER" ] && { kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null; }
  rm -rf "$WORK"
}
trap cleanup EXIT

# Its own data folder and its own home: this must not touch the reader's
# projects, their settings or their reports.
start() {
  local host="$1" port="$2" helper="$3" said="$4"
  local -a settings=(
    HOME="$WORK/home"
    ATELIER_PORT="$port"
    ATELIER_DATA_DIR="$WORK/data"
    BEADS_WORKBENCH_PORT="$helper"
  )
  [ -n "$host" ] && settings+=(ATELIER_HOST="$host")
  env -i PATH="$PATH" "${settings[@]}" "$BINARY" run --no-browser >"$said" 2>&1 &
  SERVER=$!
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "http://127.0.0.1:$port/api/health" 2>/dev/null && return 0
    kill -0 "$SERVER" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

stop() {
  [ -n "$SERVER" ] && { kill "$SERVER" 2>/dev/null; wait "$SERVER" 2>/dev/null; SERVER=""; }
}

# ------------------------------------------------------- what it says it does

say "What it tells you before you start it"

HELP="$("$BINARY" --help 2>&1)"
if printf '%s' "$HELP" | grep -qi 'phone'; then
  pass "'--help' says the board opens on your phone"
else
  fail "'--help' never mentions reaching it from another device"
fi
if printf '%s' "$HELP" | grep -qi 'firewall'; then
  pass "and says what to look at when it does not answer"
else
  fail "'--help' does not say that a firewall is what holds the port shut"
fi

# ------------------------------------------------- answering the whole network

say "Started with nothing set"

PORT="$(free_port)"; HELPER="$(free_port)"
SAID="$WORK/said.txt"
if ! start "" "$PORT" "$HELPER" "$SAID"; then
  fail "the server never came up on $PORT:"
  sed 's/^/      /' "$SAID"
  echo; echo "$failures failure(s)"; exit 1
fi

if grep -q "http://localhost:$PORT" "$SAID"; then
  pass "it printed the address for this computer"
else
  fail "it never printed an address for this computer:"
  sed 's/^/      /' "$SAID"
fi

MACHINE="$(this_machine)"
PRINTED="$(grep -o "http://[0-9][0-9.]*:$PORT" "$SAID" | grep -v '127\.0\.0\.1' | head -1)"

if [ -z "$MACHINE" ]; then
  skip "this computer has no route out, so there is no network address to print"
  if grep -qi 'no route out' "$SAID"; then
    pass "and it said so, rather than printing half an address"
  else
    fail "it neither printed a network address nor said why there is none:"
    sed 's/^/      /' "$SAID"
  fi
else
  if [ -z "$PRINTED" ]; then
    fail "it printed no address another device could type — this is the fault:"
    sed 's/^/      /' "$SAID"
  elif [ "$PRINTED" != "http://$MACHINE:$PORT" ]; then
    fail "it printed $PRINTED, but this computer answers to $MACHINE on this network"
  else
    pass "it printed $PRINTED — this computer's own address on this network"
  fi

  # The whole point: fetched over that address, not over loopback.
  if [ -n "$PRINTED" ]; then
    CODE="$(curl -sS -o "$WORK/page.html" -w '%{http_code}' --max-time 10 "$PRINTED/" 2>/dev/null)"
    if [ "$CODE" = "200" ] && grep -qi '<!doctype html' "$WORK/page.html"; then
      pass "the board draws when fetched over that address, the way a phone would"
    else
      fail "the address it printed did not answer with the board (got ${CODE:-nothing})"
    fi
    if curl -fsS -o /dev/null --max-time 10 "$PRINTED/api/health" 2>/dev/null; then
      pass "and it is the same app answering there, not something else on the port"
    else
      fail "nothing of this app answered at $PRINTED"
    fi
  fi
fi

# ------------------------------------------------- a name that does not move

say "A name that keeps working after the router changes its mind"

OWN_NAME="$(own_local_name)"
PRINTED_NAME="$(grep -o "http://[A-Za-z0-9_-]*\.local:$PORT" "$SAID" | head -1)"

if [ -n "$PRINTED_NAME" ]; then
  BARE="$(printf '%s' "$PRINTED_NAME" | sed -e 's|http://||' -e "s|:$PORT||")"
  if [ -n "$(addresses_of "$BARE")" ]; then
    pass "it printed $PRINTED_NAME, and that name is found on this network"
  else
    fail "it printed $PRINTED_NAME, which resolves to nothing — a phone would wait for a page that never comes"
  fi

  NAME_LINE="$(grep -n "\.local:$PORT" "$SAID" | head -1 | cut -d: -f1)"
  NUMBER_LINE="$(grep -n "http://[0-9][0-9.]*:$PORT" "$SAID" | grep -v '127\.0\.0\.1' | head -1 | cut -d: -f1)"
  if [ -z "$NUMBER_LINE" ]; then
    skip "there is no number printed beside it to order against"
  elif [ "$NAME_LINE" -lt "$NUMBER_LINE" ]; then
    pass "and printed it ahead of the number the router hands out"
  else
    fail "the number came first, so that is what somebody writes down — and it moves"
  fi

  CODE="$(curl -sS -o "$WORK/named.html" -w '%{http_code}' --max-time 10 "$PRINTED_NAME/" 2>/dev/null)"
  if [ "$CODE" = "200" ] && grep -qi '<!doctype html' "$WORK/named.html"; then
    pass "the board draws when fetched over that name, not over the number"
  else
    fail "the name it printed did not answer with the board (got ${CODE:-nothing})"
  fi
  if curl -fsS -o /dev/null --max-time 10 "$PRINTED_NAME/api/health" 2>/dev/null; then
    pass "and it is the same app answering under that name"
  else
    fail "nothing of this app answered at $PRINTED_NAME"
  fi
elif [ -n "$OWN_NAME" ] && [ -n "$(addresses_of "$OWN_NAME")" ]; then
  fail "this computer answers to $OWN_NAME and it was never offered — the reader is left with a number that moves"
else
  skip "this computer is not found under a name on its own network"
  if grep -q '\.local' "$SAID"; then
    fail "a name was offered that nothing here resolves:"
    sed 's/^/      /' "$SAID"
  elif [ -n "$PRINTED" ]; then
    pass "and it offered the number instead, with no dead name"
  else
    skip "and there is no network address either"
  fi
fi

# --------------------------------------------- asking where a copy is running

say "Asking a copy that is already running where it is"

ask_where() {
  env -i PATH="$PATH" HOME="$WORK/home" ATELIER_PORT="$PORT" \
    ATELIER_DATA_DIR="$WORK/data" "$BINARY" where >"$1" 2>&1
}

WHERE="$WORK/where.txt"
if ask_where "$WHERE"; then
  pass "'atelier where' answers"
else
  fail "'atelier where' did not answer:"
  sed 's/^/      /' "$WHERE"
fi

if [ -n "$(addresses_in "$WHERE")" ] && [ "$(addresses_in "$SAID")" = "$(addresses_in "$WHERE")" ]; then
  pass "and names the same addresses the running copy printed"
else
  fail "it names different addresses from the ones the running copy printed:"
  printf '      running: %s\n' "$(addresses_in "$SAID" | tr '\n' ' ')"
  printf '      asked:   %s\n' "$(addresses_in "$WHERE" | tr '\n' ' ')"
fi

if grep -q 'It is answering there now' "$WHERE"; then
  pass "and says the copy on that port is answering"
else
  fail "it did not say whether anything is there:"
  sed 's/^/      /' "$WHERE"
fi

stop

WHERE_STOPPED="$WORK/where-stopped.txt"
ask_where "$WHERE_STOPPED"
if grep -q 'Nothing is answering' "$WHERE_STOPPED"; then
  pass "with nothing running it says so, rather than an address that would fail"
else
  fail "with nothing running it still claimed something was there:"
  sed 's/^/      /' "$WHERE_STOPPED"
fi
if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
  fail "asking where it is started a second server on $PORT"
else
  pass "and asking started nothing — the port is free"
fi

# ------------------------------------------------------ told to keep to itself

say "Told to answer only this computer"

PORT="$(free_port)"; HELPER="$(free_port)"
SAID="$WORK/said-alone.txt"
if ! start "127.0.0.1" "$PORT" "$HELPER" "$SAID"; then
  fail "the server never came up on $PORT bound to this computer only:"
  sed 's/^/      /' "$SAID"
else
  if grep -qi 'only this computer' "$SAID"; then
    pass "it says only this computer can reach it"
  else
    fail "it does not say that nobody else can reach it:"
    sed 's/^/      /' "$SAID"
  fi
  if grep -q "http://localhost:$PORT" "$SAID"; then
    pass "and still prints the address that does work"
  else
    fail "it printed no working address at all:"
    sed 's/^/      /' "$SAID"
  fi
  if [ -n "$MACHINE" ]; then
    if grep -q "http://$MACHINE:$PORT" "$SAID"; then
      fail "it offered $MACHINE:$PORT, which will not answer — somebody would type that on a phone and wait"
    else
      pass "it offers no network address, because none would answer"
    fi
    if curl -fsS -o /dev/null --max-time 5 "http://$MACHINE:$PORT/api/health" 2>/dev/null; then
      fail "it answered on the network anyway, so 'only this computer' is not true"
    else
      pass "and nothing answers there, which is what it said"
    fi
  fi
fi
stop

say "$failures failure(s)"
[ "$failures" = "0" ]
