# Agent workbench

The app becomes the place the owner talks to coding agents. Per project, two
tabs: **Chat** and **Board**. A chat knows the cards it worked on, a card knows
the chats that touched it, and a report links to both. Claude Code and OpenAI
Codex are supported from day one behind one internal protocol; a third brand is
one new driver file.

This document is the design. Card: `bw-7ks`.

---

## 1. Shape

Three processes, one port for the browser.

```
        browser (one origin: http://<host>:3008)
                        │
                        │  /api/…          /api/workbench/…
                        ▼
        ┌───────────────────────────────────────────┐
        │  axum server  :3008   (0.0.0.0)           │
        │  board · reports · static · bd            │
        │  NEW: /api/workbench/* → reverse proxy    │
        └───────────────────────────────────────────┘
                        │ HTTP, loopback only
                        ▼
        ┌───────────────────────────────────────────┐
        │  workbench sidecar  :3009  (127.0.0.1)    │
        │  Node 22 · TypeScript                     │
        │  drivers · event log · linker · registry  │
        └───────────────────────────────────────────┘
             │ stdio                    │ stdio            │ argv
             ▼                          ▼                  ▼
    claude (Agent SDK)          codex app-server          bd
```

### 1.1 Why a Node sidecar and not the axum server

Three reasons, in order of weight.

**The permission ask only exists in the SDK.** A one-shot `claude -p` cannot
answer permissions; the answer path is the Agent SDK's `canUseTool` callback
(allow / deny / allow-with-edited-input) riding the bidirectional
`--input-format stream-json --output-format stream-json` channel. The SDK is
TypeScript or Python. Driving that channel from Rust would mean inventing the
control-frame shape on the wire — the exact thing this project forbids
(implementing a non-trivial protocol from memory). We are not guessing at a
protocol whose official client is a `npm install` away.

**The server has no machinery for a supervised long-lived child.** Every
`Command` in `server/src/` today is either `.output()` under a 30s timeout or a
detached fire-and-forget spawn. There is no `Stdio::piped()`, no `ChildStdout`
reader, no `.kill()` anywhere. A chat session is a child process that lives for
hours, streams both ways, and must be interruptible. That is new machinery
wherever it goes; in Node it is `spawn` plus the SDK, in Rust it is a
subsystem.

**Decision 2 — keep upstream barely touched.** The sidecar is a new directory.
The Rust side gains one 150-line proxy module and three lines in existing
files. An upstream merge cannot conflict with a directory upstream does not
have.

The cost, stated plainly: **this fork needs Node present at runtime for the
Chat tab.** Node is already required to build the front end, and decision 15
scopes this to one computer. If `node` is missing the proxy answers 503 and the
Chat tab shows an offline banner — the board half is untouched and keeps
working.

Codex speaks newline-delimited JSON-RPC 2.0 over stdio, which is equally easy
in either language, so it follows Claude into the sidecar rather than splitting
the drivers across two runtimes.

### 1.2 Sidecar lifecycle

`routes::workbench::spawn_sidecar()` is called once at axum startup. It spawns
`node workbench/dist/server.js` bound to `127.0.0.1:3009`, restarts it with
backoff if it exits, and logs its stdout/stderr into the server's log. Two
environment escapes:

- `BEADS_WORKBENCH_URL` — if set, do not spawn; proxy to that URL. This is dev
  mode: run `npm run workbench` in your own terminal and get hot reload.
- `BEADS_WORKBENCH_PORT` — the port the spawned sidecar binds. Default 3009.

The sidecar binds loopback only, always. It is never reachable from the
network; the phone reaches it through the axum proxy and nothing else (§8.4).

### 1.3 Sidecar layout

```
workbench/
  package.json          own deps: @anthropic-ai/claude-agent-sdk, zod
  src/
    server.ts           http, SSE, command routes
    store.ts            node:sqlite — schema, event log, replay, search, spend
    registry.ts         sessions, restore list, terminal-session discovery
    linker.ts           bead-id extraction → bd provenance (brand-agnostic)
    reports.ts          report detection
    bd.ts               spawn bd, parse --json
    drivers/
      types.ts          the Driver interface + Capabilities
      index.ts          brand → driver
      claude.ts         Agent SDK
      codex.ts          app-server JSON-RPC over stdio
```

The protocol types live at `src/workbench/protocol.ts` — inside the Next.js
app, imported by the sidecar over a relative path. One definition, both sides,
and no `tsconfig.json` path alias to add upstream.

`node:sqlite` is built into Node 22 (verified on this machine, v22.20.0; it
prints an experimental warning and works). No native module to compile.

---

## 2. The internal protocol (WBP)

One vocabulary. Drivers emit it; the UI consumes it; nothing brand-specific
crosses the seam. Adding a brand — including ACP later, per decision 1 — means
writing one file that speaks this and nothing else.

Every event carries `{ seq, sessionId, at, type, … }`. `seq` is a per-session
monotone integer, and it is the whole reconnect and replay story (§4).

### 2.1 Driver → app

