# ACP transport

Atelier uses Agent Client Protocol as the live control transport for Claude Code,
Codex and local models through a pinned Goose server. ACP is an adapter boundary, not the transcript store or the browser
wire protocol. Provider-specific ACP messages are translated once into the
canonical Workbench Protocol (WBP); every screen, history page, search index,
status line and sidebar consumes that same provider-neutral representation.

## Runtime shape

The Homebrew and release archives contain seven executable files:

- `atelier`, the React frontend embedded in the Rust server;
- `atelier-adapters/claude-acp` and `claude-provider`;
- `atelier-adapters/codex-acp`, `codex-provider`, and `codex-code-mode-host`.
- `atelier-adapters/goose-acp`, the Rust ACP harness for local model runtimes.

The adapters are compiled into standalone executables with Bun at release build
time. Bun, Node, npm, npx and Python are not invoked, downloaded or required on
the user's computer. The native provider executables use the user's existing
Claude Code and Codex authentication and subscription. Atelier does not add an
API charge; any provider usage has the same account and billing consequences as
using that provider directly.

Release inputs are exact, audited pins:

| component | pin |
| --- | --- |
| Rust `agent-client-protocol` SDK | 2.0.0 with stable v1, draft-v2 types, end-turn usage and elicitation |
| Claude ACP adapter | 0.70.0, commit `d0aafb1ca26427285ffaeac8d8a4452fff28e9c3` |
| Claude native provider | 0.3.232 |
| Codex ACP adapter | 1.7.0, commit `2b48e9822330fc09f3a94a81563e5c4bb779601a` |
| Codex native provider | 0.148.0 |
| Goose local ACP harness | 1.41.0, commit `39c27c387d726ce4605108d2f974d4feec158ed5` |
| build-time Bun compiler | 1.3.13 |

The pinned Codex adapter predates three requirements of Atelier's pinned Codex
integration: it omits `--stdio`, removes the JSON-RPC 2.0 marker, and has no
standard field for Atelier's shared session policy. The build applies three
exact, fail-closed source patches. The policy patch reads only
`_meta.atelier.sessionPolicy` and merges it into Codex's
`developer_instructions` configuration for new, resumed and loaded sessions.
If any upstream source shape
changes, the release fails and requires a new audit. The manifest records these
patches and the SHA-256 of every executable.

Both published adapters currently negotiate ACP wire protocol 1. Their shared
TypeScript SDK reports `PROTOCOL_VERSION = 1`; Codex's separately named
app-server v2 API is not ACP v2. Atelier therefore speaks stable ACP v1 today.
The Rust crate compiles the draft-v2 schema, but using it before the adapters
support it would make initialization fail. The release builder checks the
adapter wire version and fails closed if it changes, forcing the connector,
normalizer and real-provider suite to be upgraded together. Codex ACP v2 is
still an unmerged upstream pull request at the time of this pin.

## One provider-neutral path

`server/src/workbench/acp/client.rs` owns the ACP connection and implements the
same `SessionFactory` and `ProviderDriver` interfaces as every other transport.
`server/src/workbench/acp/normalize.rs` is the only ACP-to-WBP translation.
Neither the registry, database, HTTP/WebSocket routes nor React code branches on
Claude versus Codex transcript semantics.

The mapping covers:

- session creation, resume, close, cancellation and mid-turn steering;
- streamed user, assistant and thinking content;
- tools, progress, results, images and diffs;
- permission requests, plans, structured forms and URL elicitation;
- model, effort, permission-mode, collaboration-mode and arbitrary provider-announced
  boolean/select option catalogs and changes (including Codex Fast mode);
- slash commands and later command-catalog updates;
- provider, project and client-supplied MCP servers, with ACP additions merged
  into rather than replacing each agent's own configured servers;
- context occupancy, canonical USD charges when supplied, and cumulative end-of-turn token usage;
- native subagent lifecycle, child transcript attribution and controls;
- lossless preservation of unknown extension messages as machine-detail notes.

The current released Codex adapter's full announced surface stays enabled:
text and image prompts, reasoning and plans, shell and terminal output, file
changes, permissions, MCP tools, web search, image generation and viewing,
reviews, slash commands, current model/effort/Fast-mode controls, native
subagent identity and activity, token usage and typed provider failures. These
all cross the same canonical events as equivalent features from other agents;
Codex names appear only in the ACP extension normalizer where the standard has
no equivalent yet.

User prompts are persisted before transport and their ACP echo is suppressed,
so one prompt produces one visible user message. Every provider event receives
a unique delivery identity before append, and the database enforces idempotent
replay. Command-catalog updates replace only commands; they cannot erase the
negotiated model, effort or mode catalogs.

The Atelier session policy is rebuilt from the current project on every
connection. A provider-neutral copy travels in `_meta.atelier.sessionPolicy`.
Claude receives the same text through its supported preset-system-prompt append
field, Codex through the pinned fail-closed adapter bridge, and Goose through
its keyed system-prompt extension. The policy is never inserted as a visible
user message and is refreshed for new, resumed and loaded sessions.

ACP session requests keep their MCP server arrays on creation, resume and load.
Claude merges those entries with user, project and local settings; Codex merges
them with its loaded configuration and deduplicates name conflicts; Goose adds
them to its enabled extensions. Empty client arrays do not disable an agent's
own configured MCP servers. MCP tool calls and results still enter the same
canonical tool events and React renderers as built-in tools.

