#!/usr/bin/env bash
#
# Put a new version online, in one command.
#
# A release used to be eight commands typed in the right order: work out a
# number, write it into five files that nothing keeps in step, run the checks,
# push the line, write an annotated tag, push the tag, wait for the build, then
# write the recipe into the tap. Getting the order wrong publishes a tag whose
# build fails and cannot be taken back; missing one of the five files ships a
# build under a name it never had, which has already happened twice
# (bw-8um.3.28, bw-8um.3.32).
#
# So it is one command with no number in it. The number is read out of the work
# itself: a breaking change raises the first, a feature raises the second,
# anything else raises the third.
#
#   bash scripts/release.sh              # cut and publish the next version
#   bash scripts/release.sh --dry-run    # print every step and write nothing
#   bash scripts/release.sh --as 1.0.0   # use this number instead of working one out
#
# Nothing is published until the checks here are green AND the build online is
# green on the very commit being tagged, which is the whole reason the tag is
# written after the push rather than beside it (bw-sinv.3).

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

OWNER=AhsanSarwar45          # everything this project publishes to (D6)
SOURCE="$OWNER/atelier"      # where the releases are
TRUNK=ours                   # the line this computer works on
PUBLISHED=main               # what that line is called online
WAIT_LIMIT=2400              # seconds to give a build before saying so

DRY_RUN=0
AS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --as) shift; AS="${1:-}" ;;
    --as=*) AS="${1#--as=}" ;;
    -h|--help) sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) printf 'release: unknown option %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
say()  { printf '  %s\n' "$*"; }
would(){ printf '  \033[2m%s\033[0m\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# Something that would stop a real run. A dry run writes nothing, so it says so
# and carries on showing the rest — being told one reason at a time is what made
# the by-hand release take three goes.
BLOCKED=0
stop() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '  \033[33m!\033[0m would stop here: %s\n' "$*"
    BLOCKED=1
    return 0
  fi
  die "$*"
}

# Runs a command, or prints it and does nothing, depending on --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    # Printed so it can be pasted and mean the same thing: a commit message is
    # one argument, and shown without its quotes it reads as four.
    local shown="" piece
    for piece in "$@"; do
      case "$piece" in
        *[[:space:]]*) shown="$shown \"$piece\"" ;;
        *)             shown="$shown $piece" ;;
      esac
    done
    would "${shown# }"
    return 0
  fi
  "$@"
}

# ── 1 of 7 ────────────────────────────────────────────────────────────────
step "1/7  This computer is ready"

command -v gh >/dev/null 2>&1 || die "there is no gh on this computer to publish with"
WHO=$(gh api user --jq .login 2>/dev/null) \
  || die "there is no GitHub login on this computer to push with"
# The same rule tap.sh and the build are held to: this project publishes to one
# account, and a login for any other one is a mistake, not an option (D6).
[ "$WHO" = "$OWNER" ] \
  || stop "the active login is $WHO, and this project publishes only to $OWNER"

BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null) \
  || die "this is not a checkout with a branch on it"
[ "$BRANCH" = "$TRUNK" ] \
  || stop "a release is cut from $TRUNK, and this checkout is on $BRANCH"

DIRTY=$(git status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then
  stop "there is work here that is not saved yet:
$(printf '%s\n' "$DIRTY" | sed 's/^/      /')"
fi

if ! git fetch --quiet origin "$PUBLISHED" 2>/dev/null; then
  stop "could not reach $SOURCE to see what is already online"
elif ! git merge-base --is-ancestor "origin/$PUBLISHED" HEAD; then
  stop "what is online is ahead of this checkout — pull it down before releasing"
fi
[ "$BLOCKED" = 0 ] && ok "$WHO, on $TRUNK, nothing unsaved, and up to date with what is online"

# ── 2 of 7 ────────────────────────────────────────────────────────────────
step "2/7  What is going out"

NOW=$(node -p "require('./package.json').version" 2>/dev/null) \
  || die "package.json does not say what version this is"
LAST=$(git tag -l 'v*' | sed 's/^v//' | sort -V | tail -1)
[ -n "$LAST" ] || die "there is no earlier release to count from"

# The files and the last tag should name the same release. When they do not,
# something was tagged without the five files being written — the build online
# under that name reports a different one, and the recipe cannot be filled in
# for it (it happened to v0.13.2). It does not stop this release, whose number
# is worked out from the tag and written into the files below, but it is said
# out loud because nothing else says it.
[ "$NOW" = "$LAST" ] || say "note: the files here say $NOW while the last release is $LAST — that one went out under a name its build does not report"

SUBJECTS=$(git log "v$LAST..HEAD" --format='%s')
BODIES=$(git log "v$LAST..HEAD" --format='%b')
COUNT=$(printf '%s\n' "$SUBJECTS" | grep -c . )
if [ "$COUNT" -gt 0 ]; then
  say "$COUNT change(s) since $LAST:"
  printf '%s\n' "$SUBJECTS" | sed 's/^/      /'
else
  stop "nothing has changed since $LAST, so there is nothing to release"
fi

# A breaking marker is `feat!:` or `feat(scope)!:`, or the words in a body —
# the same two spellings every tool that reads these messages understands.
BUMP=patch
if printf '%s\n' "$SUBJECTS" | grep -qE '^[a-z]+(\([^)]*\))?!:' \
   || printf '%s\n' "$BODIES" | grep -q 'BREAKING CHANGE'; then
  BUMP=major
elif printf '%s\n' "$SUBJECTS" | grep -qE '^feat(\([^)]*\))?:'; then
  BUMP=minor
fi

IFS=. read -r MA MI PA <<<"$LAST"
case "$BUMP" in
  major) NEXT="$((MA + 1)).0.0" ;;
  minor) NEXT="$MA.$((MI + 1)).0" ;;
  patch) NEXT="$MA.$MI.$((PA + 1))" ;;