**Lifecycle**
| event | payload |
|---|---|
| `session.started` | `brand, externalId, model, effort, cwd, projectId, permissionMode, resumedFrom?` |
| `session.state` | `state, label` — see §2.3 |
| `session.title` | `title` (derived from the first user message) |
| `session.ended` | `reason` |
| `capabilities` | the matrix of §3.3 — the UI hides every control that is false |
| `session.menu` | `commands[{name,description,argumentHint}], skills[], models[{value,displayName,description}], permissionModes[]` — everything the writing box offers for THIS session (§7, §8.2.3). Sent at birth and again whenever the brand pushes a new list |
| `error` | `message, fatal` |

**Content**
| event | payload |
|---|---|
| `message.started` | `messageId, role` |
| `text.delta` | `messageId, text` — word by word |
| `thinking.delta` | `messageId, text` — behind a toggle |
| `message.completed` | `messageId` |
| `image` | `messageId, mime, dataUrl \| path, alt` |

**Work**
| event | payload |
|---|---|
| `tool.started` | `toolCallId, name, input, title, parentToolCallId?` |
| `tool.completed` | `toolCallId, ok, output, error?` |
| `tool.progress` | `toolCallId, seconds` — how long this call has been running, as the brand counts it (§8.2.2) |
| `diff` | `toolCallId, path, before, after` — side-by-side changed lines |
| `todo` | `items[{text,status}]` — the agent's live checklist |
| `subagent.started` / `subagent.ended` | `subagentId, name, parentToolCallId` |

**Asks** — each carries an `askId` the app answers
| event | payload |
|---|---|
| `ask.permission` | `askId, toolName, input, editable, options[{id,label,kind}]` where kind ∈ allow_once, allow_always, deny |
| `ask.choice` | `askId, question, options[{id,label}], allowFreeText` |
| `ask.plan` | `askId, planMarkdown, options[]` |
| `ask.resolved` | `askId, chosen` — echoed so every open browser converges |

**Accounting and links**
| event | payload |
|---|---|
| `cost` | `{kind:"usd", usd}` **or** `{kind:"tokens", input, output, cached, total}` — never converted, never mixed (decision 12) |
| `link.bead` | `beadId, via: hook \| brief \| manual` |
| `report.available` | `project, slug, title, cardId?` |

### 2.2 App → driver

`session.start`, `session.open` (read it without waking it — see
docs/designs/app-shell.md §1.9), `session.resume`, `prompt.send` (text +
attachments + mentions), `ask.answer` (`askId, optionId, updatedInput?,
freeText?`), `session.stop`, `session.end`, `session.mode` (`mode`) and
`session.model` (`model`) — both acting on the LIVE session (§8.2.3) — and
`compact`, `clear`. A typed command is not its own message: it is sent as
ordinary prompt text, which is how the brand runs one (§7).

### 2.3 Session state

One enum, and it is what drives the glance strip and the waiting-on-you tray:

`idle · thinking · streaming · running_tool · waiting_permission ·
waiting_choice · waiting_plan · stopped · errored · ended · dormant`

The three `waiting_*` states plus `ended` are "blocked on the human". The tray
is a filter over this and nothing more.

### 2.4 The Driver interface

```ts
interface Driver {
  capabilities(): Capabilities;
  start(opts): AsyncIterable<WbpEvent>;
  send(input: PromptInput): Promise<void>;
  answer(askId: string, answer: Answer): Promise<void>;
  interrupt(): Promise<void>;
  setModel(model: string, effort?: string): Promise<void>;
  listCommands(): Promise<Command[]>;
  close(): Promise<void>;
}
```

That is the extension point. A third brand is `drivers/<brand>.ts` plus one
line in `drivers/index.ts`.

---

## 3. The two drivers

### 3.1 Claude

Launched through `@anthropic-ai/claude-agent-sdk` (npm, currently 0.3.232),
which wraps `claude --input-format stream-json --output-format stream-json
--verbose` and adds the typed message stream, `canUseTool`, `set_permission_mode`
and hooks.

Fixed at launch, every session:

- **The permission mode is always passed explicitly.** Defaults are shifting
  and plan/bypass modes are *not* restored on resume, so the sidecar stores the
  mode per session and re-pins it on every resume. The header shows the pinned
  mode. Which mode asks about *every* tool was settled by running one and
  watching: a permission request arrived for `Read` and again for `Edit`.
- **No MCP.** `--strict-mcp-config` with no `--mcp-config` — nothing attaches
  unless the owner asks (decision 6).
- **His own commands, skills and settings are loaded** — `settingSources:
  ['user', 'project', 'local']` and `skills: 'all'` (bw-f1q). This reverses the
  build's first choice of `settingSources: []`. That choice bought a session
  that could not be surprised by anything on the machine, and its price was a
  chat with no commands and no skills at all, which is what the manager found:
  "no option to use skills. no option to use commands". Loading them is the
  whole feature. It follows that his `CLAUDE.md`, his hooks and his own
  commands apply inside this app exactly as they do in a terminal.
- **Never `--bare`, never `ANTHROPIC_API_KEY`.** The CLI's own help states
  `--bare` forces API-key auth and never reads OAuth or the keychain. The
  sidecar launches `claude` in the owner's normal environment so the
  subscription he already signed into in the terminal is what runs
  (decision 5).
