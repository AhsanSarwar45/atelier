# Agent Instructions

Every non-trivial change needs to be tested end to end using chrome in a realistic environment. Any test projects should be deleted after testing

## Enforced board lifecycle

Do not rely on an agent voluntarily following the merge and review lifecycle.
Instructions must state the lifecycle, and provider-equivalent hooks must
prevent closing or advancing work before its worktree changes are committed
and merged. A permissive `bd` CLI is not authorization to bypass the project
workflow.

## Isolated app instances

Each worktree must use its own disposable app stack. Never touch the owner's
app, backend, helper, data, or port 3008.

```bash
export BEADS_WEB_PORT="<unique-free-port>"
export ATELIER_PORT="$BEADS_WEB_PORT"
export BEADS_WORKBENCH_PORT="<different-unique-free-port>"
export WORKBENCH_E2E_RUN="$PWD/tests/.e2e-run-<job-id>"
scripts/workbench-e2e.sh <spec> [playwright arguments]
```

- Probe both ports immediately before startup; fail if either is occupied.
- Keep data, config, sessions, fixtures, and processes worktree-local.
- Cleanup only recorded child PIDs and the two allocated ports.
- Never use `pkill`, `killall`, process-name cleanup, or shared/default ports.
- Afterward, verify both ports are free.
