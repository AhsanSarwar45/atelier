#!/usr/bin/env bash
#
# The release step is read from the commit subjects and bodies.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
BUMP=$PWD/scripts/release-bump.sh

fail() { printf 'release bump test: %s\n' "$*" >&2; exit 1; }

TEST_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TEST_ROOT"' EXIT

repo() {
  rm -rf "$TEST_ROOT/repo"
  git init -q "$TEST_ROOT/repo"
  git -C "$TEST_ROOT/repo" -c commit.gpgsign=false -c user.name=t -c user.email=t@t \
    commit -q --allow-empty -m 'chore(packaging): release 0.1.0'
  git -C "$TEST_ROOT/repo" -c tag.gpgsign=false -c tag.forcesignannotated=false tag --no-sign v0.1.0
  local message
  for message in "$@"; do
    git -C "$TEST_ROOT/repo" -c commit.gpgsign=false -c user.name=t -c user.email=t@t \
      commit -q --allow-empty -m "$message"
  done
}

expect() {
  local want=$1; shift
  repo "$@"
  local got
  got=$(cd "$TEST_ROOT/repo" && bash "$BUMP" v0.1.0 2>/dev/null)
  [ "$got" = "$want" ] || fail "for [$*] wanted $want, got $got"
}

expect patch 'bw-b.1: a bug is fixed'
expect patch 'bw-f.1: a feature named only by its id'
expect minor 'bw-b.1: a bug is fixed' 'feat: a feature'
expect minor 'feat(ui): a scoped feature'
expect patch 'fix: mentions feat: only after the colon'
expect major 'bw-f.1!: a breaking change'
expect major 'fix(ui)!: a breaking fix'
expect major 'bw-b.1: a fix

BREAKING CHANGE: the old setting is gone'

printf 'release bump test: ok\n'
