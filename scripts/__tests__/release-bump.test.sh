#!/usr/bin/env bash
#
# The release step is read from the cards the commits name, not only from
# `feat:` subjects (bw-4c76n.1).

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
BUMP=$PWD/scripts/release-bump.sh

fail() { printf 'release bump test: %s\n' "$*" >&2; exit 1; }

TEST_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin"

# The board: bw-f.1 is a feature by label, bw-t is one by type, bw-j.2 is one
# by its job, and bw-b.1 is a bug in a bug job.
# A card the board does not know is left out, as `bd show` does.
cat > "$TEST_ROOT/bin/bd" <<'EOF2'
#!/usr/bin/env bash
[ -e "$TEST_ROOT/board-down" ] && exit 1
out=()
for id in "$@"; do
  case "$id" in
    bw-f.1) out+=('{"id":"bw-f.1","issue_type":"task","labels":["kind:feature"]}') ;;
    bw-t)   out+=('{"id":"bw-t","issue_type":"feature","labels":[]}') ;;
    bw-b.1) out+=('{"id":"bw-b.1","issue_type":"task","labels":["kind:bug"],"parent":"bw-b"}') ;;
    bw-b)   out+=('{"id":"bw-b","issue_type":"epic","labels":["kind:bug"]}') ;;
    bw-j.2) out+=('{"id":"bw-j.2","issue_type":"task","labels":[],"parent":"bw-j"}') ;;
    bw-j)   out+=('{"id":"bw-j","issue_type":"epic","labels":["kind:feature"]}') ;;
  esac
done
(IFS=,; printf '[%s]\n' "${out[*]}")
EOF2
chmod +x "$TEST_ROOT/bin/bd"
export PATH="$TEST_ROOT/bin:$PATH" TEST_ROOT

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
expect minor 'bw-b.1: a bug is fixed' 'bw-f.1: a feature card ships'
expect minor 'bw-t: a card of type feature ships'
expect minor 'bw-j.2: a card whose job is a feature ships'
expect minor 'bw-b.1 bw-f.1: two cards, one a feature'
expect minor 'fix(bw-f.1): the card sits in the scope'
expect patch 'bw-b.1: mentions bw-f.1 only after the colon'
expect patch 'bw-gone.1: a card the board does not know'
expect minor 'feat: an old-style feature'
expect major 'bw-f.1!: a breaking feature'
expect major 'bw-b.1: a fix

BREAKING CHANGE: the old setting is gone'

touch "$TEST_ROOT/board-down"
expect patch 'bw-f.1: the board cannot be read'
rm "$TEST_ROOT/board-down"

printf 'release bump test: ok\n'
