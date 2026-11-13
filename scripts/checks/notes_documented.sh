#!/bin/sh
# Notes are documented for the owner and for agents, and the CLI offers them.
missing=""
has() { grep -q -- "$2" "$1" 2>/dev/null || missing="$missing\n  $1 lacks \"$2\""; }
has docs/grids.md 'atelier grid note'
has docs/tasks.md 'atelier task note'
has machinery/skills/tasks/SKILL.md 'atelier grid note'
has machinery/skills/tasks/SKILL.md 'atelier task note'
has server/src/workbench/grids/cli.rs 'note SLUG'
has server/src/workbench/tasks/cli.rs 'note N'
if [ -n "$missing" ]; then printf "notes FAILED: not documented:$missing\n"; exit 1; fi
echo "notes documented"
