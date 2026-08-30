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
# serve, and are its native chat routes present without installing a runtime.
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

# The four release recipes must all package exactly the Rust program. This is
# checked from the workflow itself so the proof covers macOS ARM, macOS Intel,
# Linux and Windows even when this script runs on only one of those systems.
say "Release archive recipes"
ARCHIVE_RECIPES="$(sed -n '/name: Bundle archive (Unix)/,/name: Upload artifact/p' "$REPO/.github/workflows/release.yml")"
for artifact in atelier-darwin-arm64 atelier-darwin-x64 atelier-linux-x64 atelier-win-x64; do
  if grep -q "artifact: $artifact" "$REPO/.github/workflows/release.yml"; then
    pass "$artifact has a release recipe"
  else
    fail "$artifact is missing from the release matrix"
  fi
done
if printf '%s' "$ARCHIVE_RECIPES" | grep -Eqi 'node(\.exe)?|node_modules|npm|bundle-node'; then
  fail "a release archive recipe still packages or downloads Node/npm"
else
  pass "all supported archive recipes package no node, node.exe, node_modules or npm payload"
fi

# CI can hand the script the archives it produced for a byte-level contents
# check. A whitespace-separated list is deliberate: release asset names contain
# no spaces. Each archive must contain one flat atelier program and nothing else.
for archive in ${ATELIER_ARCHIVES:-}; do
  names="$(tar -tzf "$archive" | sed 's#^\./##')"
  expected=atelier
  case "$archive" in *win*) expected=atelier.exe ;; esac
  if [ "$names" = "$expected" ]; then
    pass "$(basename "$archive") contains only $expected"
  else
    fail "$(basename "$archive") contains unexpected files: $(printf '%s' "$names" | tr '\n' ' ')"
  fi
done

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

# A free port for the app. It is picked rather
# than fixed for the same reason — the reader's own copy of the app sits on
# 3008, and a fixed port would let this whole check be answered by that copy
# without the binary under test ever starting. The chat helper's own port is not
# among them: it asks the machine for one and tells the app which it got, which
# is what the last case here is about.
read -r PORT <<<"$(python3 - <<'PY'
import socket
sock = socket.socket()
sock.bind(("127.0.0.1", 0))
print(sock.getsockname()[1])
sock.close()
PY
)"
if [ -z "${PORT:-}" ]; then
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
# environment are all gone. PATH stays because git, bd and the selected AI
# provider are the reader's own programs, not this project's.
LOG="$WORK/said.txt"
env -i \
  PATH="$PATH" \
  HOME="$HOME_DIR" \
  ATELIER_HOST=127.0.0.1 \
  ATELIER_PORT="$PORT" \
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

# --------------------------------------------------------- and its native chat

say "Is native chat behind it"

answered=0
for _ in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/workbench/health")
  if [ "$code" = "200" ]; then
    answered=1
    break
  fi
  kill -0 "$SERVER" 2>/dev/null || break
  sleep 1
done

if [ "$answered" = "1" ]; then
  pass "native chat answers (/api/workbench/health returns 200)"
else
  fail "native chat never answered; the program said:"
  sed 's/^/      /' "$LOG"
fi

say "No JavaScript runtime was installed"
if find "$WORK" "$HOME_DIR" -type f \( -name node -o -name node.exe -o -name npm -o -name npm.cmd \) -print | grep -q .; then
  fail "the release installed a Node/npm executable"
else
  pass "the release installed no node, node.exe, npm or npm.cmd"
fi
if find "$WORK" "$HOME_DIR" -type d -name node_modules -print | grep -q .; then
  fail "the release installed node_modules"
else
  pass "the release installed no node_modules"
fi

say "$failures failure(s)"
[ "$failures" = "0" ]