Claude's ACP adapter owns the same live SDK query that previously answered the
rich context-window panel. Atelier's pinned build exposes that existing
`getContextUsage()` result through a narrow `_atelier/session/window-now`
request, recorded as the `atelier-context-window` compatibility patch. The Rust
driver asks through its provider-neutral `window_now` interface. Agents that do
not expose a detailed breakdown continue to say so explicitly; Atelier does not
invent memory-file, deferred-tool or MCP-token weights from aggregate totals.

ACP v2 does not make every extension universal. The standard capability
handshake is authoritative for standard features. Native subagent sessions,
Claude parent metadata, collaboration modes and some usage detail arrive via
the adapter extensions that advertise or emit them. Recognized extensions map
to the same WBP events; unknown extensions remain durable `provider.message`
events instead of being discarded. Aggregate usage is exactly what the provider
reports. Per-child usage is shown only when the provider supplies it, never
invented by Atelier.

## Local models

The New Chat dialog keeps its existing provider-level choice: Claude, Codex or
Local Models. Ollama and OpenAI-compatible llama.cpp servers are execution
runtimes, not model brands. A new local chat is created without launching a
model; its ordinary composer model picker is filled from bounded, read-only
`/api/tags` and `/v1/models` discovery. Choosing a model pins an opaque runtime
locator, and the bundled Goose process starts on the first prompt. Opening a
new chat therefore never arbitrarily loads a multi-gigabyte model.
The developer and summon extensions are enabled explicitly, giving models that
can call tools the bundled file/shell/edit tools and Goose subagents. Models
that cannot call tools remain usable for conversation; Atelier does not enable
the experimental toolshim or claim agent capability it has not demonstrated.

Goose advertises the current runtime's model inventory through ACP session
config options. A model change uses the exact config-option id and value the
agent advertised. Goose recreates its provider client while retaining the
session conversation. Ollama may need to unload/load weights on the next turn;
a single-model llama.cpp server cannot switch to weights it does not serve,
while an OpenAI-compatible multi-model router can.

Visible identity belongs to the model, not the runtime. Ollama
`details.family`/`families` and OpenAI-compatible `owned_by` metadata are carried
with each catalog entry. The frontend uses that first, then exact known id-family
aliases, and otherwise a neutral local-model mark. It never guesses a publisher
for an unknown alias. Runtime locators are stripped from visible labels.

## Transcript and resume contract

ACP resume can replay provider history into the Rust backend. It never sends an
entire conversation to React. Provider records remain the durable source for
external conversations; Atelier's SQLite database is a local canonical index
and live event journal used for fast paging, search, status, deduplication and
crash recovery.

An opening snapshot contains only the newest 40 complete visible transcript
items, current session facts and projected agents. The database finds those
items from indexed event anchors and folds only the bounded event suffix needed
to complete them. Hidden detail notes and non-transcript state do not enter that
fold. Scrolling to the top requests the preceding 40 items with an opaque cursor;
app-owned and external chats use the identical endpoint and reducer. Provider
record reconciliation begins after the stored page has been queued, and its
new events arrive on the already-subscribed live tail.

The database is therefore not an extra transcript source and never requires a
full replay for first paint. Removing it would move indexing, deduplication,
search, status projection and provider reconciliation onto every browser read,
making correctness and latency worse.

## Performance gates

Release validation uses real browser interaction, not only route timing:

| operation | required |
| --- | --- |
| warm chat click | p95 at most 150 ms; p99 at most 250 ms |
| indexed cold click | p95 at most 250 ms; p99 at most 500 ms |
| first uncached provider import | p95 at most 500 ms; p99 at most 750 ms |
| older 40-item backend page | p95 at most 100 ms; p99 at most 200 ms |
| received ACP frame to visible DOM | p95 at most 50 ms; p99 at most 100 ms |

`tests/e2e/chat-loading.spec.ts` seeds the reported 31,000-plus-event
conversation into an isolated database, derives the newest completed parent
message from that source, and requires those exact words on screen. It asserts
the newest page is exactly 40 items, verifies one upward-scroll request and
preserved scroll anchoring, samples content-correct warm reopens for p95/p99,
and fails a release cold open at 500 ms. The test injects 200 ms of history
latency to prove paging remains stable under a slow response. Provider selector
and subagent lifecycle tests run the packaged Claude and Codex adapters with the
server's runtime `PATH` stripped of Node, npm and Python.

## Failure and upgrade rules

- Adapter discovery is release-relative or an explicit test/development path;
  there is no package-manager fallback.
- A session row and `session.started` event exist before adapter launch, so a
  startup failure is a durable, readable chat failure rather than a missing row.
- The registry observes adapter exit. An unexpected exit appends a durable
  provider error, releases the dead driver, and lets the next prompt attach a
  fresh connection instead of retaining a false live session.
- Prompt submission acknowledges immediately. The turn runs in the driver task;
  a later failure appends an error and an idle state.
- Permission and plan responses release the adapter's blocked request before
  optional steering, preventing serialized adapters from deadlocking.
- The updater stages and verifies the complete adapter directory, then swaps the
  Rust program and adapters together. Failure rolls both back.
- Adding another ACP provider requires adapter discovery plus normalization only;
  it must not add provider branches to history, sidebar, status or React code.
