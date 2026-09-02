#!/usr/bin/env bash
#
# Build this checkout, put that exact build and its pinned ACP runtimes where
# `atelier` currently lives, and make the computer's Atelier service run it.
#
#   scripts/install-local.sh
#   scripts/install-local.sh --dry-run
#
# Set ATELIER_INSTALL_PATH to choose the destination explicitly. When it is
# unset, an existing `atelier` on PATH is replaced; on a machine without one,
# the binary is installed as ~/.local/bin/atelier.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  -h|--help)
    sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
    exit 0
    ;;
  *) printf 'install-local: unknown option %s\n' "$1" >&2; exit 2 ;;
esac

# Before anything is built: this cannot run inside the app it replaces. A
# dry run replaces nothing, so it may look from anywhere.
#
# `TERM_PROGRAM` is what the terminal sets to name itself, and the shell this
# script is in is one the app opened. Step 2 overwrites the very binary that
# app is running; `server/src/handover.rs` watches that file, sees it change
# and hands over — and this shell dies with the process that owns its socket.
if [ "${TERM_PROGRAM:-}" = atelier ] && [ "$DRY_RUN" != 1 ]; then
  cat >&2 <<'REFUSED'
install-local: run this from a terminal outside Atelier. It replaces the binary
of the app whose terminal you are typing in; that app watches its own binary
(server/src/handover.rs), notices the change and restarts itself, and every
shell it opened is hung up the moment it goes — including this one. The install
would be killed by its own work, quite possibly part-way through the copy,
leaving neither the old build nor the new one in place.
REFUSED
  exit 1
fi

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

show_command() {
  local shown="" piece
  for piece in "$@"; do
    case "$piece" in
      *[!A-Za-z0-9_./:@%+=,-]*) printf -v piece '%q' "$piece" ;;
    esac
    shown="$shown $piece"
  done
  printf '  \033[2m%s\033[0m\n' "${shown# }"
}

run() {
  if [ "$DRY_RUN" = 1 ]; then
    show_command "$@"
  else
    "$@"
  fi
}

command -v npm >/dev/null 2>&1 || die "npm is required"
command -v cargo >/dev/null 2>&1 || die "cargo is required"
command -v install >/dev/null 2>&1 || die "the install command is required"

if [ -n "${ATELIER_INSTALL_PATH:-}" ]; then
  TARGET=$ATELIER_INSTALL_PATH
elif EXISTING=$(command -v atelier 2>/dev/null); then
  case "$EXISTING" in
    /*) TARGET=$EXISTING ;;
    *) die "atelier resolves to '$EXISTING', not an executable path; set ATELIER_INSTALL_PATH" ;;
  esac
else
  TARGET=${HOME:?HOME is not set}/.local/bin/atelier
fi

# Preserve an installer-managed link such as Homebrew's `bin/atelier`. Writing
# through it with `install` unlinks the link and divorces the local build from
# the package prefix that owns it.
if [ -L "$TARGET" ]; then
  LINK=$(readlink "$TARGET")
  case "$LINK" in
    /*) TARGET=$LINK ;;
    *) TARGET=$(dirname "$TARGET")/$LINK ;;
  esac
  TARGET=$(cd "$(dirname "$TARGET")" && pwd -P)/$(basename "$TARGET")
fi

TARGET_DIR=$(dirname "$TARGET")
BUILT=server/target/release/atelier
if [ "${OS:-}" = Windows_NT ]; then
  BUILT=server/target/release/atelier.exe
fi
ADAPTERS=server/target/release/atelier-adapters
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) ACP_TARGET=aarch64-apple-darwin ;;
  Darwin:x86_64) ACP_TARGET=x86_64-apple-darwin ;;
  Linux:x86_64) ACP_TARGET=x86_64-unknown-linux-gnu ;;
  MINGW*:x86_64|MSYS*:x86_64) ACP_TARGET=x86_64-pc-windows-msvc ;;
  *) die "there is no bundled ACP build target for $(uname -s) $(uname -m)" ;;
esac

step "1/4  Build this checkout"
run npm ci
run npm run build
run cargo build --release --locked --manifest-path server/Cargo.toml
[ "$DRY_RUN" = 1 ] || [ -x "$BUILT" ] || die "the build did not produce $BUILT"
ok "release binary is ready"

step "2/4  Build the pinned provider runtimes"
run node scripts/build-acp-adapters.mjs "$ACP_TARGET" "$ADAPTERS"
if [ "$DRY_RUN" != 1 ]; then
  for file in claude-acp codex-acp goose-acp claude-provider codex-provider codex-code-mode-host manifest.json; do
    [ -f "$ADAPTERS/$file" ] || die "the adapter build did not produce $ADAPTERS/$file"
  done
fi
ok "complete ACP runtime bundle is ready (unchanged bundles are reused; Goose Cargo cache: ${ATELIER_ACP_BUILD_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/atelier/acp-build})"

step "3/4  Replace the installed runtime"
run mkdir -p "$TARGET_DIR"
if [ -w "$TARGET_DIR" ]; then
  ADMIN=()
elif command -v sudo >/dev/null 2>&1; then
  ADMIN=(sudo)
else
  die "$TARGET_DIR is not writable and sudo is unavailable"
fi

ADAPTER_TARGET=$TARGET_DIR/atelier-adapters
run "${ADMIN[@]}" mkdir -p "$ADAPTER_TARGET"
for file in claude-acp codex-acp goose-acp claude-provider codex-provider codex-code-mode-host; do
  run "${ADMIN[@]}" install -m 755 "$ADAPTERS/$file" "$ADAPTER_TARGET/$file"
done
run "${ADMIN[@]}" install -m 644 "$ADAPTERS/manifest.json" "$ADAPTER_TARGET/manifest.json"
# Last on purpose: handover watches this file. It only restarts after every
# executable the new program needs is complete and in its final place.
run "${ADMIN[@]}" install -m 755 "$BUILT" "$TARGET"
ok "installed $TARGET and $ADAPTER_TARGET"

step "4/4  Register and start the new build"
run "$TARGET" service install
ok "the Atelier service now uses $TARGET"

if [ "$DRY_RUN" = 1 ]; then
  printf '\nDry run only; nothing was built, replaced, or restarted.\n'
else
  printf '\nInstalled the current checkout. Running `atelier` now uses:\n  %s\n' "$TARGET"
fi
