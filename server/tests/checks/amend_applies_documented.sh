#!/bin/sh
# Plan changes apply at once: the docs, the tasks skill and the CLI help say
# so, and none still tells an agent to wait for the owner's approval.
cd "$(dirname "$0")/../../.." || exit 2
fail=0
has() { grep -qF -- "$2" "$1" || { echo "docs FAILED: $1 does not mention: $2"; fail=1; }; }
lacks() { ! grep -qF -- "$2" "$1" || { echo "docs FAILED: $1 still says: $2"; fail=1; }; }
has docs/tasks.md 'applies at once'
has docs/tasks.md 'may weaken'
has docs/tasks.md 'undo_amend'
has machinery/skills/tasks/SKILL.md 'applies at once'
has machinery/skills/tasks/SKILL.md 'may weaken'
lacks machinery/skills/tasks/SKILL.md "Wait for the owner; don't work around it"
lacks machinery/skills/tasks/SKILL.md 'run `amend`. The owner approves it.'
has server/src/workbench/tasks/cli.rs 'applies at once'
lacks server/src/workbench/tasks/cli.rs 'wrong or impossible as approved; the owner approves it'
[ "$fail" = 0 ] && echo ok
exit $fail
