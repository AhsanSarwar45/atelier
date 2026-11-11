# Provider hooks

Atelier wires one hook into a project's providers: `atelier hook doing`. It
records what a chat is doing (working, waiting, compacting, done) so the app can
show it, and never refuses anything.

## Retired hooks

Earlier versions wired the Beads board's gates into every project —
`workflow-gate`, `board-actor`, `board-status-gate`, `board-merge-gate`,
`landing-gate`, `board-gate`, `board-touch`, `board-prime`, `board-push`,
`wait-gate` and `completion-gate` — plus a git landing guard. The board is gone,
and so are they.

- `atelier hook <any other name>` still runs: it reads its input and exits 0
  with no output, so a provider that still has an old entry carries on as if
  the hook allowed the call.
- Atelier takes its own retired entries out of `.claude/settings.json` and
  `.codex/hooks.json`, removes them from its Goose plugin, and removes the git
  landing guard. It does this for every registered project when the server
  starts, when a project is opened or initialized, and on `atelier init`
  (`server/src/join.rs`). Entries Atelier did not write are left alone, and a
  settings file that does not parse is left unchanged.

## Changing a hook

Change the decision in `server/src/doing.rs` and its regression test together,
and check the binary actually on the provider's PATH, not just the source.
Never test against the owner's app or data.
