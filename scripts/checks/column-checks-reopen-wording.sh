#!/usr/bin/env bash
# The column-checks draft reply and CLI help must say that approving new
# checks reopens the column's proved cells, not that proofs stay.
cd "$(dirname "$0")/../.."
fail=0
if grep -n "proofs stay as they are" server/src/workbench/grids/mod.rs server/src/workbench/grids/cli.rs; then
  echo "FAIL: claims proofs stay as they are"; fail=1
fi
for f in server/src/workbench/grids/mod.rs server/src/workbench/grids/cli.rs; do
  grep -q "proved cells.*reopen\|reopens.*proved cells" "$f" || { echo "FAIL: $f does not say proved cells reopen"; fail=1; }
done
[ $fail = 0 ] && echo PASS
exit $fail
