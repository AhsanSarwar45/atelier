#!/bin/sh
# The five gap fixes are documented where agents and owners read them.
fail=0
need() { grep -q -- "$2" "$1" || { echo "docs FAILED: $1 does not mention: $2"; fail=1; }; }
need docs/grids.md 'atelier grid checks'
need docs/grids.md 'watch'
need docs/tasks.md 'mutants'
need docs/tasks.md 'weak-checks'
need docs/tasks.md 'test folder'
need machinery/skills/tasks/SKILL.md 'atelier grid checks'
need machinery/skills/tasks/SKILL.md 'mutants'
need server/src/workbench/grids/cli.rs 'checks SLUG'
[ $fail = 0 ] && echo ok
exit $fail
