# Executable hook dispatcher repair — bw-9vv9.6

The manager reinstalled Atelier and a new session still recorded friction.
The previous completion claim was too broad: tests called native lifecycle
functions or supplied one actor directly, omitting the executable dispatcher's
bypass handling and the execution of its rewritten commands.

## Reproduced defects

1. The installed 0.22.8 protocol-3 dispatcher returned early on a Claude bypass,
   skipping board-actor. The resulting claim used the Git user while later
   unbypassed native landing used the session, producing an ownership refusal.
2. Command-local bypass recognition read `command` but not Codex `cmd`, making
   the two providers behave differently.
3. Real Git/Beads integration inside the job copy exposed worktree lookup taking
   the outermost `worktrees/` component, refusing the inner repository's job.
4. Executing a rewritten native command with a quoted executable path failed:
   the lexer overwrote the opening quote's position, so actor stamping inserted
   the environment assignment inside the executable name.

The installed executable accepted the ordinary child-in-job claim tested here.
The older exact-card refusal quoted in the friction report was not reproduced
against this executable. That portion is not explained away as installation
error; its original session/executable provenance remains unknown.

## Repair

Identity stamping now runs before bypass handling, including environment switches
and marker files. The bypass still excuses gates and is logged, but cannot turn
one session into another owner. Both command keys are understood. Nested job
lookup uses the innermost worktree. Lexer token positions retain opening quotes
and escapes, allowing the rewritten command to execute correctly.

Both Beads skill copies and the hook documentation state the same rule.
`atelier hook workflow-gate --version` reports protocol 4 for the repair. The
application version alone (0.22.8) does not distinguish these hook revisions.

## Verification scope

- `server/tests/hook_identity.rs` invokes the executable dispatcher for Claude and
  Codex; normal and legacy hook names; command, environment, switch and marker
  bypasses; native and bd identity; both quote styles; impersonation rejection.
- `tests/native-landing.mjs` executes actual hook replies in disposable Git/Beads
  repositories. Each provider claims two children in one job copy (ordinary and
  bypassed), checks ownership for writes, commits, lands without bypass, and
  reaches Done on both children and parent. Quoted native binary paths are run.
- The lifecycle unit suite covers 56 cases, including nested worktree lookup.
- Production frontend build and declared project checks are required before land.
- An initial full Rust run failed the unrelated Dolt retry test (one call instead
  of two). That test passed alone and the complete Rust rerun passed; the original
  failure log is retained with the audit evidence.

The original installed-binary reproduction, including executable SHA-256 and
provider events, is in [the JSON record](hook-dispatch-2026-09-19.json). Run logs
are archived under `.git/atelier-audits/bw-9vv9-six` after landing.

No interface was changed. The owner's running app, installed binary and shared
runtime configuration were not replaced by this repair. AGENTS.md prohibits
those changes; installing the repaired build remains a separate runtime action.
