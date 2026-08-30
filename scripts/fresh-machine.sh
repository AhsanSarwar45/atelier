#!/usr/bin/env bash
#
# What a reader actually has to install, proved by running the program on a
# computer that has none of it.
#
# Every folder, name ending and fallback in the tool lookup was written from
# documentation and read back by nobody: the checks all run on a developer's
# machine, where git, python, node, npm and bd are already installed and on the
# PATH, so "the app finds what it needs" was a claim about code nobody had ever
# put to a computer missing any of it (bw-dwxw).
#
# So this takes a container holding none of the five and adds them back one at
# a time, asking the program itself what it can see. Each case also asks a
# second time with the environment emptied — no PATH at all — because that is
# what a copy the machine starts at login is handed, and it is the case the
# whole lookup exists for.
#
#   bash scripts/fresh-machine.sh
#
# ATELIER_BINARY  a binary to check instead of building one
# IMAGE           the base image to start from (default fedora:43, chosen
#                 because it carries none of the five and a C library no older
#                 than the one a binary built here needs)

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO="$PWD"
BASE="${IMAGE:-fedora:43}"

cases=0
failures=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; failures=$((failures + 1)); }
say()  { printf '\n%s\n' "$*"; }
done_now() { say "$cases cases, $failures failures"; [ "$failures" = 0 ]; }

# ------------------------------------------------------------------ the parts

say "What this needs to run"

if ! command -v docker >/dev/null 2>&1; then
  fail "docker is not on this computer, and there is no other way to take the tools away"
  done_now; exit 1
fi
if ! docker info >/dev/null 2>&1; then
  fail "docker is installed but its daemon does not answer"
  done_now; exit 1
fi
pass "docker answers"

BINARY="${ATELIER_BINARY:-}"
if [ -z "$BINARY" ] && [ -x "$REPO/server/target/release/atelier" ]; then
  BINARY="$REPO/server/target/release/atelier"
fi
if [ -z "$BINARY" ]; then
  if [ ! -d "$REPO/out" ]; then
    fail "there is no built frontend at out/ — run 'npm run build' first"
    done_now; exit 1
  fi
  echo "  building (this takes a few minutes the first time)…"
  if ! (cd "$REPO/server" && cargo build --release >/dev/null 2>&1); then
    fail "the release build did not finish; run 'cd server && cargo build --release' to see why"
    done_now; exit 1
  fi
  BINARY="$REPO/server/target/release/atelier"
fi
if [ ! -x "$BINARY" ]; then
  fail "no binary to check at $BINARY"
  done_now; exit 1
fi
pass "a binary to check: $BINARY"

# bd is the one of the five that no distribution packages, so the case that
# wants it is handed the copy this computer already has. Nothing runs it — the
# program only has to see a file it could start.
BD="$(command -v bd 2>/dev/null)"
[ -n "$BD" ] && BD="$(readlink -f "$BD")"
if [ -z "$BD" ] || [ ! -x "$BD" ]; then
  fail "no bd on this computer to hand to the container; install beads first"
  done_now; exit 1
fi
pass "a bd to hand over: $BD"

# ---------------------------------------------------------------- the machines

say "Building the machines to try it on"

build_image() { # name, install-line
  local tag="$1" line="$2"
  if docker image inspect "$tag" >/dev/null 2>&1; then
    pass "$tag is already built"
    return 0
  fi
  echo "  building $tag (fetching packages, this takes a minute)…"
  if printf 'FROM %s\nRUN %s && dnf clean all\n' "$BASE" "$line" \
      | docker build -q -t "$tag" - >/dev/null 2>&1; then
    pass "$tag"
  else
    fail "$tag could not be built"
  fi
}

# Python is taken back off after git goes on, because this distribution's git
# brings it — even `git-core` does. That is a true thing about Fedora and it is
# also the reason the case has to be built rather than assumed: a machine with
# git and no python is an ordinary one elsewhere, and it is where the two
# spellings of python and the board's own gate are decided.
build_image atelier-fresh-git \
  "dnf -y install git-core && rpm -e --nodeps python3 python-unversioned-command"
build_image atelier-fresh-all "dnf -y install git python3 nodejs npm"
[ "$failures" = 0 ] || { done_now; exit 1; }

# ------------------------------------------------------------------ the cases

# Ask the program what it sees, and answer with the names it called missing.
missing_in() { # image, [extra docker arguments…]
  local image="$1"; shift
  docker run --rm -v "$BINARY":/opt/atelier:ro "$@" "$image" \
    /opt/atelier tools 2>/dev/null | awk '$2 == "missing" { print $1 }' | sort | tr '\n' ' '
}

# The same question, asked of a program handed nothing at all — no PATH, no
# HOME, no environment. This is what a service started at login actually gets.
missing_with_nothing() { # image, [extra docker arguments…]
  local image="$1"; shift
  docker run --rm -v "$BINARY":/opt/atelier:ro "$@" "$image" \
    env -i /opt/atelier tools 2>/dev/null | awk '$2 == "missing" { print $1 }' | sort | tr '\n' ' '
}

try() { # what, expected-missing, image, [extra docker arguments…]
  local what="$1" want="$2" image="$3"; shift 3
  cases=$((cases + 1))
  say "$what"

  local got; got="$(missing_in "$image" "$@")"
  if [ "$got" = "$want" ]; then
    pass "it reports missing: ${want:-nothing}"
  else
    fail "it reports missing: ${got:-nothing} — expected: ${want:-nothing}"
  fi

  local bare; bare="$(missing_with_nothing "$image" "$@")"
  if [ "$bare" = "$want" ]; then
    pass "and the same with no environment at all, which is what login hands it"
  else
    fail "handed no environment it reports missing: ${bare:-nothing} — expected: ${want:-nothing}"
  fi
}

BD_MOUNT=(-v "$BD":/usr/local/bin/bd:ro)

try "A computer with none of them on it" \
    "bd git node npm python3 " "$BASE"

try "A computer with only git" \
    "bd node npm python3 " atelier-fresh-git

try "A computer with git and the board tool" \
    "node npm python3 " atelier-fresh-git "${BD_MOUNT[@]}"

try "A computer with all of them" \
    "" atelier-fresh-all "${BD_MOUNT[@]}"

done_now
