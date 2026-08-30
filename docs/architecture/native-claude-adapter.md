# Native Claude Code adapter

Atelier drives the user's installed `claude` executable directly. It does not
embed Claude Code, fetch an SDK at runtime, or ask for an Anthropic API key.
The provider therefore uses the same login, settings, skills, commands, MCP
servers, hooks, and durable conversation records as Claude Code in a terminal.

## Why the adapter is in-tree

The Rust crate named `claude-sdk` is a client for Anthropic's Messages HTTP API.
It is not a Claude Code session client and cannot reuse Claude Code login or
resume its local conversations. The viable Claude Code wrapper crates were also
audited. They either downloaded their own provider binary, buffered a complete
turn rather than exposing the live stream, discarded unknown event variants, or
omitted controls already exposed by Atelier (permissions, questions, plans,
models, effort, compaction, and sent-off work).

The adapter therefore keeps the small unstable boundary as raw newline-delimited
JSON. The subprocess transport owns exactly one kill-on-drop child, correlates
control responses, forwards provider-initiated requests, and preserves unknown
messages for the normalizer instead of losing them behind a closed enum.

## Boundaries

- `transport.rs` owns stdin/stdout/stderr, request correlation, initialization,
  timeouts, and exact-child shutdown.
- `history.rs` discovers UUID-named JSONL records, filters them by their recorded
  working directory, and rebuilds words, images, tools, context, deduplicated
  usage, settings, and subagent conversations.
- `live.rs` translates the live stream and control requests to the existing
  provider-neutral workbench protocol. Unknown provider events become diagnostic
  notes containing the original payload.
- `session.rs` starts the provider before committing the chat row, then sends
  every normalized event through the single durable database actor. Resume
  history enters that same event log.

The adapter never uses `--bare` and removes an inherited `CLAUDECODE` marker so
Atelier is an independent host rather than an accidentally nested CLI session.
It opts into partial messages, hook events, strict MCP configuration, and the
user/project/local settings cascade. Permission bypass is available only as an
explicit mid-session mode; launch merely enables the provider to honor that
later choice.

## Verification

The `native_claude` Rust tests use deterministic pretend provider processes.
They cover command construction, initialization and control correlation,
malformed and unknown frames, streaming and fallback messages, permissions,
questions, plans, history and helper reconstruction, startup failure without an
orphan database row, resume identity, database reopen, and `/proc` confirmation
that shutdown reaped only the owned child. Existing provider-conformance tests
hold the browser-facing contract shared with the former TypeScript driver.

Public Axum route cutover and deletion of the legacy Node helper belong to the
parent runtime-independence job, after both provider adapters and shared store
were independently proven.
