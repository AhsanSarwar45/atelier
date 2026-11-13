#!/bin/sh
# The docs and the agents' task skill say nothing is locked, and no longer
# tell agents about the "approved check file changed" refusal.
cd "$(dirname "$0")/../../.." || exit 1
status=0
for file in docs/tasks.md docs/grids.md machinery/skills/tasks/SKILL.md; do
  if grep -q "approved check file changed" "$file"; then
    echo "STILL LOCKED: $file mentions the 'approved check file changed' refusal"
    status=1
  fi
  if ! grep -q "Nothing is locked" "$file"; then
    echo "STILL LOCKED: $file does not say 'Nothing is locked'"
    status=1
  fi
done
[ "$status" = 0 ] && echo "docs: nothing is locked"
exit $status
