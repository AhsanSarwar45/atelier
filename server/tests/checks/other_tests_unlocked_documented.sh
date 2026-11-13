#!/bin/sh
# The docs and the tasks skill say other test files in a check's folder are
# not locked with it.
cd "$(dirname "$0")/../../.." || exit 2
fail=0
has() { grep -qF -- "$2" "$1" || { echo "docs FAILED: $1 does not mention: $2"; fail=1; }; }
has docs/tasks.md 'other test files'
has machinery/skills/tasks/SKILL.md 'other test files'
[ "$fail" = 0 ] && echo ok
exit $fail
