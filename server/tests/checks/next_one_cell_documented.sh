#!/bin/sh
# One-cell grid next, its order and `after`, and --batch are documented and in the CLI help.
fail=0
need() { grep -q -- "$2" "$1" || { echo "docs FAILED: $1 does not mention: $2"; fail=1; }; }
need docs/grids.md 'hands out one cell at a time'
need docs/grids.md 'atelier grid order'
need docs/grids.md '"after"'
need docs/grids.md '--batch'
need machinery/skills/tasks/SKILL.md 'atelier grid order'
need machinery/skills/tasks/SKILL.md '--batch'
need server/src/workbench/grids/cli.rs 'order SLUG'
need server/src/workbench/grids/cli.rs '--batch N'
[ $fail = 0 ] && echo ok
exit $fail
