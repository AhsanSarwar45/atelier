#!/bin/sh
# Nothing grid-related waits for the owner, and no cell depends on a task.
# The grid code, the Grids screens, the Grids guidance and the grids spec
# carry no grid approval and no claim rule. Prints the first leftover and
# exits 1, or prints ok.
cd "$(dirname "$0")/../.." || exit 1
paths="server/src/workbench/grids server/src/routes/workbench/grids.rs server/src/workbench/references.rs server/src/workbench/waiting.rs src/workbench/grids src/workbench/waiting-bar.tsx machinery/skills/tasks/SKILL.md docs/grids.md"
for word in "awaiting the owner" "waiting for the owner" "the owner approves" "owner approved" "for the owner to approve" "Awaiting approval" \
  "approve_na" "reject_na" "approve_template" "reject_template" "grid_draft" "grid-approve" "grid-discard" "cell-approve-na" "cell-reject-na" \
  "only the chat holding that task" "fixed while a task works it" "approved grid" "red → work" "Taken by other tasks" "claimable"; do
  found=$(grep -rnF -- "$word" $paths 2>/dev/null | grep -v '_tests\.rs:' | grep -v '/tests\.rs:' | grep -v '__tests__' | head -1)
  [ -n "$found" ] && { echo "LEFTOVER: $found"; exit 1; }
done
for file in machinery/skills/tasks/SKILL.md docs/grids.md; do
  grep -qF -- "belong to the project, not to a branch" "$file" || { echo "MISSING in $file: how grids work across branches"; exit 1; }
done
echo ok
