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
#   bash scripts/release.sh --as 1.0.0   # take a bigger step than the work asks for
#
# Nothing is published until the checks here are green AND the build online is
# green on the very commit being tagged, which is the whole reason the tag is
# written after the push rather than beside it (bw-sinv.3).
#
# --as cannot name a number of its own. It may only be one of the three steps up
# from the last release, and never a smaller one than the work asks for — so the
# version is still never typed, only how big a step it is (bw-sinv.13).

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
    -h|--help) sed -n '2,27p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
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

# The build online for one thing, named the one way it can be recognised: the
# checks are found by the commit they ran on, the release build by the tag that
# started it. Waiting for a run to appear and waiting for it to finish are two
# different waits — a run that has not been created yet and a run still going
# look the same from here, and only the first is worth giving up on before the
# build has had its say. One loop, because two copies of it drift apart.
run_for() {
  local workflow=$1 field=$2 value=$3 found=""
  local WAITED=0
  while [ "$WAITED" -lt "$WAIT_LIMIT" ]; do
    found=$(gh run list -R "$SOURCE" --workflow "$workflow" --limit 12 \
              --json databaseId,"$field" --jq \
              "[.[] | select(.$field == \"$value\")][0].databaseId" 2>/dev/null)
    if [ -n "$found" ] && [ "$found" != "null" ]; then printf '%s' "$found"; return 0; fi
    sleep 10
    WAITED=$((WAITED + 10))
  done
  return 1
}

# The one shape every rewrite of server/Cargo.lock uses, written once so the
# command --dry-run prints is the command a real run runs. The lock file names
# every package; ours is the one under `name = "atelier"`.
LOCK_AWK='$0 == "name = \"atelier\"" { mine = 1 } mine && $0 == old { $0 = new; mine = 0 } { print }' 

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

# The one thing the messages cannot say is that a release is the 1.0: going to it
# is a decision about the project, not something any change in it implies. So
# --as exists — but it does not let a number be typed. It may only name one of
# the three steps up from the last release, and never a smaller one than the
# work asks for, which would ship a breaking change as a patch. Everything else,
# 9.9.9 included, is refused: the choice is how big the step is, never what the
# number is (bw-sinv.13).
if [ -n "$AS" ]; then
  case "$BUMP" in
    major) ALLOWED="$((MA + 1)).0.0" ;;
    minor) ALLOWED="$MA.$((MI + 1)).0 $((MA + 1)).0.0" ;;
    patch) ALLOWED="$MA.$MI.$((PA + 1)) $MA.$((MI + 1)).0 $((MA + 1)).0.0" ;;
  esac
  case " $ALLOWED " in
    *" $AS "*) ;;
    *) die "--as $AS is not a step this release can take.
      the work asks for $NEXT, and the only numbers allowed from $LAST are: $ALLOWED" ;;
  esac
  if [ "$AS" = "$NEXT" ]; then
    say "$NEXT is what the changes ask for anyway"
  else
    say "the changes ask for $NEXT; going to $AS instead because you asked for it"
    NEXT="$AS"
  fi
fi
[ "$NEXT" != "$LAST" ] || die "the next number is the one already released"
git rev-parse -q --verify "refs/tags/v$NEXT" >/dev/null \
  && stop "v$NEXT already exists here — a released number is never written twice"

# The files and the last tag should name the same release. When they do not,
# something was tagged without the five files being written — the build online
# under that name reports a different one, and the recipe cannot be filled in
# for it (it happened to v0.13.2). It is only said once the next number is
# known, because files saying something other than the last tag is also exactly
# what an interrupted run of this script leaves behind, and that is not a
# mistagged release but this release, half written (bw-sinv.9).
if [ "$NOW" != "$LAST" ] && [ "$NOW" != "$NEXT" ]; then
  say "note: the files here say $NOW while the last release is $LAST — that one went out under a name its build does not report"
fi

ok "next: $NEXT   (a $BUMP change on $LAST)"

# ── 3 of 7 ────────────────────────────────────────────────────────────────
step "3/7  The number, written in five places"

# Every one of these names the version, and nothing but this keeps them in step.
# server/Cargo.lock is here because a build machine reads it before the manifest;
# flake.nix is here because it names it twice and sat two releases behind once.
if [ "$NOW" != "$NEXT" ]; then
  say "package.json          $NOW → $NEXT"
  say "package-lock.json     $NOW → $NEXT   (twice)"
  say "server/Cargo.toml     $NOW → $NEXT"
  say "server/Cargo.lock     $NOW → $NEXT"
  say "flake.nix             $NOW → $NEXT   (twice)"
fi

if [ "$NOW" = "$NEXT" ]; then
  # A run that died after the writing step and is being started again. Writing
  # them a second time is not wrong, but the check below would then read the new
  # number as the old one still standing and stop a release that is fine.
  ok "the five already say $NEXT"
elif [ "$DRY_RUN" = 1 ]; then
  would "npm version --no-git-tag-version --allow-same-version $NEXT"
  would "sed -i \"0,/^version = \\\"$NOW\\\"/s//version = \\\"$NEXT\\\"/\" server/Cargo.toml"
  would "awk -v old='version = \"$NOW\"' -v new='version = \"$NEXT\"' '$LOCK_AWK' server/Cargo.lock > server/Cargo.lock.next && mv server/Cargo.lock.next server/Cargo.lock"
  would "sed -i \"s/version = \\\"$NOW\\\";/version = \\\"$NEXT\\\";/g\" flake.nix"
