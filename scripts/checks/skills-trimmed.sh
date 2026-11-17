#!/usr/bin/env bash
# The two skills every session carries stay short, and keep every phrase the
# other documentation checks and tests require of them.
cd "$(dirname "$0")/../.." || exit 1
fail=0
limit() {
  words=$(wc -w < "$1")
  if [ "$words" -gt "$2" ]; then echo "TOO LONG: $1 has $words words; the limit is $2"; fail=1; else echo "ok: $1 has $words words (limit $2)"; fi
}
limit machinery/skills/tasks/SKILL.md 1800
limit machinery/skills/atelier/SKILL.md 560
for check in scripts/checks/notes_documented.sh scripts/checks/grid-steps-docs.sh \
  server/tests/checks/next_one_cell_documented.sh server/tests/checks/nothing_locked_documented.sh \
  server/tests/checks/amend_applies_documented.sh; do
  bash "$check" > /tmp/skills-trimmed.$$ 2>&1 || { echo "LOST: $check failed:"; cat /tmp/skills-trimmed.$$; fail=1; }
done
rm -f /tmp/skills-trimmed.$$
exit $fail
