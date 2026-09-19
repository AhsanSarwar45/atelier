# Lifecycle hooks

The lifecycle contract is [board-lifecycle.md](board-lifecycle.md).

| Hook | Responsibility |
| --- | --- |
| workflow-gate | Preserve explicit cwd and patch paths; require an owned descendant in the job worktree for repository writes |
| board-actor | Stamp the full session actor on Beads and native workflow commands |
| board-status-gate | Validate every named card; protect manager decisions; Done comes from landing |
| board-merge-gate | Give early feedback for unsafe merges and overlapping dirty paths |
| landing-gate | Parse Git reference transactions; require fast-forward, prepared journal, exact-tree checks and owned merge slot |
| board-gate | Owned active work must continue or become explicitly blocked with evidence |
| board-touch | Throttled heartbeat and interrupted-landing/parent reconciliation |
| board-prime | Explain the actor and ready work at session start |
| board-push | Persist board changes at session end |

Claude, Codex and Goose use the same native decisions with provider-specific
matchers. Codex accepts cmd and command inputs; freeform patches include every
add/update/delete/move target. File descriptor duplication names no file.

## When a gate is wrong

Use `ATELIER_BYPASS='specific reason' COMMAND` only for the refused command.
The bypass is logged. Session identity stamping still runs: a bypassed claim
and its later ordinary landing must use the same actor. This applies to Claude
`command`, Codex `cmd`, environment switches and marker files. Add the real
refusal to either hook-friction journal.
Do not export a standing bypass. Tests strip inherited bypasses. Unknown hook
names fail visibly; explicitly retired presentation hooks remain compatible.

## Changing a gate

Update the native decision, provider config, embedded Beads skill and regression
fixture together. Exercise the installed-format binary with real provider
payloads and a disposable Git/Beads repository. A source-only test does not
prove that the currently installed binary has changed. Never test against the
owner's app or data. Review the dry-run before repairing historical tickets.

Protocol 4 fixes dispatcher-level bypass identity loss. Check the executable
actually on the agent's PATH with `atelier hook workflow-gate --version`; the
application version alone cannot distinguish hook revisions.
