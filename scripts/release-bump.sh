#!/usr/bin/env bash
#
# How big a step the next release takes, read out of the work since LAST.
#
#   bash scripts/release-bump.sh v0.22.29     # prints major, minor or patch
#
# A breaking change raises the first number: a subject marked `type!:`,
# `type(scope)!:` or `CARD-ID!:`, or `BREAKING CHANGE` in a body. A feature raises the second.
#
# Commits here are named after the card they finish (`bw-q8ehk.1: outcome`),
# not `feat:`, so a feature is known by its card: one labelled `kind:feature`,
# or of type feature. Reading only `feat:` subjects made every release a
# patch, 0.22.0 through 0.22.29 (bw-4c76n.1). A `feat:` subject still counts.
#
# Why each step was chosen goes to stderr, so the release shows its reason.

set -uo pipefail

FROM=${1:?usage: release-bump.sh LAST-TAG}

SUBJECTS=$(git log "$FROM..HEAD" --format='%s')
BODIES=$(git log "$FROM..HEAD" --format='%b')

if printf '%s\n' "$SUBJECTS" | grep -qE '^[^:]*!:' \
   || printf '%s\n' "$BODIES" | grep -q 'BREAKING CHANGE'; then
  echo "  a change is marked as breaking" >&2
  echo major
  exit 0
fi

if printf '%s\n' "$SUBJECTS" | grep -qE '^feat(\([^)]*\))?:'; then
  echo "  a change is marked feat:" >&2
  echo minor
  exit 0
fi

# Every card named before a subject's first colon: `bw-a.1: …`,
# `bw-a.1 bw-a.2: …` and `fix(bw-a.1): …` alike.
CARDS=$(printf '%s\n' "$SUBJECTS" \
  | sed -n 's/^\([^:]*\):.*/\1/p' \
  | grep -oE '\b[a-z]+-[a-z0-9]+(\.[0-9]+)*\b' \
  | sort -u)

# Prints the cards in a `bd show --json` reply that are features. With
# `--parents`, prints the jobs of the cards that are not, to be asked in turn.
features_in() {
  node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => {
      let cards = JSON.parse(text || "[]");
      if (!Array.isArray(cards)) cards = [cards];
      const feature = (card) =>
        card.issue_type === "feature" || (card.labels || []).includes("kind:feature");
      const chosen = process.argv[1] === "--parents"
        ? [...new Set(cards.filter((card) => card && !feature(card) && card.parent).map((card) => card.parent))]
        : cards.filter((card) => card && feature(card)).map((card) => card.id);
      console.log(chosen.join(" "));
    });' -- "$@"
}

FEATURES=""
if [ -n "$CARDS" ]; then
  # A card is a feature when it says so or when its job does.
  # shellcheck disable=SC2086 # one card per word
  if SHOWN=$(bd show $CARDS --json 2>/dev/null); then
    FEATURES=$(printf '%s' "$SHOWN" | features_in)
    JOBS=$(printf '%s' "$SHOWN" | features_in --parents)
    if [ -z "$FEATURES" ] && [ -n "$JOBS" ]; then
      # shellcheck disable=SC2086
      if JOBS_SHOWN=$(bd show $JOBS --json 2>/dev/null); then
        FEATURES=$(printf '%s' "$JOBS_SHOWN" | features_in)
      else
        echo "  ! the board could not be read, so no job could say it is a feature" >&2
      fi
    fi
  else
    echo "  ! the board could not be read, so no card could say it is a feature" >&2
  fi
fi

if [ -n "$FEATURES" ]; then
  set -- $FEATURES
  if [ $# -gt 5 ]; then
    echo "  $# features shipped, among them $1 $2 $3 $4 $5" >&2
  else
    echo "  features shipped: $*" >&2
  fi
  echo minor
  exit 0
fi

echo "  no change is a feature or breaking" >&2
echo patch
