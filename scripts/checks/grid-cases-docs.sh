#!/bin/sh
# The Grids guidance and the grids spec describe cases, the coverage review,
# that no one approves cases, the CASE line and "Needs cases". Prints the first
# thing missing and exits 1, or prints ok.
cd "$(dirname "$0")/../.." || exit 1
skill=machinery/skills/tasks/SKILL.md
spec=docs/grids.md
need() {
  grep -qF -- "$2" "$1" || { echo "MISSING in $1: $2"; exit 1; }
}
for file in "$skill" "$spec"; do
  need "$file" "cases → reviewed → red → work → proved"
  need "$file" "atelier grid cases"
  need "$file" "atelier grid review"
  need "$file" "CASE <grid>/<row>/<col>/<case> PASS|FAIL"
  need "$file" "atelier case"
  need "$file" "Needs cases"
  need "$file" "{row}"
done
need "$spec" "3 rounds"
echo ok
