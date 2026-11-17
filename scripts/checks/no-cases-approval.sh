#!/bin/sh
# No one approves a grid's cases: a clean review readies a cell. The server,
# the front end, the Grids guidance and the grids spec carry no cases
# approval. Prints the first leftover and exits 1, or prints ok.
cd "$(dirname "$0")/../.." || exit 1
skill=machinery/skills/tasks/SKILL.md
spec=docs/grids.md
for word in approve_cases "Approve cases" "approves a whole row" "owner decides" "approve_row"; do
  found=$(grep -rnF -- "$word" server/src src "$skill" "$spec" 2>/dev/null | grep -v "fn the_owner_has_no_cases_approval" | grep -v 'request("approve_cases")' | grep -v 'contains("approve_cases")' | grep -v '`approve_cases` is not an action' | head -1)
  [ -n "$found" ] && { echo "LEFTOVER: $found"; exit 1; }
done
for file in "$skill" "$spec"; do
  grep -qF -- "order → cases → reviewed → red → work → proved" "$file" || { echo "MISSING in $file: order → cases → reviewed → red → work → proved"; exit 1; }
done
echo ok