- `--include-partial-messages` for word-by-word text, and
  `--forward-subagent-text` so subagent output arrives with
  `parent_tool_use_id` set and can be nested in the feed.

Mapping: text/thinking deltas → `text.delta`/`thinking.delta`; `tool_use` and
`tool_result` blocks → `tool.started`/`tool.completed`, nested by
`parent_tool_use_id`; `canUseTool` → `ask.permission` (with `editable: true` —
the SDK accepts `updatedInput`); the multiple-choice question tool →
`ask.choice`; the plan-approval permission → `ask.plan`; the final result
message's `total_cost_usd` → `cost{kind:"usd"}`.

**Resume:** `--resume <session-id>`, which works from any directory on
v2.1.223+ (this machine has 2.1.232). Which sessions exist, what they are
called and what was said in them all come from the SDK's own session functions
(`listSessions`, `getSessionInfo`, `getSessionMessages`) — we never parse a
transcript file ourselves (§6.3).

### 3.2 Codex

Launched as `codex app-server` — JSON-RPC 2.0, newline-delimited, over stdio.
`codex exec --json` is outbound-only and cannot answer approvals; it is not
used.

`thread/start` opens a thread; turn input carries text and `image` /
`localImage` items (base64 data URL or a local path — remote URLs are
rejected, so the sidecar always inlines or writes to a temp file);
`item.started` / `item.updated` / `item.completed` become the tool and content
events; approval requests arrive as RPCs the client answers, which become
`ask.permission`; `turn.completed` usage becomes `cost{kind:"tokens"}` — token
counts only, no dollar field, and we do not invent one.

**Method names are to be confirmed against the raw protocol source**
(`raw.githubusercontent.com/openai/codex`, `codex-rs/app-server-protocol`)
before they are hard-coded. The capability set below is settled; the wire
spelling is not.

**Resume:** `codex resume <id>` / thread resume in the surface. The
`~/.codex/sessions` path is not first-party-confirmed, so the resume *command*
is the contract and we do not enumerate files there (§6.3).

### 3.3 Capability matrix

Decision 13: where a brand lacks an ability the window **hides that control**.
It never greys it out with an excuse and never fakes parity.

