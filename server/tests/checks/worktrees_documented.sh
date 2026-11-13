#!/bin/sh
# The workbench guide explains the worktree badge: its size, moving a chat to
# another worktree, and deleting one.
cd "$(dirname "$0")/../../.." || exit 2
fail=0
has() { grep -qF -- "$2" "$1" || { echo "docs FAILED: $1 does not mention: $2"; fail=1; }; }
has docs/agent-workbench.md 'worktree badge'
has docs/agent-workbench.md 'Move here'
has docs/agent-workbench.md 'Delete worktree'
[ "$fail" = 0 ] && echo ok
exit $fail
