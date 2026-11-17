#!/bin/sh
# The Grids guidance and the grids spec describe cell steps and cell
# prerequisites. Prints the first thing missing and exits 1, or prints ok.
skill=machinery/skills/tasks/SKILL.md
spec=docs/grids.md
need() {
  grep -qF -- "$2" "$1" || { echo "MISSING in $1: $2"; exit 1; }
}
need "$skill" "open → red → work → proved"
need "$skill" '"cells":[{"row":'
need "$skill" "Step:"
need "$spec" "open → red → work → proved"
need "$spec" '"cells":[{"row":'
echo ok