esac

if [ -n "$AS" ]; then
  printf '%s' "$AS" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' \
    || die "--as wants a number like 1.0.0, not $AS"
  say "worked out $NEXT from the changes, using $AS because you asked for it"
  NEXT="$AS"
fi
[ "$NEXT" != "$LAST" ] || die "the next number is the one already released"
git rev-parse -q --verify "refs/tags/v$NEXT" >/dev/null \
  && stop "v$NEXT already exists here — a released number is never written twice"

ok "next: $NEXT   (a $BUMP change on $LAST)"

# ── 3 of 7 ────────────────────────────────────────────────────────────────
step "3/7  The number, written in five places"

# Every one of these names the version, and nothing but this keeps them in step.
# server/Cargo.lock is here because a build machine reads it before the manifest;
# flake.nix is here because it names it twice and sat two releases behind once.
say "package.json          $NOW → $NEXT"
say "package-lock.json     $NOW → $NEXT   (twice)"
say "server/Cargo.toml     $NOW → $NEXT"
say "server/Cargo.lock     $NOW → $NEXT"
say "flake.nix             $NOW → $NEXT   (twice)"

if [ "$NOW" = "$NEXT" ]; then
  # A run that died after the writing step and is being started again. Writing
  # them a second time is not wrong, but the check below would then read the new
  # number as the old one still standing and stop a release that is fine.
  ok "the five already say $NEXT"
elif [ "$DRY_RUN" = 1 ]; then
  would "npm version --no-git-tag-version --allow-same-version $NEXT"
  would "sed -i \"0,/^version = \\\"$NOW\\\"/s//version = \\\"$NEXT\\\"/\" server/Cargo.toml"
  would "the atelier entry in server/Cargo.lock, and both lines in flake.nix"
else
  npm version --no-git-tag-version --allow-same-version "$NEXT" >/dev/null \
    || die "npm would not write $NEXT into package.json and package-lock.json"

  # Only the first `version =` line, which is the package's own; a dependency
  # further down the file must not be touched.
  sed -i "0,/^version = \"$NOW\"/s//version = \"$NEXT\"/" server/Cargo.toml \
    || die "could not write $NEXT into server/Cargo.toml"

  # The lock file names every package; ours is the one under `name = "atelier"`.
  awk -v old="version = \"$NOW\"" -v new="version = \"$NEXT\"" '
    $0 == "name = \"atelier\"" { mine = 1 }
    mine && $0 == old { $0 = new; mine = 0 }
    { print }
  ' server/Cargo.lock > server/Cargo.lock.next \
    && mv server/Cargo.lock.next server/Cargo.lock \
    || die "could not write $NEXT into server/Cargo.lock"

  sed -i "s/version = \"$NOW\";/version = \"$NEXT\";/g" flake.nix \
    || die "could not write $NEXT into flake.nix"

  LEFT=$(grep -l "\"$NOW\"" package.json package-lock.json server/Cargo.toml 2>/dev/null)
  [ -z "$LEFT" ] || die "$LEFT still says $NOW"
  ok "all five say $NEXT"
fi

# ── 4 of 7 ────────────────────────────────────────────────────────────────
step "4/7  The checks, here, before anything leaves"

# The program embeds the built screens, so it does not compile at all without
# them, and a checkout that has never built them answers with a page of errors
# about a missing folder rather than the one sentence that is true (bw-sinv.2).
if [ ! -d out ]; then
  stop "there are no built screens here to embed — run: npm ci && npm run build"
fi

if [ "$DRY_RUN" = 1 ]; then
  would "cargo test --manifest-path server/Cargo.toml"
else
  LOG=$(mktemp) || die "nowhere to put the check output"
  cargo test --manifest-path server/Cargo.toml >"$LOG" 2>&1 || {
    tail -40 "$LOG" >&2
    rm -f "$LOG"
    die "the checks are not green, so nothing was published"
  }
  PASSED=$(grep -oE 'test result: ok\. [0-9]+ passed' "$LOG" \
             | grep -oE '[0-9]+' | awk '{n += $1} END {print n}')
  rm -f "$LOG"
  ok "${PASSED:-all} checks green, the five files included"
