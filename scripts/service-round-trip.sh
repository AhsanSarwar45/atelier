#!/usr/bin/env bash
#
# The computer starts it, and stops starting it, leaving nothing behind.
#
# What this catches is a registration that half works: a definition written but
# never picked up, a service the machine starts from a shell that only exists
# while somebody is logged in, a port or a data folder that quietly reverts at
# the next reboot because a service inherits no environment, or an uninstall
# that stops the copy but leaves the definition sitting there to come back
# (bw-8um.3.13).
#
# So the check registers a copy for real, has the platform's own service
# manager start it — not this script, which is the whole point — asks it for a
# page, then takes it back off and proves both the definition and the running
# copy are gone.
#
#   bash scripts/service-round-trip.sh
#
# ATELIER_BINARY  a release binary to check instead of building one
# KEEP            leave the fresh folder behind, to look at what was written
#
# Two deliberate deviations from a plain install, both so this cannot touch the
# reader's own copy:
#
#   · the registration is named for this run, not `atelier`, so it is a
#     separate entry in the machine's list and taking it off cannot take the
#     reader's with it;
#   · it is given a port picked free and a data folder made a second ago, so it
#     serves nobody's projects and collides with nothing.
#
# Both travel through the same code the real install uses, which is what makes
# them a deviation in the arguments rather than in the thing being checked.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO="$PWD"

failures=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; failures=$((failures + 1)); }
say()  { printf '\n%s\n' "$*"; }

# --------------------------------------------------- is there one to talk to

if [ "$(uname -s)" != "Linux" ] || ! command -v systemctl >/dev/null 2>&1; then
  echo "skipped: this machine has no systemd user manager to register with."
  echo "The definitions for launchd and Task Scheduler are checked by the"
  echo "server's own tests, which run everywhere; this round trip needs the"
  echo "real service manager and can only run where it exists."
  exit 0
fi

if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "skipped: there is no systemd user manager running for $USER."
  exit 0
fi

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
pass "built: $(basename "$BINARY")"

# --------------------------------------------------------- a copy of its own

WORK="$(mktemp -d "${TMPDIR:-/tmp}/atelier-service.XXXXXX")" || exit 1
mkdir -p "$WORK/data"
cp "$BINARY" "$WORK/atelier"
chmod +x "$WORK/atelier"

NAME="atelier-check-$$"
UNIT="$NAME.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT"

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
if [ -z "${HELPER_PORT:-}" ]; then
  fail "could not find free ports to serve on"
  echo; echo "$failures failure(s)"; exit 1
fi

# Whatever happens below, this machine must not be left holding a registration
# nobody meant to make.
cleanup() {
  systemctl --user disable --now "$UNIT" >/dev/null 2>&1
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload >/dev/null 2>&1
  if [ -n "${KEEP:-}" ]; then
    echo "left behind: $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

registered() {
  env ATELIER_SERVICE_NAME="$NAME" \
      ATELIER_PORT="$PORT" \
      ATELIER_HOST=127.0.0.1 \
      ATELIER_DATA_DIR="$WORK/data" \
      BEADS_WORKBENCH_PORT="$HELPER_PORT" \
      "$WORK/atelier" service "$@" 2>&1
}

# ------------------------------------------------------------ registering it

say "Registering it"
echo "  atelier service install"

INSTALL="$(registered install)"
if [ $? = 0 ]; then
  pass "the install ran"
else
  fail "the install failed:"
  printf '%s\n' "$INSTALL" | sed 's/^/      /'
fi

if [ -f "$UNIT_FILE" ]; then
  pass "it wrote a definition the service manager reads ($UNIT)"
else
  fail "no definition at $UNIT_FILE"
  printf '%s\n' "$INSTALL" | sed 's/^/      /'
  echo; echo "$failures failure(s)"; exit 1
fi

if grep -q 'ExecStart=.*run --no-browser' "$UNIT_FILE"; then
  pass "it starts the one command, and opens no window over a login"
else
  fail "the definition does not start 'run --no-browser':"
  sed 's/^/      /' "$UNIT_FILE"
fi

# A service inherits no shell. Anything the reader had set when they registered
# it has to be written down here or it silently reverts at the next reboot.
for setting in "ATELIER_PORT=$PORT" "ATELIER_DATA_DIR=$WORK/data" "BEADS_WORKBENCH_PORT=$HELPER_PORT"; do
  if grep -qF "Environment=$setting" "$UNIT_FILE"; then
    pass "it carried $setting into the definition"
  else
    fail "$setting was not carried into the definition"
  fi
done

if grep -q 'WantedBy=default.target' "$UNIT_FILE"; then
  pass "it is wanted at login rather than waiting to be asked"
else
  fail "the definition is not wanted at login"
fi

if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = "yes" ]; then
  pass "and it survives logging out, so a rebooted machine comes back with it"
