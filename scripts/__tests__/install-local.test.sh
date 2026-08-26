#!/usr/bin/env bash

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

fail() { printf 'install-local test: %s\n' "$*" >&2; exit 1; }
has()  { printf '%s\n' "$1" | grep -Fq "$2" || fail "output did not contain: $2"; }

bash -n scripts/install-local.sh

TEST_ROOT=$(mktemp -d)
trap 'rm -rf -- "$TEST_ROOT"' EXIT
FAKE_BIN=$TEST_ROOT/bin
mkdir -p "$FAKE_BIN"

for name in npm cargo install atelier; do
  printf '#!/usr/bin/env bash\nprintf "ran %s\\n" "$0" >> "%s"\n' "$TEST_ROOT/ran" > "$FAKE_BIN/$name"
  chmod +x "$FAKE_BIN/$name"
done

OUTPUT=$(PATH="$FAKE_BIN:$PATH" HOME="$TEST_ROOT/home" scripts/install-local.sh --dry-run)
has "$OUTPUT" "npm ci"
has "$OUTPUT" "npm run build"
has "$OUTPUT" "cargo build --release --locked --manifest-path server/Cargo.toml"
has "$OUTPUT" "install -m 755 server/target/release/atelier $FAKE_BIN/atelier"
has "$OUTPUT" "$FAKE_BIN/atelier service install"
[ ! -e "$TEST_ROOT/ran" ] || fail "dry-run executed a mocked command"

EXPLICIT=$TEST_ROOT/chosen/atelier
OUTPUT=$(PATH="$FAKE_BIN:$PATH" HOME="$TEST_ROOT/home" ATELIER_INSTALL_PATH="$EXPLICIT" scripts/install-local.sh --dry-run)
has "$OUTPUT" "mkdir -p $TEST_ROOT/chosen"
has "$OUTPUT" "install -m 755 server/target/release/atelier $EXPLICIT"
has "$OUTPUT" "$EXPLICIT service install"
[ ! -e "$TEST_ROOT/ran" ] || fail "explicit-path dry-run executed a mocked command"

printf 'all local installer checks passed\n'
