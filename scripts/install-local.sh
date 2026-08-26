#!/usr/bin/env bash
#
# Build this checkout, put that exact build where `atelier` currently lives,
# and make the computer's Atelier service run it.
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

TARGET_DIR=$(dirname "$TARGET")
BUILT=server/target/release/atelier
if [ "${OS:-}" = Windows_NT ]; then
  BUILT=server/target/release/atelier.exe
fi

step "1/3  Build this checkout"
run npm ci
run npm run build
run cargo build --release --locked --manifest-path server/Cargo.toml
[ "$DRY_RUN" = 1 ] || [ -x "$BUILT" ] || die "the build did not produce $BUILT"
ok "release binary is ready"

step "2/3  Replace the installed command"
run mkdir -p "$TARGET_DIR"
if [ -w "$TARGET_DIR" ]; then
  run install -m 755 "$BUILT" "$TARGET"
elif command -v sudo >/dev/null 2>&1; then
  run sudo install -m 755 "$BUILT" "$TARGET"
else
  die "$TARGET_DIR is not writable and sudo is unavailable"
fi
ok "installed $TARGET"

step "3/3  Register and start the new build"
run "$TARGET" service install
ok "the Atelier service now uses $TARGET"

if [ "$DRY_RUN" = 1 ]; then
  printf '\nDry run only; nothing was built, replaced, or restarted.\n'
else
  printf '\nInstalled the current checkout. Running `atelier` now uses:\n  %s\n' "$TARGET"
fi
