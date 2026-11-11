#!/usr/bin/env bash
#
# How big a step the next release takes, read out of the work since LAST.
#
#   bash scripts/release-bump.sh v0.22.29     # prints major, minor or patch
#
# A breaking change raises the first number: a subject marked `type!:`,
# `type(scope)!:` or `ID!:`, or `BREAKING CHANGE` in a body. A `feat:` subject
# raises the second. A feature shipped under any other subject is released
# with `scripts/release.sh --as`, which takes a bigger step than this one reads.
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

echo "  no change is a feature or breaking" >&2
echo patch
