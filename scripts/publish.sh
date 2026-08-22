#!/usr/bin/env bash
#
# Put this project's source online without putting a private address there too.
#
# The work on this repository was done for years under a work email address.
# That address is stamped into 435 of the saved changes on this line, and GitHub
# shows the address on every one of them to anybody who opens the page — so the
# moment the history goes up, the address is public and stays public in every
# copy anybody took (bw-8um.3.22).
#
# So nothing is ever pushed straight from this checkout. Every push goes through
# here: the history is copied aside, the old address is swapped for the personal
# one in that copy, the copy is checked to be the same files as what is here,
# and only then does it go up. Nothing in this checkout is touched — not a
# branch, not a working file, not one of the thirty side trees.
#
#   bash scripts/publish.sh                 # put the trunk online
#   bash scripts/publish.sh --dry-run       # do everything except the push
#   bash scripts/publish.sh --tag v0.13.0   # also put that one tag online
#
# The swap is the same every time, so the copy it builds is the same every time:
# the second publish walks forward from the first, and no push has to be forced.
#
# The addresses live outside this repository on purpose — writing them into a
# file here would publish the very thing this is hiding. Format is git's own
# mailmap, one line per person:
#
#   Real Name <address to show> <address to replace>
#
# ATELIER_PUBLISH_MAILMAP  that file, if not ~/.config/atelier/publish.mailmap
#
# Old release tags are NOT published. Twenty-five of them came in with the fork,
# and each one landing on the new repository would start a release build and
# leave a release page behind. A tag goes up only when it is named.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
REPO="$PWD"

TRUNK=ours          # what is published
ONLINE=main         # what it is called once it is there

DRY_RUN=0
TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --tag) shift; TAG="${1:-}" ;;
    --tag=*) TAG="${1#--tag=}" ;;
    -h|--help) sed -n '2,44p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) printf 'publish: unknown option %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------- what we need

step "What this needs"

FILTER_REPO="$(command -v git-filter-repo || true)"
[ -n "$FILTER_REPO" ] && [ -x "$FILTER_REPO" ] || FILTER_REPO="$HOME/.local/bin/git-filter-repo"
[ -x "$FILTER_REPO" ] || die "git-filter-repo is not installed: pip install --user git-filter-repo"
ok "the rewriter: $FILTER_REPO"

MAILMAP="${ATELIER_PUBLISH_MAILMAP:-$HOME/.config/atelier/publish.mailmap}"
[ -f "$MAILMAP" ] || die "no address list at $MAILMAP — see the notes at the top of this script"
ok "the address list: $MAILMAP"

# The address being replaced is the last one on a mailmap line. A line with only
# one address renames somebody without moving them, and there is nothing to hide.
REPLACED=$(sed 's/#.*//' "$MAILMAP" | grep -o '<[^>]*>' -n \
           | awk -F: '{c[$1]=c[$1]+1; last[$1]=$2} END {for (l in c) if (c[l] > 1) print last[l]}' \
           | tr -d '<>' | sort -u)
[ -n "$REPLACED" ] || die "$MAILMAP names no address to replace"
ok "addresses to keep off the internet: $(echo "$REPLACED" | tr '\n' ' ')"

