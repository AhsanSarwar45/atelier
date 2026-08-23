#!/usr/bin/env bash
#
# Write the install recipe for one release into the tap.
#
# `brew install AhsanSarwar45/atelier/atelier` reads one file — the recipe in the
# tap — and that file has to name the built files of a particular release and
# their fingerprints. The release build writes it too, but only when a token for
# the tap is stored in the project's secrets, and none is: storing a token that
# can push to a second repository, so that a build machine can do something this
# computer can already do, buys nothing (bw-8um.3.26).
#
# So it is done from here, with the login already sitting on this machine.
# Nothing is stored anywhere, and the recipe is built from the same shape in this
# repository that the build machine would have used.
#
#   bash scripts/tap.sh v0.13.0             # write the recipe for that release
#   bash scripts/tap.sh v0.13.0 --dry-run   # print it and write nothing
#
# The fingerprints are read off the release itself, never computed here, so the
# recipe can only ever describe files that are actually online.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

OWNER=AhsanSarwar45          # everything this project publishes to (D6)
SOURCE="$OWNER/atelier"      # where the releases are
TAP="$OWNER/homebrew-atelier"
SHAPE=packaging/homebrew/atelier.rb.tmpl
RECIPE=Formula/atelier.rb

DRY_RUN=0
TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    v*) TAG="$1" ;;
    *) printf 'tap: unknown option %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ -n "$TAG" ] || die "name the release, as in: bash scripts/tap.sh v0.13.0"
VERSION="${TAG#v}"

step "Who is pushing"
WHO=$(gh api user --jq .login 2>/dev/null) \
  || die "there is no GitHub login on this computer to push with"
# The same rule the build machine is held to: this project publishes to one
# account, and a login for any other one is a mistake, not an option.
[ "$WHO" = "$OWNER" ] \
  || die "the active login is $WHO, and this project publishes only to $OWNER"
ok "$WHO"

step "The release's own files"
HAS=$(gh release view "$TAG" -R "$SOURCE" --json assets \
        --jq '.assets[] | select(.name == "SHA256SUMS.txt") | .name' 2>/dev/null)
[ -n "$HAS" ] || die "$TAG on $SOURCE has no SHA256SUMS.txt — has the build finished?"
HERE=$(mktemp -d) || die "nowhere to put a downloaded file"
trap 'rm -rf "$HERE"' EXIT
gh release download "$TAG" -R "$SOURCE" -p SHA256SUMS.txt -D "$HERE" >/dev/null 2>&1 \
  || die "could not read the fingerprints off $TAG"
LIST=$(cat "$HERE/SHA256SUMS.txt")

fingerprint() {
  # The build writes `sha256sum *`, so each line is "<fingerprint>  <file>".
  local file="$1" found
  found=$(printf '%s\n' "$LIST" | awk -v f="$file" '$2 == f {print $1}')
  [ -n "$found" ] || die "$TAG lists no file called $file"
  printf '%s' "$found"
}
ARM=$(fingerprint atelier-darwin-arm64) || exit 1
INTEL=$(fingerprint atelier-darwin-x64) || exit 1
LINUX=$(fingerprint atelier-linux-x64) || exit 1
ok "three files, fingerprinted by the build itself"

step "The recipe"
[ -f "$SHAPE" ] || die "this repository holds no $SHAPE to build the recipe from"
BUILT=$(sed -e "s|__VERSION__|${VERSION}|g" \
            -e "s|__ARM_SHA__|${ARM}|g" \
            -e "s|__INTEL_SHA__|${INTEL}|g" \
            -e "s|__LINUX_SHA__|${LINUX}|g" "$SHAPE")
# A shape that grew a new blank would otherwise go up with the blank still in it,
# and every install would fail on a fingerprint that is the word __ARM_SHA__.
case "$BUILT" in
  *__*__*) die "the recipe still has a blank in it — $SHAPE grew one this does not fill" ;;
esac
ok "names $VERSION and three fingerprints, no blanks left"

if [ "$DRY_RUN" = 1 ]; then
  step "Would write $RECIPE to $TAP"
  printf '%s\n' "$BUILT"
  exit 0
fi

step "Into the tap"
WAS=$(gh api "repos/$TAP/contents/$RECIPE" --jq .sha 2>/dev/null)
ARGS=(--method PUT "repos/$TAP/contents/$RECIPE"
      -f "message=atelier $VERSION"
      -f "content=$(printf '%s\n' "$BUILT" | base64 -w0)")
[ -n "$WAS" ] && ARGS+=(-f "sha=$WAS")
gh api "${ARGS[@]}" --jq .content.path >/dev/null \
  || die "could not write $RECIPE to $TAP"
ok "$TAP holds the recipe for $VERSION"

printf '\n  brew install %s/atelier/atelier\n\n' "$OWNER"