| capability | Claude | Codex |
|---|---|---|
| streamed text | yes | yes |
| stop mid-turn | yes (SDK interrupt) | turn interrupt — *confirm* |
| permission ask | yes | yes |
| …with edited input | yes (`updatedInput`) | allow/deny only — *confirm* |
| multiple-choice question | yes | **no** → control hidden |
| plan-then-approve | yes (`--permission-mode plan`) | **no** → hidden; `review/start` is offered as its own command instead |
| images in | base64 blocks | `image`/`localImage` items |
| todo checklist | yes, via the task tools — this build ships no `TodoWrite` | *confirm* |
| subagents | yes (`parent_tool_use_id`) | **no** → panel hidden |
| cost | dollars | tokens |
| typed commands | the install's real slash commands | four fixed entries (§7) |
| model picker | `--model` | `model/list` + per-turn override |
| effort picker | `--effort` | *confirm* |
| resume | `--resume <id>`, any directory | `codex resume <id>` |
| list sessions we did not start | yes (the SDK's session index) | **no** → group hidden |
| compact | `/compact` | `thread/compact/start` |
| clear | `/clear` | `thread/start` (new thread, same chat record) |

`@`-file completion is **ours**, not a brand feature: the composer completes
from the project's file list via the existing `GET /api/fs/list`, and the
driver's `mentionStyle` decides whether `@path` or a bare relative path is
inserted. Identical behaviour on every brand.

---

## 4. Browser transport

**SSE down, POST up.** Not WebSocket.

The repo already has a working SSE pattern (`server/src/routes/watch.rs`:
`Sse` + `mpsc` + `ReceiverStream` + a 30s keep-alive, consumed by a plain
`EventSource` in `src/lib/api.ts`). Reusing it means the transport is a known
quantity rather than new machinery. Server→browser is the direction with all
the traffic; browser→server is a prompt now and then and a button click on an
ask — an ordinary POST. SSE also reconnects natively with `Last-Event-ID`,
which is exactly the replay we need.

Routes, all under the proxy at `/api/workbench`:

| route | purpose |
|---|---|
| `GET /events?session=<id>&since=<seq>` | one session's stream; replays from `since`, then tails live |
| `GET /events` | the cross-project stream: state changes and activity lines for **all** sessions — feeds the tray and the glance strip |
| `POST /command` | every app→driver message of §2.2, one envelope |
| `GET /sessions?project=` | the sidebar and the restore list |
| `GET /links/session/:id` / `GET /links/bead/:id` | the joins of §6 |
| `GET /search?q=` | across all conversations |
| `GET /spend?from=&to=` | per project per day |
| `GET /health` | proxy liveness; drives the offline banner |

**The transcript and the live stream are the same code path.** Opening a chat
is `GET /events?session=X&since=0`: the event log replays, then the connection
stays open and tails. There is no second renderer for history.

The proxy (`server/src/routes/workbench.rs`) is a catch-all `any` handler using
`reqwest` (already a dependency) that forwards method, path, query, headers and
body, and streams the response back with `axum::body::Body::from_stream(
resp.bytes_stream())` so `text/event-stream` passes through unbuffered. It
strips hop-by-hop headers and never sets `Content-Length` on a streamed body.

---

## 5. Storage

A second SQLite file, `workbench.db`, in the same app-data directory the server
already uses for `settings.db`
(`ProjectDirs::from("com","beads","kanban-ui").data_dir()`). The sidecar is its
only writer. `server/src/db.rs` is not touched.

```sql
session(id PK, brand, external_id, project_id, project_path, cwd,
        model, effort, permission_mode, title, state,
        origin,              -- 'app' | 'card' | 'terminal'
        created_at, last_active_at, ended_at)

event(session_id, seq, at, type, json, PRIMARY KEY(session_id, seq))
gevent(gseq INTEGER PRIMARY KEY AUTOINCREMENT, session_id, seq)

message(session_id, message_id, role, text, at)   -- flattened, for search
turn(id PK, session_id, project_id, day, brand,
     usd REAL NULL, tokens_in INT NULL, tokens_out INT NULL, at)
ask(session_id, ask_id, kind, json, answered_at, answer_json)
bead_link(session_id, bead_id, via, first_seen_at, PRIMARY KEY(session_id, bead_id))
report_link(session_id, project, slug, at)
```

- `event` is append-only and is the transcript. `gevent` gives the
  cross-project stream a total order.
- `ask` rows survive a restart, so a session that stopped mid-question comes
  back still asking (and still counted in the tray).
- `turn` carries only what the brand reported — `usd` is null for Codex,
  `tokens_*` is null for Claude. Nothing is derived across that line.
- **`bead_link` is a cache, not the record.** The record is on the board
  (§6.1). Deleting `workbench.db` loses the transcripts; it does not lose a
  single chat↔card link.
- Search is `LIKE` over `message.text` joined to `session`. Deliberately not
  FTS5: the corpus is one person's chats, `LIKE` is instant at this size, and
  it avoids depending on a SQLite build flag nobody has verified.
- Migrations: a numbered list applied above the recorded version, the same
  shape `server/src/db.rs` already uses, so the idiom matches the neighbours.

---

## 6. The links

### 6.1 Chat ↔ card, recorded by the machine

Decision 7: the machine watches tool calls; the agent is never asked to
remember. The record lives on the board, in `bd`'s own append-only provenance
log:

```
bd provenance record --issue <bead> --kind used \
    --source workbench-tool --ref <sessionId> --ref-kind transcript
```

Both directions are `bd`'s, already:

- **chat → cards:** `bd provenance by-ref <sessionId> --json`
- **card → chats:** `bd provenance log <beadId> --json`, keeping
  `ref_kind == "transcript"`

**Measured, not assumed.** Against a throwaway `bd` database: two cards bound
to one session id, one card bound to two session ids; `by-ref` returned both
cards, `log` returned both sessions. And the idempotency is on
`source:issue:kind:ref` — recording the same pair a second time was a no-op and
**the second payload was discarded**. Two consequences, both load-bearing:

1. The linker may fire on *every* tool call without any deduplication of its
   own. Four hundred tool calls that touch one card produce exactly one edge.
   (It still memoises in RAM per session, to save four hundred process spawns —
   but that is performance, not correctness.)
2. The provenance row is an **edge, not a log**. Per-tool-call detail belongs in
   our `event` table, never in the payload — the payload only survives from the
   first write.

`--source` distinguishes how the edge was born, and different sources coexist
on the same pair: `workbench-brief` for a chat started from a card (decision
16b — linked at birth), `workbench-tool` for one the machine observed,
`workbench-manual` if the owner attaches one by hand.

**How a card is spotted.** The linker sits *above* the drivers: it consumes our
own `tool.started` events, not brand events, so a third brand gets linking for
free. For each event it serialises the tool input to text, together with the
user's prompt text, and pulls out every token shaped like a bead id
(`^[a-z0-9]{2,6}-[a-z0-9.]+$`). Each distinct candidate is confirmed by
`bd show <id> --json`, cached per session — a real card confirms, a false
positive does not. **The exit code is not the answer:** measured, `bd show` on
an unknown id exits 0 and returns `{"error":"no issues found matching the
provided IDs"}`. Confirmation is "the JSON is an array with a matching `id`",
and anything else is a miss. Confirmed candidates become provenance rows and a
`link.bead` event. In practice the strong signals are the agent's own
`bd` commands, its `git commit` messages (which carry the card id in this
house), and writes under `.beads/`.

**One refinement of decision 7, stated openly.** The decision names Claude's
PreToolUse/PostToolUse hooks as the mechanism. The primary source will instead
be the `tool_use` / `tool_result` blocks in the SDK's own output stream: it is
the same data — every tool call, its name, its input, its result — arriving
typed, in-process, with subagent attribution attached, and it needs no hook
script and no loopback callback back into the sidecar. The hooks remain the
declared fallback (`--include-hook-events`, or a hook script posting to the
sidecar) if any tool proves invisible in the stream. The rule decision 7
actually sets — *the machine watches, the agent never remembers* — is
unchanged, and work item 3's screen test is what proves the feed is complete.

### 6.2 Reports, linked to both

A report already knows its card: `GET /api/reports` returns `{project, slug,
title, card}` from the spec. So report→card exists today and is not rebuilt.

Report→chat is machine-observed the same way as cards: a tool call that runs
`report <slug>` or writes `reporting/pages/<project>/<slug>.report.json`
produces a `report.available` event and a `report_link` row. When the report's
spec names a card, the sidecar also records
`bd provenance record --issue <card> --kind used --source workbench-report
--ref <project>/<slug> --ref-kind work-id`, so the card's own history shows the
report as well as the chats.

Nothing under `reporting/` is touched — it is out of scope by the card.

### 6.3 The restore list

Decision 8: after a restart the app lists yesterday's sessions per project; one
click resumes one; **nothing auto-runs**. There is no "resume all": a button
that starts forty agents at once is a bill nobody meant to sign, and the owner
asked for it gone.

At startup the sidecar marks every non-`ended` session `dormant`. A dormant
session has no child process until it is clicked. The sidebar groups by day —
Today, Yesterday, then dates.

A row says three things and no more, because that is what tells two chats apart
when a project has forty of them:

| line | what it carries |
|---|---|
| first | the conversation's own **name** — the brand's title for it, not ours |
| second | a **chip per card** it worked on, which opens that card, and a **chip naming the folder** it ran in |

The folder is the whole point of the second chip: a worktree's directory is
named after the worktree, so two chats on the same project in different trees
are told apart at a glance. The full path and the branch are in its tooltip.

Sessions the owner started in a terminal are listed too, for Claude only, and
they come from **the SDK's own session index** (`listSessions({dir,
includeWorktrees})`), not from a directory scan of ours. That index carries the
name, the cwd and the branch, and its shape is the SDK's contract rather than a
format we guessed at — which is why the earlier rule ("never open a transcript,
the line format is unstable") is retired: we still never parse one, the SDK
does. Resuming goes through `claude --resume <id>`, which is the contract.

A card chip appears once the chat is known to have worked on that card, which
means a tool call of its own acted on it (§6.1). A chat the app has never
driven therefore carries no card chips until it is opened and its history read.

Codex sessions we did not start are **not listed**, because the sessions
directory is not first-party-confirmed. The Codex group simply does not appear
rather than showing something we cannot stand behind (decision 13).

#### 6.3.1 Which chats are offered

Constraint: the list holds the chats a person began. A chat an agent started to
do a piece of work for another chat is behind a switch, off by default, and so
is one with nothing said in it yet.

External reality: the agent kit's index separates the two itself —
`listSessions({includeProgrammatic: false})` is the same filter the terminal's
own `/resume` picker uses. Measured on Corsetta, 2026-08-16: 306 chats offered,
218 of them a person's; the 88 it withholds are every "You are reviewing a
change" review agent and every unnamed one (bw-p61.3).

#### 6.3.2 What an open chat shows of what was said before

Constraint: opening a chat shows what was said in it, whoever started it, and
the transcript stays the event log's to serve (§4). A chat's past is therefore
read once from the agent kit's own record (`getSessionMessages`) and written
into the log as the events that would have carried it, only while the log holds
nothing for that chat — read twice, it would say everything twice.

Why the cap: those records reach 1002 messages (measured, bw-p61.3), and a
screen that draws every one of them is the fault this app already paid for once
(docs/designs/app-shell.md §3). The last 200 are imported and the count of what
came before is said in a line, not drawn.

#### 6.3.3 The way back in

Constraint: a chat opens by being clicked, and a chat that is asleep is woken by
the same click. Nothing else in the list starts an agent, so decision 8 holds:
the click is the consent, and there is no second button to press.

---

## 7. Typed-command menus

Very important to the owner, and per-brand by construction: the driver hands the
menu up, the composer renders whatever it gets.

**Claude** — the install's real slash commands, which work in headless mode.
The menu lists them with their descriptions; picking one sends it as the
prompt. Terminal-only commands (`/login` and friends) are filtered out.
`/compact` and `/clear` are ordinary members of this list.

The list is not asked for: a session announces it at birth. `system/init`
carries `slash_commands`, `terminal_slash_commands` (the ones a screen like this
must hide), `skills`, `model` and `permissionMode`; the models come from
`supportedModels()` once, alongside. All of it rides on `session.started` and
one `session.menu` event, so a browser that opens the chat later is told the
same thing without a second round trip. The kit also pushes a fresh command list
mid-session when the agent discovers skills in a subdirectory; that push
replaces the stored list.

A picked command is sent as ordinary user text — that is how the kit runs one.
A LOCAL command (`/usage` and friends) answers with `system/local_command_output`
and bypasses the query loop entirely, so no `result` message closes the turn:
the chat must draw that output and put itself back to Ready itself, or it waits
for a message that is never coming.

**Codex** — exactly four entries, because that is what Codex exposes
programmatically. There is no command-listing RPC and custom prompts are
TUI-only and deprecated, so nothing is invented:

| entry | mechanism |
|---|---|
| Model | `model/list` + per-turn override |
| Review | `review/start` |
| Compact | `thread/compact/start` |
| Skills | `skills/list`, then a turn with a skill input item |

Skills expand to a sub-list from `skills/list` — the supported
named-instruction mechanism, and the honest Codex answer to "custom commands".

---

## 8. The window

### 8.1 Two tabs

`src/app/project/page.tsx` is 19 lines and does nothing but wrap
`<KanbanBoard/>` in `<Suspense>`. It becomes a `<Tabs>` shell with **Chat** and
**Board**; the Board tab renders the same `<KanbanBoard/>`, unchanged and
un-reindented. `src/components/ui/tabs.tsx` already exists in the repo and has
no importers — it is wired in, not written.

No third tab: reports live inside the chat and inside the card (decision 10).

### 8.2 The chat tab

- **Left sidebar** — every chat in this project, grouped by day, with brand
  icon, title, state pill and its card chips. A "＋ New chat" header with the
  brand / model / effort pickers.
- **Transcript** — user and assistant bubbles; text arriving word by word;
  images as images; a collapsible thinking block; a tool row per call showing
  name and a one-line summary, expanding to full input and result; Edit and
  Write rows expanding to a side-by-side diff with changed lines marked;
  subagent work indented under its parent row; the todo checklist pinned as a
  live panel; asks rendered as cards with real buttons.
- **Composer** — multiline, paste/drop an image, `@` opens file completion,
  `/` opens the typed-command menu, Stop replaces Send while a turn runs.
- **Right rail** — cards this chat has touched (clicking one opens it on the
  Board tab), reports it produced, cost, pinned permission mode.

#### 8.2.1 The open chat's own line

Constraint: what an open chat says about itself is one line high whatever it
carries, and the words that name the agent are never squeezed to make room for
what it has touched. A long-running chat's cards are shown as the first few and
a count; the count carries the rest.

Why: measured 2026-08-16 (bw-p61.3), one chat's 26 card chips made a row 2277 px
wide in a pane about 700 px wide, and the model and permission text was squeezed
to 37 px — three words stacked in a column, which is the picture the manager
sent back.

#### 8.2.2 What a working chat shows (bw-f1q)

Constraint: while the agent owes an answer, the foot of the transcript says what
it is doing, and it changes. Three things stand there, in one line, immediately
above the writing box:

- a moving mark, so a still screen and a working one are never the same picture;
- what it is doing **in its own words** — the tool call being run, or Thinking,
  or the command it is answering;
- how long it has been at it, in seconds, taken from the kit's own
  `tool_progress` (`elapsed_time_seconds`) where it gives one and counted from
  the state change where it does not.

And the thinking itself is drawn: a dim block that grows as the words arrive and
collapses to its first line once the answer starts. It is a transcript item like
any other, folded out of `thinking.delta` by the same reduction as text, so
replay and live tail agree by construction (§4).

Why here rather than the badge at the top: measured 2026-08-17 (bw-f1q.3), one
ordinary turn spent ten consecutive seconds in `running_tool` with nothing on the
screen changing at all, and no thinking was ever drawn in any turn, because the
driver read only `text_delta` off the stream. The manager's words: "when the
agent is processing/thinking/running command, i see nothing."

The line is present exactly while `isBusy` holds, so it disappears the moment the
turn ends and cannot be left behind by a state event that never arrives.

#### 8.2.3 Steering the chat you are in (bw-f1q)

Constraint: the mode, the model, the skills and the commands are chosen from the
writing box, and they act on the chat that is open — not on the next one.

- **Permission mode** and **model** are pickers on the composer's own row. They
  send `session.mode` / `session.model`, which call the kit's
  `setPermissionMode` / `setModel` on the live session; the change comes back as
  an event, so every window watching that chat agrees and the header's pinned
  mode is never a guess.
- **`/`** at the start of the box opens the command and skill menu (§7),
  filtered as he types, arrow keys and Enter to pick.
- A **picture** — one waiting in the tray or one already sent — opens at full
  size over the chat when clicked, and closes on Escape or a click away.

The mode a session is pinned to is still stored per session and re-pinned on
resume (§3.1); a live change updates that store, so it survives the chat going
to sleep and coming back.

### 8.3 The board tab

Unchanged, plus one thing: decision 11 — a card being worked on shows its live
chat. `src/components/bead-card.tsx` gains a single `<CardLiveChat
beadId={bead.id}/>`, which renders nothing at all unless a running session is
linked to that card, and otherwise shows a pulsing dot, the session's current
activity line, and the last line of assistant text, clicking through to the
chat.

The card detail panel gains a **Chats** list from `GET /links/bead/:id`, and a
**Start chat** button (decision 16b) which opens a new session pre-briefed with
the card's title, description and acceptance criteria, and records the link at
birth with `--source workbench-brief`.

### 8.4 The six additions

**(a) Waiting-on-you tray.** One cross-project list of sessions in a `waiting_*`
or `ended` state, mounted in `src/app/layout.tsx` so it is visible on every
page, with a count badge. Fed by the single global SSE stream. Clicking a row
lands on that chat with the ask focused.

**(b) Start a chat from a card.** §8.3.

**(c) Glance strip.** A collapsible one-line-per-running-session strip under the
header: brand, project, title, current activity, elapsed. Same global stream,
same store.

**(d) Phone, home network only.** axum already binds `0.0.0.0:3008`, so the
board is reachable today; the sidecar stays on loopback and is reached only
through the proxy, so the workbench adds no new exposed port. On top of that,
the workbench routes carry a middleware that refuses a peer address outside
loopback and the RFC1918 private ranges — "home network only" implemented as
a check rather than as a hope. Plus a responsive chat layout: the sidebar
collapses to a drawer under 768px and the composer stays reachable.

**(e) Search across all conversations.** `GET /search?q=` over `message.text`,
results grouped by session with the matched sentence highlighted and its
project and date; clicking jumps to the chat scrolled to that message.
Cross-project, reachable from the header.

**(f) Spend per project per day.** `GET /spend` aggregates the `turn` table.
Rendered with `recharts` (already a dependency) as **two charts, never one**: a
dollars-per-day chart for Claude and a tokens-per-day chart for Codex. They are
never added together and no price is ever applied to a token count
(decision 12).

### 8.5 The report viewer

Decision 9: the report path is untouched. `GET /api/reports/page?project=&slug=&path=`
already returns finished HTML, and `src/components/report-panel.tsx` already
builds that URL with `reportUrl()`.

In the chat, a `report.available` event renders an **inline card**: title, card
chip, and the live report in a short non-scrolling `<iframe>` preview. Clicking
opens the same URL in a Radix `Dialog` at near-full viewport. An iframe, not
injected markup — the report page ships its own 17KB stylesheet and its own
script, and letting that loose in the app's Tailwind document would wreck both.

One note for the builder: `src/components/report-panel.tsx:31` fetches
`/api/reports` bare instead of through `apiUrl()`, unlike every other call in
the app, so it targets 3007 in the dev split. That is an upstream bug, out of
scope, and must not be copied — the workbench goes through `apiUrl()`.

### 8.6 Shared state

The repo has no global store. It has one idiom for cross-component state:
`useSyncExternalStore` over a module-level listener set (`src/hooks/use-theme.ts`).
The workbench follows it — a single module-level store owns the one global
`EventSource` and the per-session state that the tray, the strip and the board
cards all read. One connection for the whole app, not one per component.

---

## 9. Files

### 9.1 Upstream files touched — the whole budget

| file | change |
|---|---|
| `server/src/routes/mod.rs` | `pub mod workbench;` — 1 line |
| `server/src/main.rs` | one `.nest("/api/workbench", …)` + one `spawn_sidecar()` — 2 lines |
| `server/Cargo.toml` | reqwest's `stream` feature — one word, and SSE cannot pass through the proxy without it |
| `src/app/project/page.tsx` | 19-line file becomes a Tabs shell around the unchanged `<KanbanBoard/>` |
| `src/app/layout.tsx` | one `<WorkbenchGlobals/>` — tray + strip |
| `src/components/bead-card.tsx` | one `<CardLiveChat beadId=…/>` |
| `src/app/project/kanban-board.tsx` | one `<CardChats …/>`; a card's chats belong in its detail panel, whose extra sections are passed in from here |
| `package.json` | added dependency and script lines only; no existing line modified |
| `tsconfig.json` | `workbench` added to `exclude` — the sidecar carries its own |
| `playwright.config.ts` | `baseURL` reads `BEADS_E2E_URL`, so a worktree drives its own instance instead of the one serving the owner's board |

Ten files, seven of them a single line or word. `server/src/db.rs`,
`bead-detail.tsx`, `src/lib/api.ts` and everything under `reporting/` are not
touched at all. If the build needs to exceed this list, that is a design
change and it gets said out loud, not absorbed.

### 9.2 New

`workbench/` (the sidecar), `server/src/routes/workbench.rs` (proxy +
supervisor), `src/workbench/**` (protocol types, store, chat UI, tray, strip,
search, spend, report viewer), `tests/e2e/workbench.spec.ts`, this document.

### 9.3 Declared shortcuts

- `bead_link` and `report_link` duplicate what the board holds. They are a
  read cache for speed; the board is the record, and a rebuild from
  `bd provenance` must always be possible.
- Search is `LIKE`, not FTS5. It will need revisiting if the corpus grows
  past tens of thousands of messages.
- The Claude terminal-session project guess reads the directory name as
  `cwd` with `/`→`-`. Observed on this machine, not documented; it degrades
  to "Unknown project", never to a wrong project silently.
- A picture is inlined as a data URL in the event that carries it, so the
  transcript stays self-contained. A habit of pasting large images would grow
  the event log fast; the fix, when it is needed, is a blob beside the database
  with the event holding a reference.
- The side-by-side change view diffs the fragment the tool was handed
  (`old_string` against `new_string`), not the whole file before and after.

---

## 10. Not built

Out by decision 14, and not designed in: rewind/checkpoints, `/btw` side
questions, user shell mode, memory-file editing, voice, vim/keyboard emulation,
login screens, chat theming, prompt suggestions, recap. Out by decision 15:
remote machines (that is `bw-4rw`). Out by decision 1: ACP as the foundation —
it may arrive later as a third driver behind §2.4.

## 11. Facts still needing grounding

Nothing below is assumed in the design; each is either marked *confirm* in the
capability matrix or has a stated fallback.

1. **Codex app-server method names.** `thread/start`, `model/list`,
   `review/start`, `thread/compact/start`, `skills/list` came from
   tool-summarised docs. Re-read `codex-rs/app-server-protocol` in the raw
   before hard-coding any of them.
2. **Codex turn interrupt, approval-with-edited-input, todo items, effort.**
   Whether each exists at all. Each is a capability flag; if it is absent the
   control is hidden.
3. **`codex` is not installed on this machine.** No binary on `PATH` (only
   `~/.codex/` with memories/skills/tmp). The Codex driver cannot be exercised
   — and therefore cannot be signed off — until it is installed.
4. ~~Which Claude permission mode asks about everything.~~ Settled by running
   one — see [§3.1](#31-claude).
5. ~~`@playwright/test` is not a dependency.~~ Added; the runner is in
   `package.json`.
6. **The raw control-frame shape of stream-json permissions.** Not known — and
   deliberately not needed, because the SDK owns it (§1.1). If we ever leave
   the SDK, this becomes a research task first.

---

## 12. Work items

Ordered. Each is `what to do | how we know it is done`, and the done half is
always a screen, per the owner's standing rule on this job.

1. **Sidecar, proxy and the Claude driver, end to end: one live conversation with a clickable permission ask.** | On `/project?id=<p>` → Chat tab, two screenshots one second apart during a turn show the same assistant message grown longer, with a Stop button beside it; a permission card reads "Allow Edit on `<path>`?" with Allow once / Allow always / Deny; after clicking Allow once the card collapses to "Allowed" and the tool row in the feed turns complete.

2. **The rest of the transcript vocabulary: tool feed, diffs, images, todo list, subagents, cost.** | One screenshot of a finished turn shows all six at once — a row per tool call with name and summary, an expanded Edit row with before and after side by side and the changed lines marked, a pasted PNG rendered as a picture in the user's own bubble, the todo checklist with at least one item ticked and one running, an indented subagent block under its parent row, and a dollar cost chip in the turn footer.

3. **The machine-recorded chat↔card link, both directions, plus reports inline and in a modal.** | Three screenshots: (a) the chat header grows a card chip nobody typed, right after the agent runs a `bd` command; (b) that card opened on the Board tab lists this chat under "Chats", and clicking it lands back on the chat; (c) a report rendered as an inline preview card in the transcript, and after a click the same report filling a modal over the app.

4. **Session registry, the restore list, and resume — including a session started in a terminal.** | After killing and restarting the server, a screenshot of the chat sidebar shows sessions grouped with a "Yesterday" heading, each row carrying the conversation's own name, its card chips and the folder it ran in, and a terminal-started Claude session among them; clicking Resume on that row flips its pill to ready and a new prompt's answer streams into it.

5. **The Codex driver behind the same protocol, with the capability matrix hiding what it lacks.** | Two screenshots at the same size, a Claude chat and a Codex chat: both stream text and show tool rows; the Codex one shows a token-count chip and has no plan-approve control and no subagent panel; the Claude one shows a dollar chip and has both. (Blocked until `codex` is installed — see §11.3.)

6. **The typed-command menu, per brand.** | A screenshot of the composer after typing `/` in a Claude chat shows a menu of that install's real slash commands with descriptions; the same composer in a Codex chat shows exactly four entries — Model, Review, Compact, Skills — with Skills expanding to the live skill list; running Compact in each puts a "compacted" divider in the transcript.

7. **Waiting-on-you tray and glance strip, across projects.** | With sessions running in two different projects, a screenshot of the project list page `/` shows a header badge reading "2", the tray open and listing both blocked sessions with project name and what each is waiting for, and the glance strip below the header showing one activity line per running session; clicking a tray row lands on that chat with the ask focused.

8. **Search across all conversations, and spend per project per day.** | A screenshot of the search panel with a query typed shows matches from at least two different chats, each with the matched sentence highlighted and its project and date; a second screenshot of the spend view shows a bar per day grouped by project, with the dollars chart and the tokens chart drawn as two separate charts and no total combining them.

9. **Start-a-chat-from-a-card, the live chat on the board card, and the phone layout.** | A screenshot after clicking a card's "Start chat" shows a new chat whose first message already quotes the card's title and body and whose header already carries the card chip; a screenshot of the Board tab shows that card with a pulsing dot and a live activity line; a 390×844 screenshot of the same chat is readable with no horizontal scrolling and the composer in reach.

10. **The acceptance run.** | `npx playwright test tests/e2e/workbench.spec.ts` reports 0 failures, and the screenshots the run saves under `tests/results/` show, one per assertion: an answer streaming in, a picture inline, a report open large, and the hop from a card landing on its chat.