REMOTE_URL=$(git -C "$REPO" remote get-url --push origin 2>/dev/null)
[ -n "$REMOTE_URL" ] || die "no origin remote to publish to"
SLUG=$(printf '%s' "$REMOTE_URL" | sed -E 's#^.*github\.com[:/]##; s#\.git$##')
case "$SLUG" in */*) ;; *) die "origin is not a GitHub repository: $REMOTE_URL" ;; esac
ok "publishing to github.com/$SLUG ($TRUNK becomes $ONLINE)"

# ------------------------------------------------------- nothing in the files

step "The address is not written into the files themselves"

for address in $REPLACED; do
  hits=$(git -C "$REPO" grep -l -F "$address" "$TRUNK" -- 2>/dev/null)
  [ -z "$hits" ] || die "$address is written into files this would publish:
$hits"
done
ok "no file on $TRUNK carries a replaced address"

# --------------------------------------------------------------- the rewrite

WORK=$(mktemp -d "${TMPDIR:-/tmp}/atelier-publish.XXXXXX") || die "cannot make a working folder"
trap 'rm -rf "$WORK"' EXIT

step "A copy of the history, with the addresses swapped"

git clone --mirror --quiet "$REPO" "$WORK/mirror.git" || die "cannot copy the history"

# A mirror copies EVERY ref this machine has — the side trees' branches, the
# machinery's own refs, saved stashes, session checkpoints. None of that belongs
# on the internet, so everything but the trunk and the tags is dropped before the
# rewrite, and the rewrite then only has the published history to walk.
git -C "$WORK/mirror.git" for-each-ref --format='%(refname)' \
  | grep -v -E "^refs/(heads/$TRUNK$|tags/)" \
  | while read -r ref; do git -C "$WORK/mirror.git" update-ref -d "$ref"; done
ok "kept $TRUNK and $(git -C "$WORK/mirror.git" tag -l | wc -l | tr -d ' ') tags, dropped every other ref"

BEFORE_COUNT=$(git -C "$REPO" rev-list --count "$TRUNK")
BEFORE_TREE=$(git -C "$REPO" rev-parse "$TRUNK^{tree}")

# Its running commentary is kept back and only shown if it fails; on success the
# checks below are the interesting part, and its notices are about the throwaway
# copy rather than anything here.
( cd "$WORK/mirror.git" && "$FILTER_REPO" --force --quiet --mailmap "$MAILMAP" ) \
  >"$WORK/rewrite.log" 2>&1 || { cat "$WORK/rewrite.log" >&2; die "the rewrite failed"; }
ok "addresses swapped"

# ------------------------------------------------------------- what it proves

step "The copy is the same project, minus the addresses"

AFTER_COUNT=$(git -C "$WORK/mirror.git" rev-list --count "$TRUNK")
AFTER_TREE=$(git -C "$WORK/mirror.git" rev-parse "$TRUNK^{tree}")

[ "$BEFORE_COUNT" = "$AFTER_COUNT" ] \
  || die "the copy has $AFTER_COUNT saved changes, this checkout has $BEFORE_COUNT"
ok "$AFTER_COUNT saved changes, same as here"

[ "$BEFORE_TREE" = "$AFTER_TREE" ] \
  || die "the copy's files differ from this checkout ($AFTER_TREE, not $BEFORE_TREE)"
ok "the files are byte for byte what is here ($BEFORE_TREE)"

left=0
for address in $REPLACED; do
  n=$(git -C "$WORK/mirror.git" log --all --format='%ae%n%ce' | grep -c -F -x "$address")
  [ "$n" = 0 ] || { printf '  \033[31m✗\033[0m %s still on %s saved changes\n' "$address" "$n" >&2; left=1; }
done
[ "$left" = 0 ] || die "the rewrite did not take"
ok "none of the replaced addresses is left on any saved change"

# ----------------------------------------------------------------- the push

REWRITTEN=$(git -C "$WORK/mirror.git" rev-parse "$TRUNK")

if [ -n "$TAG" ]; then
  git -C "$WORK/mirror.git" rev-parse -q --verify "refs/tags/$TAG" >/dev/null \
    || die "there is no tag called $TAG"
fi

if [ "$DRY_RUN" = 1 ]; then
  step "Not pushing (--dry-run)"
  printf '  would push %s as %s on github.com/%s\n' "$REWRITTEN" "$ONLINE" "$SLUG"
  [ -n "$TAG" ] && printf '  would push the tag %s\n' "$TAG"
  exit 0
fi

step "Putting it online"

# GitHub wants a login for the push. `gh` already holds one, so it is borrowed
# for the length of this one command and never written anywhere; its output is
# scrubbed in case a rejection message quotes the address back.
PUSH_URL="https://github.com/$SLUG.git"
TOKEN=""
if command -v gh >/dev/null 2>&1; then
  TOKEN=$(gh auth token 2>/dev/null)
  [ -n "$TOKEN" ] && PUSH_URL="https://x-access-token:$TOKEN@github.com/$SLUG.git"
fi
scrub() { if [ -n "$TOKEN" ]; then sed "s/$TOKEN/[token]/g"; else cat; fi; }

refspecs=("$REWRITTEN:refs/heads/$ONLINE")
[ -n "$TAG" ] && refspecs+=("refs/tags/$TAG:refs/tags/$TAG")

git -C "$WORK/mirror.git" push "$PUSH_URL" "${refspecs[@]}" 2>&1 | scrub
status=${PIPESTATUS[0]}
[ "$status" = 0 ] || die "the push was refused — the message above says why"

ok "github.com/$SLUG is at $REWRITTEN"
[ -n "$TAG" ] && ok "the tag $TAG is online"
printf '\nhttps://github.com/%s\n' "$SLUG"
