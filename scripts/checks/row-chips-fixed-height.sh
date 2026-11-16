#!/usr/bin/env bash
# Every chip on a sidebar row's status line is drawn at one fixed height, so a
# chip carrying a detail and a clock ("Running qa.cjs … 8s") is no taller than
# one with a single word ("Answering").
set -euo pipefail
f="$(cd "$(dirname "$0")/../.." && pwd)/src/workbench/chat-sidebar.tsx"
fail=0
for id in row-pill row-workflow-stage row-waiting; do
  for line in $(grep -n "testId=\"$id\"\|data-testid=\"$id\"" "$f" | cut -d: -f1); do
    # The chip's class list is on the same line or within the next few.
    if ! sed -n "${line},$((line + 3))p" "$f" | grep -q "\bh-5\b"; then
      echo "chip $id (line $line) has no fixed height"; fail=1
    fi
  done
done
grep -q 'row-line-status' "$f" && sed -n '/data-testid="row-line-status"/,/data-testid="row-pill"/p' "$f" | grep -q 'flex-wrap' \
  || { echo "row status line does not wrap"; fail=1; }
exit $fail
