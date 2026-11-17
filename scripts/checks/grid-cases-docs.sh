#!/bin/sh
# The Grids guidance and the grids spec describe cases, the coverage review,
# the owner's row approval, the CASE line and "Needs cases". Prints the first
# thing missing and exits 1, or prints ok.
cd "$(dirname "$0")/../.." || exit 1
skill=machinery/skills/tasks/SKILL.md
spec=docs/grids.md
need() {
  grep -qF -- "$2" "$1" || { echo "MISSING in $1: $2"; exit 1; }
}
for file in "$skill" "$spec"; do
  need "$file" "cases → reviewed → approved → red → work → proved"
  need "$file" "atelier grid cases"
  need "$file" "atelier grid review"
  need "$file" "CASE <grid>/<row>/<col>/<case> PASS|FAIL"
  need "$file" "atelier case"
  need "$file" "Needs cases"
  need "$file" "{row}"
done
need "$spec" "Approve cases"
need "$spec" "3 rounds"
echo ok