else
  npm version --no-git-tag-version --allow-same-version "$NEXT" >/dev/null \
    || die "npm would not write $NEXT into package.json and package-lock.json"

  # Only the first `version =` line, which is the package's own; a dependency
  # further down the file must not be touched.
  sed -i "0,/^version = \"$NOW\"/s//version = \"$NEXT\"/" server/Cargo.toml \
    || die "could not write $NEXT into server/Cargo.toml"

  awk -v old="version = \"$NOW\"" -v new="version = \"$NEXT\"" \
      "$LOCK_AWK" server/Cargo.lock > server/Cargo.lock.next \
    && mv server/Cargo.lock.next server/Cargo.lock \
    || die "could not write $NEXT into server/Cargo.lock"

  sed -i "s/version = \"$NOW\";/version = \"$NEXT\";/g" flake.nix \
    || die "could not write $NEXT into flake.nix"

  # awk and sed both finish happily having matched nothing, so a file whose
  # shape has drifted is left saying the old number while this step reports
  # success — which is how a build once went out under a name it never had.
  # Each of the five is read back where its number actually lives; a plain
  # search of the lock file would not do, because a dependency in it may
  # legitimately carry the number this release is leaving behind (bw-sinv.8).
  LEFT=""
  grep -q "\"version\": \"$NEXT\"" package.json      || LEFT="$LEFT package.json"
  grep -q "\"version\": \"$NEXT\"" package-lock.json || LEFT="$LEFT package-lock.json"
  grep -q "^version = \"$NEXT\"" server/Cargo.toml     || LEFT="$LEFT server/Cargo.toml"
  MINE=$(awk '$0 == "name = \"atelier\"" { mine = 1; next }
              mine && $0 ~ /^version = / { print; exit }' server/Cargo.lock)
  [ "$MINE" = "version = \"$NEXT\"" ]                  || LEFT="$LEFT server/Cargo.lock"
  if ! grep -q "version = \"$NEXT\";" flake.nix || grep -q "version = \"$NOW\";" flake.nix; then
    LEFT="$LEFT flake.nix"
  fi
  [ -z "$LEFT" ] || die "these do not say $NEXT:$LEFT"
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
  would "if it goes red on the frozen dependency list: write the hash that build asks for into flake.nix, push, and watch once more"
else
  git push --quiet origin "$SHA:$PUBLISHED" \
    || die "could not put the line online"
  ok "pushed $(git rev-parse --short "$SHA")"
  say "waiting for the checks online — this is what stops a tag being written on a red build"
  RUN=$(run_for CI headSha "$SHA") \
    || die "no build online ever picked up $SHA — look at $SOURCE/actions"

  if ! gh run watch "$RUN" -R "$SOURCE" --exit-status --interval 15 >/dev/null 2>&1; then
    # The one red a release causes rather than finds. Writing the new number
    # rewrites package-lock.json, and the flake pins a hash over what that lock
    # file fetches — so the number this release writes is the very thing that
    # makes the frozen list stale, on every release, for ever. The build says
    # which hash it wants. Writing that and pushing again is the whole repair,
    # and it is done once: a second red is a real one (bw-sinv.5).
    WANTED=$(gh run view "$RUN" -R "$SOURCE" --log-failed 2>/dev/null \
               | grep -aoE 'npmDepsHash = "sha256-[^"]+"' | tail -1 \
               | grep -aoE 'sha256-[^"]+')
    [ -n "$WANTED" ] \
      || die "the checks online went red on this commit, so no tag was written — gh run view $RUN -R $SOURCE --log-failed"

    say "the frozen dependency list went stale on the number this release wrote; it asks for $WANTED"
    sed -i -E "s#npmDepsHash = \"sha256-[^\"]+\";#npmDepsHash = \"$WANTED\";#" flake.nix \
      || die "could not write the hash into flake.nix"
    git add flake.nix || die "could not stage flake.nix"
    git commit --quiet -m "chore(packaging): the frozen dependency list, after $NEXT" \
      || die "could not save the hash the build asked for"
    SHA=$(git rev-parse HEAD)
    git push --quiet origin "$SHA:$PUBLISHED" \
      || die "could not put the repaired line online"
    ok "pushed $(git rev-parse --short "$SHA") with the hash the build asked for"

    RUN=$(run_for CI headSha "$SHA") \
      || die "no build online ever picked up $SHA — look at $SOURCE/actions"
    gh run watch "$RUN" -R "$SOURCE" --exit-status --interval 15 >/dev/null 2>&1 \
      || die "the checks online are still red with the hash it asked for, so no tag was written — gh run view $RUN -R $SOURCE --log-failed"
  fi
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
  would "if it goes red: gh run rerun <that build> --failed, then watch it once more"
else
  ok "v$NEXT is online, and the built files are being made"
  RUN=$(run_for Release headBranch "v$NEXT") \
    || die "no build ever picked up v$NEXT — look at $SOURCE/actions"
  if ! gh run watch "$RUN" -R "$SOURCE" --exit-status --interval 20 >/dev/null 2>&1; then
    # Once in a while the far end simply drops one of the built files on its way
    # up and hands back an error page. Nothing here is wrong, and there is
    # nothing to fix — so ask the parts that died to run again, once, the same
    # way the frozen dependency list is repaired once above. A second red is
    # somebody's real fault and still stops the release.
    say "the release build went red; asking the parts that died to run again, once"
    gh run rerun "$RUN" -R "$SOURCE" --failed >/dev/null 2>&1 \
      || die "the release build went red and would not run again — the tag is online but there is nothing to install; gh run view $RUN -R $SOURCE --log-failed"
    sleep 15
    gh run watch "$RUN" -R "$SOURCE" --exit-status --interval 20 >/dev/null 2>&1 \
      || die "the release build went red twice — the tag is online but there is nothing to install; gh run view $RUN -R $SOURCE --log-failed"
    ok "it went green the second time"
  fi
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