else
  fail "lingering is off, so this stops the moment the reader logs out"
fi

# ------------------------------------------- started by the machine, not us

say "Started by the service manager, from a cold reload"

systemctl --user daemon-reload
if systemctl --user restart "$UNIT"; then
  pass "the service manager started it (nothing here ran the program)"
else
  fail "the service manager refused to start it:"
  systemctl --user status --no-pager "$UNIT" 2>&1 | sed 's/^/      /'
fi

MAIN_PID="$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null)"
if [ -n "$MAIN_PID" ] && [ "$MAIN_PID" != "0" ]; then
  PARENT="$(ps -o ppid= -p "$MAIN_PID" 2>/dev/null | tr -d ' ')"
  PARENT_NAME="$(ps -o comm= -p "$PARENT" 2>/dev/null)"
  if [ "$PARENT_NAME" = "systemd" ]; then
    pass "the running copy's parent is the service manager, not a shell"
  else
    fail "the running copy hangs off '$PARENT_NAME', not the service manager"
  fi
else
  fail "the service manager reports no running copy"
fi

serving=0
for _ in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health")" = "200" ]; then
    serving=1
    break
  fi
  sleep 1
done

if [ "$serving" = "1" ]; then
  pass "it answers on the port it was registered with ($PORT)"
else
  fail "it never answered on port $PORT:"
  journalctl --user -u "$UNIT" -n 20 --no-pager 2>&1 | sed 's/^/      /'
fi

code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
if [ "$code" = "200" ]; then
  pass "the board screen is up with it (/ returns $code)"
else
  fail "the board screen is not served (/ returns $code)"
fi

if [ -d "$WORK/data" ] && [ -n "$(ls -A "$WORK/data" 2>/dev/null)" ]; then
  pass "and it is using the data folder it was registered with, not the reader's"
else
  fail "nothing was written to the data folder it was registered with"
fi

# ------------------------------------------------------ taking it back off

say "Taking it back off"
echo "  atelier service uninstall"

REMOVE="$(registered uninstall)"
if [ $? = 0 ]; then
  pass "the uninstall ran"
else
  fail "the uninstall failed:"
  printf '%s\n' "$REMOVE" | sed 's/^/      /'
fi

if [ -f "$UNIT_FILE" ]; then
  fail "the definition is still at $UNIT_FILE"
else
  pass "the definition is gone"
fi

if systemctl --user list-unit-files 2>/dev/null | grep -q "^$UNIT"; then
  fail "the service manager still lists $UNIT"
else
  pass "the service manager no longer lists it"
fi

gone=0
for _ in $(seq 1 30); do
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/health"
  # 7 is curl's "could not connect": nothing is listening there any more.
  if [ $? = 7 ]; then
    gone=1
    break
  fi
  sleep 1
done

if [ "$gone" = "1" ]; then
  pass "and nothing is listening on $PORT any more"
else
  fail "something is still answering on port $PORT after the uninstall"
fi

STATUS="$(registered status)"
if printf '%s' "$STATUS" | grep -q 'not registered'; then
  pass "asking after it says it is not registered"
else
  fail "'service status' does not say it is gone:"
  printf '%s\n' "$STATUS" | sed 's/^/      /'
fi

say "$failures failure(s)"
[ "$failures" = "0" ]