fi

# ── 5 of 7 ────────────────────────────────────────────────────────────────
step "5/7  Onto the line, and wait for it to go green online"

# The one commit this release is, named here and used by everything after it.
# Work lands on the trunk all day: between the push and the tag, HEAD can
# already be somebody else's commit, and a tag written on HEAD would then name
# a build nothing had checked and nothing had put online. It happened on the
# first real run of this script (bw-sinv.3).
SHA=""
if [ "$NOW" = "$NEXT" ]; then
  # A run started again after an earlier one already saved the number. What goes
  # out is the line as it stands now, which carries that commit and anything
  # landed on top of it since — not the older commit by name, whose checks may
  # be exactly what the earlier run stopped for.
  say "the number is already saved, so what goes out is the line as it stands"
else
  run git add package.json package-lock.json server/Cargo.toml server/Cargo.lock flake.nix \
    || die "could not stage the five files"
  run git commit --quiet -m "chore(packaging): release $NEXT" \
    || die "could not save the version bump"
fi
[ "$DRY_RUN" = 1 ] || SHA=$(git rev-parse HEAD)

if [ "$DRY_RUN" = 1 ]; then
  would "git push --quiet origin <the release commit>:$PUBLISHED"
  would "gh run watch <the CI run on that very commit> --exit-status"
else
  git push --quiet origin "$SHA:$PUBLISHED" \
    || die "could not put the line online"
  ok "pushed $(git rev-parse --short "$SHA")"
  say "waiting for the checks online — this is what stops a tag being written on a red build"
  WAITED=0
  RUN=""
  while [ "$WAITED" -lt "$WAIT_LIMIT" ]; do
    RUN=$(gh run list -R "$SOURCE" --workflow CI --limit 12 \
            --json databaseId,headSha --jq \
            "[.[] | select(.headSha == \"$SHA\")][0].databaseId" 2>/dev/null)
    [ -n "$RUN" ] && [ "$RUN" != "null" ] && break
    sleep 10; WAITED=$((WAITED + 10))
  done
  [ -n "$RUN" ] && [ "$RUN" != "null" ] \
    || die "no build online ever picked up $SHA — look at $SOURCE/actions"
  gh run watch "$RUN" -R "$SOURCE" --exit-status --interval 15 >/dev/null 2>&1 \
    || die "the checks online went red on this commit, so no tag was written — gh run view $RUN -R $SOURCE --log-failed"
  ok "green online on the commit being released"
fi

# ── 6 of 7 ────────────────────────────────────────────────────────────────
step "6/7  The release"

run git tag -a "v$NEXT" -m "$NEXT" "${SHA:-HEAD}" \
  || die "could not write the tag"
run git push --quiet origin "v$NEXT" \
  || die "could not put the tag online"

if [ "$DRY_RUN" = 1 ]; then
  would "gh run watch <the Release build for v$NEXT> --exit-status"
else
  ok "v$NEXT is online, and the built files are being made"
  WAITED=0
  RUN=""
  while [ "$WAITED" -lt "$WAIT_LIMIT" ]; do
    RUN=$(gh run list -R "$SOURCE" --workflow Release --limit 12 \
            --json databaseId,headBranch --jq \
            "[.[] | select(.headBranch == \"v$NEXT\")][0].databaseId" 2>/dev/null)
    [ -n "$RUN" ] && [ "$RUN" != "null" ] && break
    sleep 10; WAITED=$((WAITED + 10))
  done
  [ -n "$RUN" ] && [ "$RUN" != "null" ] \
    || die "no build ever picked up v$NEXT — look at $SOURCE/actions"
  gh run watch "$RUN" -R "$SOURCE" --exit-status --interval 20 >/dev/null 2>&1 \
    || die "the release build went red — the tag is online but there is nothing to install; gh run view $RUN -R $SOURCE --log-failed"
  ok "a built file for every computer, with its fingerprints"
fi

# ── 7 of 7 ────────────────────────────────────────────────────────────────
step "7/7  The recipe, so installing it is one line"

if [ "$DRY_RUN" = 1 ]; then
  would "bash scripts/tap.sh v$NEXT"
  if [ "$BLOCKED" = 1 ]; then
    step "Nothing was written, and a real run would stop at the first ! above."
  else
    step "Nothing was written. Run it without --dry-run to publish $NEXT."
  fi
  exit 0
fi

bash scripts/tap.sh "v$NEXT" >/dev/null 2>&1 \
  || die "the release is online but the recipe was not written — run: bash scripts/tap.sh v$NEXT"
ok "the tap holds the recipe for $NEXT"

printf '\n  \033[1m%s is online.\033[0m\n' "$NEXT"
printf '  brew upgrade atelier   — and any copy already running steps aside for it\n\n'
