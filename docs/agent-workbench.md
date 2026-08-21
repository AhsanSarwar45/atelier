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
`node --experimental-strip-types workbench/src/server.ts` bound to
`127.0.0.1:3009`, restarts it with backoff if it exits, and logs its
stdout/stderr into the server's log. Three environment escapes:

- `BEADS_WORKBENCH_URL` — if set, do not spawn; proxy to that URL. This is dev
  mode: run `npm run workbench` in your own terminal and get hot reload.
- `BEADS_WORKBENCH_PORT` — the port the spawned sidecar binds. Default 3009.
- `BEADS_WORKBENCH_ENTRY` — the file to run. Default is the source above; a
  missing file is a warning and an offline Chat tab, not a crash.

**There is no build step for the sidecar: node runs the TypeScript as it
stands**, types stripped in memory. That is what makes a chat's server one
edit away from running, and it is also the reason for the import rule in §1.3.
The restart is unconditional, so a sidecar that cannot even load its own
modules restarts forever, once a second, and the only symptom on the screen is
that no chat opens at all.

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

**Those shared files are read two ways, and only one of the two readers is
forgiving.** The browser's build resolves `'./protocol'` and `'./protocol.ts'`
alike; node, running the source directly (§1.2), resolves the exact filename or
nothing. So every runtime relative import inside `src/workbench/*.ts` names the
file with its extension, `import { isOver } from './protocol.ts'`, which the
app's `tsconfig.json` allows by `allowImportingTsExtensions` (legal beside
`noEmit`). A type-only import is erased before node ever sees it and is exempt,
which is why the same file can spell one import both ways. Getting this wrong
is invisible to the typecheck, the unit suite and the production build — all
three passed on the commit that broke it — and shows up only as the restart
loop above (bw-7ks.22.35). `src/workbench/__tests__/node-can-read-it.test.ts`
pins it, so it is caught by the suite rather than by a chat that will not open.

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
| `note` | `noteId, rank: note \| detail, kind, text, body?` — anything the machine says about itself, and everything the mapping above has no name for (§8.2.4) |
| `transcript.reset` | no payload — drop everything drawn so far; what follows replaces it. Sent once, when a chat's past is read again under a newer reading of the record (§6.3.2) |

**Work**
| event | payload |
|---|---|
| `tool.started` | `toolCallId, name, input, title, parentToolCallId?` — `input` is kept and drawn behind the row's own click (§8.2.4), cut to `KEPT` |
| `tool.completed` | `toolCallId, ok, output, error?` — `output` is kept and drawn the same way, cut the same way |
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

Being worked in by another program is deliberately not one of these. It is not a
state of a session of ours — the conversation may have no row here at all, and
one this app drives can be held by a process of its own besides — so it rides
beside the state rather than inside it, and `state` stays the authority on
whether a driver of ours is attached (§6.3.4).

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
  ['user', 'project', 'local']`, and deliberately *not* `skills: 'all'`: measured
  2026-08-17, that option makes the kit pass `--allowedTools Skill`, leaving the
  agent the Skill tool and nothing else, and a turn then ends silently with no
  answer at all. Omitting it is not "skills off" — the CLI's own defaults still
  apply, and with the settings loaded his 77 commands and skills are listed
  (bw-f1q). This reverses the
  build's first choice of `settingSources: []`. That choice bought a session
  that could not be surprised by anything on the machine, and its price was a
  chat with no commands and no skills at all, which is what the manager found:
  "no option to use skills. no option to use commands". Loading them is the
  whole feature. It follows that his `CLAUDE.md`, his hooks and his own
  commands apply inside this app exactly as they do in a terminal.
- **Every mode the picker offers can actually be taken** —
  `allowDangerouslySkipPermissions: true` at launch, while `permissionMode`
  stays whatever the session is pinned to. The two are separate flags: the
  first only *permits* the switch, the second *takes* it, so a session still
  starts asking about every tool and nothing is bypassed until he picks bypass.
  Without it the kit refuses the switch outright — measured 2026-08-17, "Cannot
  set permission mode to bypassPermissions because the session was not launched
  with --dangerously-skip-permissions" came back as a 500 to a picker that was
  offering the mode (bw-1u1).
- **Never `--bare`, never `ANTHROPIC_API_KEY`.** The CLI's own help states
  `--bare` forces API-key auth and never reads OAuth or the keychain. The
  sidecar launches `claude` in the owner's normal environment so the
  subscription he already signed into in the terminal is what runs
  (decision 5).
- **His own rules are watched** — `includeHookEvents: true`. The kit's default
  is false, and with it off only `SessionStart` and `Setup` arrive: the grey
  line this app promises for "a hook that failed" (§8.2.4) could not fire for a
  `PreToolUse` or a `PostToolUse` rule at all, which is the kind that fails
  while the agent is working. Measured 2026-08-18 against a project whose
  `PostToolUse` rule exits non-zero: with the flag off, four hook lines and no
  refusal; with it on, `Hook PostToolUse:Bash error: …` in the chat
  (bw-1u1.38). A rule starting and a rule finishing quietly are `detail` lines
  and carry no body, which is what keeps the flag cheap.
- `--include-partial-messages` for word-by-word text, and
  `--forward-subagent-text` so subagent output arrives with
  `parent_tool_use_id` set and can be nested in the feed.

Mapping: text/thinking deltas → `text.delta`/`thinking.delta`; `tool_use` and
`tool_result` blocks → `tool.started`/`tool.completed`, nested by
`parent_tool_use_id`; `canUseTool` → `ask.permission` (with `editable: true` —
the SDK accepts `updatedInput`); the multiple-choice question tool →
`ask.choice`; the plan-approval permission → `ask.plan`; the final result
message's `total_cost_usd` → `cost{kind:"usd"}`. Everything the mapping does
**not** name becomes a `note` and is drawn — see §8.2.4; the driver has no list
of kinds it is willing to hear.

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
| subagents | yes (`parent_tool_use_id`) | yes, since 2026-03-16 — defined in `~/.codex/agents/*.toml`, own model and effort, parent surfaces their threads |
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
`report <slug>` or writes `<data>/reports/<project>/<slug>.report.json`
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
Today, Yesterday, then dates — under one group that is not a day: the chats
somebody is working in this minute, which stand above all of them and say so
(§6.3.4).

A row says three things and no more, because that is what tells two chats apart
when a project has forty of them:

| line | what it carries |
|---|---|
| first | the conversation's own **name** — the brand's title for it, not ours |
| second | a **chip per card** it worked on, which opens that card, and a **chip naming the folder** it ran in |
| beside them | **working**, when a live process is holding that conversation right now (§6.3.4) |

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

**Its calls come with it.** An earlier build imported the words only, on the
grounds that "a row saying one ran tells the reader nothing they can act on".
That was true of a row with nothing inside it, and it is the fault the manager
photographed on 2026-08-17: the same session drawn in his terminal showed every
command and its output, and drawn here showed sentences alone. A past call is
imported as the same `tool.started` / `tool.completed` pair a live one emits,
its result included, so it opens on a click like any other (§8.2.4) — and the
cap counts calls with the words, because 200 rows is 200 rows however they were
made.

**A chat read in by an older reading is read again, and nothing is destroyed to
do it.** The record is read in full FIRST; only when there is a replacement in
hand does the old copy go, because a record can be moved, pruned, or belong to a
worktree that no longer exists, and the log is then the only copy the app has
(bw-1u1.26). "The old copy" is the searchable index of what was said, never the
event log: seq is handed out as one past the highest in the log, so emptying it
would restart the numbering a browser mid-chat resumes from and strand it on a
blank page. The log instead gains one `transcript.reset` and then the new copy,
which a browser already drawing the old one folds to exactly what a browser
connecting fresh would (§4, bw-1u1.27). Only a chat this app has never driven is
rewritten that way — one with live turns in it is the only copy of those.

**A partial read is not a read.** The tail of a record is held back while its
last calls have no result yet — what they will say is still being written, and
drawing an unfinished command as if it had finished is a lie the reader cannot
see. That held-back tail is then drawn by the live follower (§6.3.4) and by
nothing else, so the moment the reader looks away it is nobody's: the follower
goes with him, and a chat already marked as read is never read again. Whatever
the other program was in the middle of would be dropped for good, along with
everything said after it. So the mark is set only when the whole record was
taken; a chat left mid-command is read afresh the next time it is opened, which
costs one re-read and gains the finished work (bw-dmxj.14).

#### 6.3.3 The way back in

Constraint: a chat opens by being clicked, and a chat that is asleep is woken by
the same click. Nothing else in the list starts an agent, so decision 8 holds:
the click is the consent, and there is no second button to press.

**Clicking reads; typing forks.** Opening a chat another program holds fetches
its past and follows it (§6.3.4), and starts nothing. The second agent would
start on the first message sent into it, and that is the thing being refused.

**The refusal lives in the sidecar, at both doors.** A driver of ours is
attached in exactly two places — resuming a chat, and sending into one that has
no driver yet — and each asks the marker directory at the moment of the attempt,
reading it fresh rather than taking the remembered answer. The browser takes the
box away as well, but the browser learns who is working from a
stream, and a stream can drop: one did on the owner's machine, after which the
screen kept the last thing it had heard as if it were still true, never
reconnected, and a chat the sidecar itself called running opened with an
ordinary writing box. A lock only as good as a stream is not a lock
(bw-dmxj.12).

So the screen tells the truth about what it knows. Whether the conversation is
held arrives with the chat's own facts when it opens, rather than only from the
stream, which closed the beat after opening in which a message would have woken
a second agent (bw-dmxj.8). A dropped stream leaves the screen knowing nothing
until it is back, which it arranges itself, waiting twice as long each time from
two seconds up to half a minute so a sidecar that is down is not hammered. And a
message the sidecar refuses comes back into the box it was typed in with the
reason under it, because the conversation being taken over between unlocking the
box and pressing send does not make what was written any less the owner's.

#### 6.3.4 Which chats are being worked in right now

Constraint: a row that is asleep is an offer to wake it, and the offer is wrong
when somebody is already in there. Until this, every chat the app had not
started was drawn asleep, so a conversation being typed at in a terminal looked
exactly like one that died last week.

**The signal is the tool's own markers, not a modification time.** Claude Code
writes one file per running process at `<config>/sessions/<pid>.json`, naming
the conversation that process is on; the config directory is resolved the way
the tool resolves it, `CLAUDE_CONFIG_DIR` when set and `~/.claude` otherwise, so
an install that moved its state does not read as a machine where nothing is
running. The obvious-looking alternative was measured wrong for this: the SDK's
`lastModified` is the conversation file's mtime and nothing more, and on this
machine one genuinely working chat was silent for 488 seconds while another
wrote every 5. `SDKSessionInfo` carries no liveness field at all, so it is not
asked (bw-dmxj.3).

**A marker is believed only while its process is.** Existence is asked with
signal `0`, where a permission error still means a live process belonging to
somebody else; and on Linux the kernel's own start time for that number, field
22 of `/proc/<pid>/stat`, must still match what the marker recorded — process
numbers are handed out again, and a marker a crash left behind can name a number
the kernel has since given to something else. macOS and Windows are shipped
targets with no `/proc`, so there existence is the whole test. A machine that
answers neither reads every chat as not running, which is exactly the behaviour
this replaces and the right way to degrade.

**Nothing here writes, and one thing here is never opened.** The markers belong
to Claude Code, which cleans up after itself; a reader that starts deleting
another program's state is a race waiting to happen. The same directory holds
`<pid>.<hash>.key` files, mode 0600, which are credentials for the tool's own
messaging socket. Only `<pid>.json` is read.

**A program driving a chat counts exactly as a person typing in one.** The
marker says which it is, and nothing branches on it. Measured 2026-08-19: the
one live host-driven marker on this machine was an editor's Claude agent, seven
hours into a conversation in this repository. Somebody is working in there, and
a rule that counted only terminals would have drawn it asleep and offered to
wake a second agent on it — the whole of what this signal exists to prevent
(bw-dmxj.13).

**Held is not working, and the marker says which.** Occupancy and activity are
two facts, and until 2026-08-21 the screens drew the first and called it the
second: a terminal left at an empty prompt overnight held its conversation, and
every screen said "working" over it. The tool answers this itself where it can —
a marker written by a terminal carries `status` (`busy` or `idle`) and
`statusUpdatedAt`, which is the process saying what it is doing rather than us
inferring it from a file. Measured on this machine, 2026-08-21: of thirteen
live markers, the seven written by terminals carried a status and the six a host
drove carried none.

**Where there is no status, the record's own mtime answers — and only this
question.** The mtime is measured wrong for liveness, which is why nothing above
uses it: a working chat was silent for 488 seconds. It is right for the opposite
question, because a record that grew a moment ago is a chat producing something
now. A record written inside the last ten seconds reads as working, longer than
that as idle, and the ten seconds are chosen to cover the gap between two lines
of one answer while still letting a chat somebody walked away from stop claiming
to work while the reader watches it. The seconds shown are counted from where
the burst began, kept across beats, so a record written every second does not
reset the count to zero every second.

**And where neither will speak, nothing is claimed.** A host-driven process
writes no status, and if its record cannot be found either then the honest
answer is that we do not know — not that it is idle. Such a chat draws the badge
that says somebody is in there and no activity word at all (bw-96is).

**Cost.** A handful of files of a few hundred bytes, read at most once every two
seconds however many callers ask, so a list of forty rows costs one look at the
machine. A caller deciding something once must ask fresh instead: whether to
follow the chat being opened is decided at the click and never revisited, and a
two-second-old answer would leave a chat that started a moment ago drawn as a
dead record for as long as it stays open.

**What the list does with it.** A working chat says the word, sorts above every
idle one, and stands under a heading that says so in place of a date — they sort
above the days, so writing a day over them printed today twice on one list and
explained nothing about why they were first (bw-dmxj.11). Date alone was the
wrong order for the question the reader is asking, which is where the work is,
not what happened most recently: a chat running for an hour writes no more often
than one read a minute ago, and the list draws a screenful, so the running one
was not merely lower down, it was not drawn at all. The date on a row is the
later of our own log and the tool's index, because our log only moves when this
app drives the chat and the chat worked on elsewhere is the one that matters
most here (bw-dmxj.4). Both halves sort — the sidecar when it builds the list,
the screen again after the stream has added to it.

**It keeps up without a reload.** The set of held conversations is its own frame
on the watch stream, sent when the stream opens and again whenever it changes,
the whole set each time: it is one entry per running chat on the machine, and a
set is unambiguous where a started/stopped pair after a missed frame is not.
Each entry carries what that holder is doing and which kind of holder it is, so
a screen needs nothing else to draw the chat; the frame is sent again when a
chat starts or stops being held, or when one of them changes between working and
idle, and **not** on the passing of the seconds, or a long answer would send a
frame a beat for as long as it ran. It
cannot ride a session's own events, because a chat being typed at in a terminal
has no row here to carry one (bw-dmxj.5).

**Inside such a chat, the messages arrive.** The line says what the holder is
doing rather than asleep, and clears itself when that program stops
(bw-dmxj.10, §8.2.9), and opening one
is no longer a photograph of the record at the moment of the click (bw-dmxj.6).
There is no event to subscribe to — the other program answers to its own
terminal, not to us — so the record is watched: a beat every second and a half
is one stat, the record is re-read only when that stat has moved, and only
entries past the mark are said, so a chat nothing is happening in costs a stat
and nothing else. Every chat being read that this app is not driving is watched,
whether or not a terminal held it at the moment it was opened, because the owner
opens a conversation and types into it in a terminal afterwards (bw-4wcd.20).

---

## 7. Typed-command menus

Very important to the owner, and per-brand by construction: the driver hands the
menu up, the composer renders whatever it gets.

**Claude** — the install's real slash commands, which work in headless mode.
The menu lists them with their descriptions; picking one sends it as the
prompt. Terminal-only commands (`/login` and friends) are filtered out.
`/compact` and `/clear` are ordinary members of this list.

The list is asked for the moment the session exists, not when it announces
itself: measured 2026-08-17, a session sends NOTHING — no `init` — until the
first turn is sent to it, while `supportedCommands()` and `supportedModels()`
answer on a silent one in 0.7 s (77 commands and 6 models on this machine).
Waiting for `init` would leave a fresh chat with no menus until he had already
typed, which is the opposite of what the menus are for.

So the menu is published twice: once at start from those two calls, and again at
`init`, which adds what only it carries — `skills` (so a skill can be marked as
one) and `terminal_slash_commands` (the ones a screen like this must hide). The
kit also pushes a fresh command list mid-session when the agent discovers skills
in a subdirectory; that push replaces the stored list. Every publication is one
`session.menu` event, so a browser that opens the chat later is told the same
thing without a round trip of its own.

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
- **Right rail** — the chat's own second column, collapsible and remembered:
  the cards this chat has touched (clicking one opens it on the Board tab), the
  reports it produced, every agent it sent off, and what the work cost
  (§8.2.6).

#### 8.2.1 The open chat's own line

Constraint: what an open chat says about itself is one line high whatever it
carries, and the words that name the agent are never squeezed to make room for
what it has touched.

Why: measured 2026-08-16 (bw-p61.3), one chat's 26 card chips made a row 2277 px
wide in a pane about 700 px wide, and the model and permission text was squeezed
to 37 px — three words stacked in a column, which is the picture the manager
sent back.

**Superseded, 2026-08-20 (bw-7ks.22.10).** The first answer was to draw the
first few cards and a count. It kept the line one line high and still put the
thing that grows with the work on the axis there is least of. The header line
now carries **no** cards at all: they move into the right rail (§8.2.6), which
is a column, so twenty-six of them cost height nobody is competing for instead
of width everything is. What stays on the line is what names the chat — brand,
model, mode, and the one mark that says what it is doing (§8.2.9) — none of
which grows, so the constraint holds by
construction rather than by a count. What it has spent stays here too, beside
how full the conversation is and how much of the account's own allowance is
left — three numbers that do not grow, each wearing its own mark so a row of
them does not read as one figure (bw-7ks.22.13). The spend is the brand's own
dollars while a chat is being driven and the record's own tokens on a chat that
is not, and both count every agent the chat sent off (§8.2.7, bw-7ks.22.8). The
two are never converted into one another and never added together.

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

These same three things — a moving mark, the verb, the seconds — are what every
other screen draws about a chat as well, from one reading rather than four
(§8.2.9).

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

#### 8.2.4 Everything the agent does, on one page (bw-1u1)

Constraint: nothing the kit sends is dropped. What the agent *says* reads as
speech; everything the machine says about itself is punctuation rather than a
speaker — small, centred, out of the way, and coloured by what kind of thing it
is (the six families below); and the body of anything — a call's arguments and
its output, a hook's stdout, a whole message the app had no name for — sits
behind a click.

**The driver has no whitelist.** `pump()` translates the kinds it knows and ends
with an arm that catches every other message and turns it into a `note`. This is
a rule about the shape of the code, not a list to keep up to date: measured
2026-08-17 (bw-1u1), the switch had branches for 6 of the kit's 37 message kinds
and silently dropped 31, and the manager's `/compact` answer was one of them —
sent twice, as `system/status` (`compact_result: "failed"`, `compact_error:
"Not enough messages to compact."`) and again as an assistant message with
`model: "<synthetic>"` carrying that same sentence. A list would have lost the
next one just as quietly.

**Three ranks, and the kit names two of them itself.**

| rank | what is in it | how it is drawn |
|---|---|---|
| `say` | the agent's answer, his own turn | a bubble, as now |
| `note` | what the machine says about itself: compaction, retries, refusals, denials, mode changes, a hook that failed, a subagent starting | a chip on a hairline rule, coloured by its family, its body behind a click |
| `detail` | the machine's own breathing: `status: "requesting"`, hook starts, rate-limit pings, and any kind this app has no name for | a grey chip, under the Routine switch |

The kit's `system/informational` carries its own `level`, and its documentation
already names the treatment the manager asked for — "'info' shows only in
transcript mode; 'notice' renders in inactive gray". So `info` → `detail`, and
`notice`/`suggestion`/`warning` → `note`. Where the kit ranks a message, that
ranking is used rather than one of ours.

**Two ways of sorting, and only one of them decides what is drawn
(bw-6jq5).** Loudness says how hard a line pushes; it never said who the line
was *for*, and the screen used it for both. So the reader opened a chat already
holding every loud line the machine wrote about its own housekeeping. **This is the one place the measurement is written down**, because a count
copied into a second file drifts from the first and did (bw-6jq5.7); the source
comments point here. Measured 2026-08-20 by
`scripts/chat-shows-what-is-yours.mjs` over the manager's own record: 118 chats,
895 machine lines, folded to 510 rows on screen. **123 of those rows were drawn
before he touched a switch**, and most were bookkeeping — 37 announcing the mode
a chat opened in, not one of which was a change, and 35 saying an allowance
window was open. His words on that one: "this rate limit event seems to be for
the agent. why am I being shown it."

Every kind therefore carries an audience beside its family, in `FOR`
(`src/workbench/machine-lines.ts`), and the two axes are read separately:

| axis | decides | drawn from |
|---|---|---|
| audience — `you` / `machine` | whether the line is on screen before he touches a switch | `FOR`, read through `forWhom(kind, rank)` |
| family — the six below | what the line looks like: its colour and its mark | `BY_KIND`, unchanged |

- **What is his** is what he can act on or has to know: something stopped,
  something failed, a busy service being ridden out, the chat compacting itself,
  a mode or model that actually changed, an agent that came home having failed.
- **The machine's own** is its housekeeping: an allowance window merely opening,
  status pings, his own rules starting and finishing, memory being recalled, an
  agent sent off or home unharmed. The panel is the list of agents (§8.2.7), so
  the chat drawing a line per dispatch says the same thing twice — the manager's
  ruling of 2026-08-20.
- **A kind that means different things by how it went is settled by the driver,
  which is the only place the state exists.** Rank was doing this job and cannot:
  it has two values, and an allowance window filling up and one that has stopped
  his work are both "not simply open". The driver reads the state, decides, and
  carries the answer on the note (`audience?` on the `note` event); `forWhom`
  is what answers for a line written before that existed. See §8.2.4.1.
- **The switch is the audience**, not the family: `OFF_BY_DEFAULT = ['machine']`
  is the one fact the browser's filter and the check script both read, the
  status tree stacks families under "For you" and "The machine's own", and what
  is remembered is what he switched *off* — so a kind added later arrives
  visible rather than hidden in a group nobody opens.

**A chat is silent about the state it opened in.** Every chat wrote a line
naming its permission mode as though someone had changed it: 37 of the 118 chats
in the record above, one line each, never a second. The driver now holds "no mode
known yet" apart from a mode it has been told, and the first one it merely
*observes* pins the picker without writing a line. A mode picked on purpose still
says so, first thing in the chat or not.

**A line says what happened, never its own name.** Three kinds — an agent
updated, an agent reporting progress, the background list changing — printed
their own wire name where the sentence belongs. They now name the agent and say
what became of it. Anything the app has never met says whatever words the
message carried, from one level down or the first of a list, and falls back to a
sentence that admits the app has no words for it rather than to the name itself.

**It is checked against his own record, not a copy of it.**
`scripts/chat-shows-what-is-yours.mjs` reads the workbench store read-only,
rebuilds every chat through the real driver, folds it with the real screen's
fold, and — since §8.2.4.1 — reads the kit's own type file as well. Six things,
any one of them red being a failure: that nothing meant for the machine reaches
him unasked; that no line's sentence is its own wire name; that every kind and
state the kit declares is named in the table; that no state draws a wire word or
draws nothing; that every state lands in front of the reader it was ruled for;
and that a chat which just opened announces no mode. Measured 2026-08-21 over
122 chats and 961 machine lines, folded to 534 rows: **81 rows drawn instead of
126**, 15%. Of those 81, 37 are the opening mode line, frozen into chats made
before this build and never written again — so the same days of work started
today would draw 44. A model line is not among them: it is only ever written
when somebody asked for the model, so every one of the 6 in the record was a
real change.

**What this leaves owed (bw-6jq5).**

- **A line's wording is frozen when it is written**, so a fix to a sentence never
  reaches a chat that already holds it. Rewriting the store is `bw-x6hb` and is
  still not done; what §8.2.4.1 does instead is restate the frozen ones on the
  way to the screen, for the three that mattered.
- **The check needs a real record and is run by hand.** It opens the workbench
  store read-only and dies if there is none, so it is not in `npm test`, which
  has to pass on a machine that has never held a chat. `STORE=` points it at
  another record.

**Six families, and every kind lands in exactly one (bw-jkh2).** The rank above
decides how *loudly* a machine message is drawn; the family decides *what it
looks like*. The driver has always told a compaction from a retry from a hook
that refused the turn, and the screen threw that away: all twenty-odd kinds
reached the page as the same grey line of code type, so a chat that stalled
because the manager stopped it and one that stalled because it ran out of room
were indistinguishable. Each kind is now sorted into one of six families, and
the family carries the colour and the mark:

| family | what lands there | colour, mark |
|---|---|---|
| `stopped` | he stopped it (`user/synthetic`), the agent shut down, the chat was started over | `--warning`, a stop mark |
| `failed` | an error result, a permission denied, a model refusal, a mirror error, a hook that failed, a sign-in that went wrong, a plugin that would not install | `--danger`, a warning triangle |
| `waiting` | a busy service being ridden out (`system/api_retry`) | `--status-review`, a turning arrow, with how many times |
| `memory` | the chat compacting itself, the answer to `/compact`, what it recalled, earlier messages not drawn | `--epic`, a folding mark |
| `background` | an agent sent off, an agent reporting back, a mode or model change, anything the machine wanted him to know rather than to act on | `--info`, a small robot |
| `breathing` | hooks starting and finishing cleanly, status pings, tool-use summaries, anything with nothing to say | `--text-faint`, a dot |

Three rules hold this together, and each of them is a fault it already had:

- **The colours are tokens the app already owns**, never colours of their own,
  so red means the same thing in a chat as it does on the board and every one of
  the eleven skins gets a family palette for nothing. The same test reads
  `src/app/themes.css` block by block and names any skin short of one of the six;
  reading only `globals.css`, whose own blocks satisfy the check on their own,
  proved a test that could not fail (bw-jkh2.9).
- **The classes are spelled out one family at a time and never built from the
  family's name.** Tailwind ships a class only when it read the literal string in
  the source; interpolating the name is exactly how the board's own state
  colours went grey (bw-ufso.2, `src/lib/state-styles.ts`).
  `src/workbench/__tests__/machine-lines.test.tsx` runs the real Tailwind over
  the real tree, and has a case that goes red when the file spelling them is out
  of reach.
- **A kind whose meaning depends on how it went is sorted by its rank, not by
  its wording** — a hook that failed is `note` and lands in `failed`, one that
  worked is `detail` and lands in `breathing`. That survives a rewording; a
  string match would not.

There is no default family. The same test reads every kind out of
`workbench/src/drivers/claude.ts` — the `noteBody` switch and every `this.note`
written by hand — and fails on any that has none, so a kind added to the driver
cannot quietly arrive in grey. A kind the *kit* invents that the driver has
never seen keeps the loudness the driver's fallback gave it: `background` when
it carries a sentence, `breathing` when it is only structure.

**A run of one kind is one chip carrying a count.** A bad ten minutes on a busy
service is eight retries, which is one thing that happened eight times rather
than eight things; read as eight it buries the sentence either side of it. The
fold is on kind, rank and family and never on the words, because a retry counts
up as it goes — "1 of 5", then "2 of 5" — so folding on the sentence would fold
nothing. Family has to be one of the three even though a kind usually decides it:
the app's own asides all arrive under the one kind and carry their family beside
them, so two in a row for different families would otherwise fold and the chip
would wear the first one's colour over the last one's words (bw-jkh2.8).
The chip says the newest of the run, because that is where it had got to, and
opening it hands back every folded line in order. Quiet lines are dropped
*before* the fold rather than after it: a status ping landing mid-run would
otherwise cut the run in two and draw the same thing twice with nothing between.

**The app's own asides take the same shape.** `notice` — "N earlier messages are
not drawn here", "Continuing this chat." — was a second, plainer centred line,
unlike everything around it. It is drawn as a machine line like any other. A
note has the driver's kind to sort on and an aside has only its sentence, so the
sidecar sends the family with it (`family?` on the `notice` event); one recorded
before there were families falls back to `background`, which is the app
speaking, so every chat already on disk replays right.

**A call's body is on the call's own row.** `tool.completed` has always carried
the output across the wire and the browser threw it away, keeping only a status
word. It is kept now, with the arguments from `tool.started`, and the row opens
on a click. That is the manager's "i don't get output in chat for that".

A result that is not plain text is named and measured rather than pasted in: the
kit hands back blocks, and a block carrying a picture carries its bytes as
base64. Turning the lot into JSON put thousands of characters of encoding where
the picture belongs — invisible while the browser was discarding output, and
unmissable the moment the row started opening onto it (bw-1u1.30).

**There is no control that opens everything.** There was: Ctrl+O opened every
call and every `detail` line at once. It also GATED the quiet lines, and the
kind filter counted only what it let through — so a chat carrying thirty-three
status lines reported none, and the reader was told to press a button he did not
want to exist. Every line is drawn now, and the kind filter alone decides which
of them he sees: one switch per family under Status lines (bw-jkh2.13, §1.11 of
the app-shell design). A row opens on its own click.

**A message with no stream behind it is still drawn.** Text has only ever come
from `stream_event` deltas, so a message the kit writes itself — a compaction
refusal, an abort notice, a model refusal — arrived with its words in
`message.content` and was drawn nowhere. The `assistant` arm now draws text
blocks it has not already seen streamed, and the `user` arm draws text blocks
when `isSynthetic` is set, which is the flag that separates a turn the kit wrote
from one of his (his own turn is written to the log on send and must not be
drawn twice).

**A line that was cut can always be opened.** A quiet line's text is cut at two
hundred characters; the row's own toggle is disabled when there is no body, so a
long notification or a subagent's description ended in an ellipsis with the rest
of it reachable nowhere — against this section's own promise that the body of
anything sits behind a click. Every quiet line whose text was cut now carries
one, held where the line is built rather than in each branch so the next branch
cannot forget it (bw-1u1.39). The converse holds too: a line that says
everything it has keeps no body, and its toggle stays shut — a hook starting
names the rule and the moment, and its line already says both, which is what
keeps `includeHookEvents` (§3.1) cheap.

**One cap, everywhere the same file arrives.** A `Write` or an `Edit` carries a
whole file, and it reaches the log three times over: as the call's arguments, as
the side-by-side diff, and — in the mode that asks — on the permission card. All
three are cut to `KEPT`. The first was capped and the other two were not, so one
sizeable file still landed whole in the record; the card's copy was worse than
useless, because the browser's card keeps no arguments at all and not one byte
of it was ever drawn (bw-1u1.40, bw-1u1.42). What the kit is *answered* with is
never cut — only what is stored and shown.

**A mode change says so, whoever made it — a mode nobody changed does not.**
Switching permission mode mid-chat writes a `note`; the mode a chat merely opens
in is not a change and is drawn nowhere (bw-6jq5, above).
A chat that quietly stopped asking about tools is a trap, and bypass is now
reachable from the picker (§3.1). It says so *every* time, including the same
mode picked twice: a quiet line is otherwise skipped when the same sentence has
just gone past — which is how one thing the kit says in two shapes is drawn once
— and that rule cannot tell a repeated sentence from a repeated decision, so a
line reporting a decision opts out of it (bw-1u1.32).

The tool changes the mode by itself too — approving a plan ends plan mode — and
that path said nothing and left the picker claiming the old mode, which is the
same trap on the one road the first fix did not cover. Every `system/status`
message carries the mode in force, so the driver compares it with what it last
knew and, when it differs, says the line and republishes the pinned mode; the
sidecar stores it, so the chat does not wake up back in the old mode
(bw-1u1.43).

##### 8.2.4.1 One table of everything the kit can say (bw-iiv6)

"Allowance: the seven-day window is allowed_warning until 12:00 PM", drawn in
his own group. "again, this message and others like it are not for me... go
through all statuses and actually read them, and then properly categorise them"
— the manager, 2026-08-21. Two faults in one row, and they have one cause.

The sentence was **built by pasting the wire's own word into English prose**, so
the reader was handed `allowed_warning` and `seven_day` and left to guess. And
the audience was **derived from the wording and the loudness** by the screen,
which never saw the state at all: `allowed_warning` and `rejected` are one thing
to a rank with two values, so a window filling up rode in beside a window that
had stopped his work.

So the kit's own type file is read end to end into one table,
`src/workbench/machine-words.ts`, and for every kind and every state it holds
both answers together: **the English sentence it draws, and who it is for.**

| what the table holds | how many | example |
|---|---|---|
| kinds the kit declares, all named | 38 | `rate_limit_event`, `system/hook_response` |
| states over 14 of those kinds | 47 | `allowed_warning`, `error_max_budget_usd` |
| kinds deliberately silent, each with its reason | 4 | a guess at what he might type next belongs in the writing box |

Four rulings hold it:

- **The driver decides the reader, because the driver is the only thing that has
  the state.** It puts the answer on the note (`audience?` on the `note` event),
  and the screen takes it over anything it would have guessed. The allowance is
  the case that forced it: merely running low is the machine's, and only a window
  that has actually turned work away — or one that wants credits, which the kit
  files on `errorCode` beside a rejected status and never on `status` itself —
  reaches him, saying "nothing more runs until 03:20 AM".
- **A state the table has never met is readable and quiet**, never its own wire
  name: the sentence admits the build has no words for it, and it waits on the
  machine's side. A wire word that must be shown at all has its seams opened up
  (`inWords`), which is the fallback and never the substitute.
- **The lines already in the record are restated on the way to the screen.**
  Wording is frozen at write time (bw-x6hb), and three sets of frozen lines were
  worth restating rather than leaving: the 37 that announced a chat had stopped
  asking before it runs things by naming the setting — "Permission mode is now
  bypassPermissions." — the allowance sentences from his screenshot, and the
  lines whose whole text was the kind itself. Only wording the app itself wrote
  is matched, so anything reworded since passes through untouched.
- **The picker says what the setting does**, not what it is spelled: "Skip all
  checks", not `bypassPermissions`. The one line on this screen that MUST be read
  was the one written in the machine's own language.

The check reads `sdk.d.ts` as text rather than as types — a union member the kit
adds is not a type error anywhere, which is exactly how these gaps opened — and
then drives the real driver once per kind and state. It fails on a kind or state
the table has never heard of, on a sentence with an identifier-shaped word in it,
on a state that draws nothing, and on one that lands in front of the wrong
reader.

#### 8.2.5 What this costs the log

Every rank is stored; only the drawing differs (§4 — the log is the transcript,
and the rank now decides a line's family and its colour rather than whether it
is drawn at all).

Measured rather than assumed, with `scripts/measure-quiet.mjs`, 2026-08-19 —
two turns **in the mode that asks**, one running a command and one writing a
file, on this machine with this owner's hooks installed and every hook event
forwarded (§3.1):

| | events | bytes |
|---|---|---|
| the whole log | 82 | 79,300 |
| quiet lines, every rank | 49 (60%) | 17,104 (22%) |

The mode matters and the first run got it wrong: it measured the mode that never
asks, so not one permission card was written during it, and the total it
reported was not the total anyone pays (bw-1u1.44). Every chat starts in the
asking mode.

Inside those 17,104, three sources, and they are different shapes of risk:

- **a hook that answers at length** — `hook_response`, 12,474 B of the 17,104,
  and `hook_started` 3,546 B beside it. One hook on this machine prints 10.7 KB,
  which is why every body is cut to the same 4,000 characters a command's output
  is (`KEPT`, bw-1u1.18, bw-1u1.33), and why a line that says everything it has
  keeps no body at all: dropping the whole-message body from the two hook lines
  that need none halved what an install with hooks stores (bw-1u1.39). An
  install without hooks pays none of this
- **`system/status`** — one per API request, four across two turns for 600 B.
  The most frequent quiet line and the cheapest; it is `detail`, so it costs a
  row and no attention. It is also where the mode in force is read (bw-1u1.43)
- **the permission card** — one per call the settings do not already allow,
  383 B for a one-line file here. It carries the call's arguments, so a card for
  a `Write` is as big as the file: cut to `KEPT` like everything else that
  carries one, which caps it at about 4 KB (bw-1u1.42)

Two earlier versions of this paragraph were wrong in the same way — reasoning
from the shape of the code, and then measuring a mode nobody runs in
(bw-1u1.36, bw-1u1.44). The measurement's own finding still stands and is the
reason to keep taking it: none of these is where the log's weight actually is.
The menu of what a chat can do is republished whole every turn — 58,969 B of
these 79,300, three quarters of the log, and not a quiet line at all. That is
bw-7bj.

#### 8.2.6 The right rail (bw-7ks.22.9)

Constraint: the chat has a second column, on the right, and it is the reader's
to shut. Open, it is a narrow fixed-width column beside the transcript; shut, it
is a thin edge with a handle and the transcript takes the width back. The choice
is remembered for the browser and survives a reload — a rail that comes back
open every time is a rail that gets shut every time.

It is the left rail turned around, and deliberately the same component
(`chat-rail`, §8.2): in flow on a wide window with the transcript between the
two, absolutely placed and sliding over the transcript on a narrow one, where a
click outside shuts it. Two rails and a readable conversation do not fit in a
phone's width, and the conversation is what the reader came for.

What it holds, in this order:

- **The agents it sent off** — §8.2.7. The tallest thing in the rail, the reason
  the rail exists, and first in it because it is the only part of the column
  that MOVES. Cards and reports are a record and will still be there in an hour;
  a helper four minutes into its work is the thing the reader opened this rail
  to look at, and it is not going below two lists that are finished with
  (bw-7ks.22.33 — this order is the built one, and a test pins it).
- **The cards this chat has touched** — all of them, one per line, id and title,
  clicking through to the Board tab. This is where they live now (§8.2.1). A
  card touched only by an agent the chat sent off is still this chat's card,
  which is the fault §8.2.7 fixes on the way past.
- **The reports it produced** — `report.available` already crosses the wire and
  is drawn nowhere.
What it has spent does **not** live here. Manager's ruling, 2026-08-20
(bw-7ks.22.13): the running spend and how full the conversation is are numbers
that say whether the work can go on at all, so they stay on the chat's own line
(§8.2.1) where nothing has to be opened to see them. The rail is the reader's to
shut, and a number behind a shut rail is a number nobody reads.

A rail and not a tab: its whole job is to answer *what is happening away from
here* without leaving the words that sent it.

#### 8.2.7 Every agent the chat sent off (bw-7ks.22)

Constraint: work a chat hands to another agent is a **row you can see, open and
steer**, from the moment it is sent to the moment it answers. Today it is a grey
line ranked `detail` — grey and easy to scroll past — and then silence
until a result appears in the parent's speech as if the parent had done it.

**One row per piece of sent-off work**, and the panel is a work panel rather
than a subagent panel: the kit's own list of background work names four kinds —
a helper agent, a command left running, a watch, a scripted run — and all four
are work the chat is waiting on, so all four get a row and the kind is a mark on
the row.

| column | what it says | where it comes from |
|---|---|---|
| what | the brief in its own words, one line | `task_started.description` |
| kind | helper, command, watch, run | the background-work list |
| model | which model this one runs | the kit's list of agents, and the model on the helper's own messages |
| for | how long it has been going, live | `task_progress.usage.duration_ms`, counted from the start where absent |
| spent | tokens, and how many calls it has made | `task_progress.usage` |
| doing | its own last line, refreshed about every 30s | progress summaries |
| state | running, waiting on you, done, failed, stopped | `task_notification.status` |

**Every one of those numbers already arrives and is thrown away.** Nothing here
needs a new source; it needs the driver to stop discarding what it is handed.
The one genuinely new cost is the progress sentence, which re-uses the helper's
own cache rather than paying for a fresh read.

**Its own conversation opens from its row** (bw-7ks.22.4). A helper's turns are
a conversation like any other and are drawn by the same renderer as the parent's
— the transcript and the live stream are one code path (§4), and a helper is
just a stream with a parent. Clicking the row opens it in place of the parent's
transcript, with the way back where the reader expects it.

**Steering is three tiers, and the honest reason there are three**
(bw-7ks.22.5). Neither brand gives anyone a private input channel into a running
helper, so we do not pretend to have one:

1. **Direct** — stop it, or park it and let it run on. Both are the kit's own
   controls (`stopTask`, `backgroundTasks`) and both are exact.
2. **Its own asks** — a permission ask a helper raised is answered on the
   helper's row, attributed to the helper that raised it, not to the parent it
   arrived through.
3. **Relayed** — a typed message goes to the parent, naming which helper it is
   for, because that is the only road either brand offers. Codex's own
   documentation says to ask the parent to steer a running helper; Claude has
   no other door either. The row says the message was relayed, so nobody reads
   a delivered word as a private one.

Six things about the built shape that the tiers above do not tell you, each of
which is a way of getting it wrong (kit 2.1.237, measured 2026-08-20):

- **The two direct controls take two different ids.** `stopTask` takes the task
  id, which is what the row is keyed by; `backgroundTasks` takes the `tool_use`
  id of the call that started the work. The driver keeps the reverse of the map
  it already had so a row can answer both. Hand over the wrong one and the whole
  turn goes to the background instead of one agent — which is why parking is
  proved by a live run and not by a fixture. And `backgroundTasks` says no to
  one thing only: no work of that name was in the FOREGROUND. So a no is not a
  failed click, it is an answer about the work — it is already in the background
  — and the row takes it as one (bw-7ks.22.24).
- **A row is ended by two writers, and a stop outranks both.** The kit sends its
  own `task_notification` about the work, and the CALL that dispatched the work
  comes back separately with a `tool_result` carrying what the run cost — and an
  interrupted call's receipt is not marked in error, so it reads as a clean
  finish whatever became of the work. Either can land last. So a stop is written
  down the moment the kit takes it, and once a row reads `stopped` nothing later
  moves it: not the receipt, not a second notification, not the fold replaying
  the whole record from the start. Without that, what he did is quietly rewritten
  into `done`, with no error and nothing on the screen to say so (bw-7ks.22.27).
- **The kit's permission hook names the call, not the agent.** `canUseTool`
  carries an `agentID`, but the task messages carry no `agent_id` at all, so
  that id cannot be matched to the `task_id` a row is keyed by — it is a
  different id-space. Attribution is worked out instead from the parentage every
  one of a helper's words already carries: the driver notes, as it reads them,
  which calls a helper made, and `toolUseID` then leads back to the call that
  sent the helper and from there to its row. Nothing new is asked of the kit.
- **A row waiting to be answered says so itself.** It reads `waiting on you`
  from the moment the ask goes out until it is answered, said by the driver
  rather than waited for from the kit's next report about that task — which is
  the whole reason a row's state is not a boolean. Parked arrives the other way
  round, from the kit: `task_updated.is_backgrounded`, which is the ONLY message
  that carries it — a launch does not, so work started in the background arrives
  looking exactly like work started in front of you, and the click is what finds
  out which it was.
- **Which controls exist is a per-session answer**, carried on `session.menu` as
  `agentControls` and defaulting to none. A brand declares only the tiers it
  has, a chat nobody is driving declares none — which is the truth, there is
  nothing there to steer with — and a tier not declared is not drawn. The relay
  sends the turn to the parent first and marks the row second, so a row never
  claims a relay that never left.
- **A click that does not land says so.** All three tiers come back to life the
  moment the ask is answered, a refusal included — so nothing on the screen
  tells a refused stop from one that worked unless the refusal itself is drawn,
  and the reader walks away believing an agent is stopped that is still running.
  It is drawn where it happened: under the two controls on that row, and under
  the relay box in the pane, in the far end's own words. The relay also keeps
  the typed words in the box, because emptying the box is how the pane says they
  went (bw-7ks.22.34).

**Four faults this closes on the way past**, each of which is why the picture is
missing today rather than merely thin:

- a helper's words are never forwarded, because the driver does not ask for them
  (bw-7ks.22.2);
- "sent off" is filed as `detail`, so the one line that exists is hidden by
  default, and the line saying it came back is not drawn at all: the driver
  skips a quiet line a line just before it already said — meant for the kit
  reporting one thing in two shapes — and a helper's own words were kept in that
  same breath, so a helper answering "DONE" ate "DONE (completed)", which quotes
  it by design. The panel then said finished while the conversation never said
  it came home (bw-7ks.22.6);
- a chat read back from the record has **no agents at all**: not a flattened
  helper, not a dropped one — none. The kit files a helper's whole conversation
  in a file of its own beside the record, `<chat>/subagents/agent-<id>.jsonl`,
  with an `agent-<id>.meta.json` naming the call that sent it off, and the
  chat's own record keeps one call and one answer. Nothing here ever opened
  that directory, so a chat found on disk had an empty panel, nothing to open,
  and a card only a helper ever touched on no chat anywhere. The fix reads
  those files at import and says them as the events the live wire would have
  carried, so one drawing serves both paths (bw-7ks.22.7, kit 2.1.237,
  measured 2026-08-20; the tail reader's line discarding sidechain messages is
  vestigial — no such line reaches a parent's record on this version, and it
  still guards against pointing the tail at a helper's own file);
- **how a helper went is on the call that sent it, and nowhere in its own
  record.** A helper's file says what it did and stops there: nothing in it
  marks a last line as last, let alone as a failure, and a helper that gave up
  said so only in words. The answer is the `is_error` on the `tool_result`
  answering the Task call — the same signal the live driver reads to choose
  `done` from `failed`. Both the reading paths ignored it and drew every row
  finished, so a helper watched failing was green when the chat was reopened,
  and one that failed while a reader followed it went green the moment its
  answer landed (bw-7ks.22.28);
- a chat nobody is driving says nothing about what it cost, and what it cost is
  mostly the work it sent away. The claim this job opened with — that a turn's
  cost counts the main loop only — is **false for a live Claude chat** and was
  measured false on the way past (2026-08-20, kit 2.1.237): a turn that sent one
  agent off reported `$0.2399167`, which is its own `$0.232197` plus that
  helper's `$0.007720` exactly, and the kit's own contract says the dollars
  cover the same calls as its per-model totals — main loop, Task subagents,
  sidechains and workflow agents alike. Only its `usage` field is main-loop-only,
  and that is the field the fullness gauge wants. What was genuinely missing is
  the other chat: one found on disk has no result message to read a figure off,
  so it showed no spend at all. It now says one, worked out from the record —
  every turn the chat itself was answered on, plus the whole of every helper's
  own file — and in tokens, because tokens are what a record states and a price
  worked out here from a table of our own would be a guess wearing a dollar sign
  (bw-7ks.22.8, and see bw-wg89 for what the same misreading does to the spend
  view).

**One seam, both brands** (§2.1). The vocabulary grows by three lines and a
command family, and a brand is still one driver file:

- `agent.started` / `agent.progress` / `agent.finished` — the row and its
  numbers;
- `message.started` gains `parentToolCallId`, exactly as `tool.started` already
  carries it, so a helper's speech is filed under its own row by the same
  attribution that already files its calls there;
- `agent.stop`, `agent.park`, `agent.say` — the three tiers, going the other
  way.

Codex helpers shipped 2026-03-16 and are the same shape: their own definition
file, their own model and effort, threads the parent surfaces, steering asked of
the parent. So the capability matrix row that said Codex has none is stale, and
is corrected in §3.3. Where a brand cannot do one of the three tiers, that
control is hidden and nothing is faked (decision 13).

#### 8.2.8 What the plan has left (bw-malh)

Constraint: the chat's own line says how much of the account's five-hour window
is gone and when it comes back, and how much of the week is gone beside it, and
clicking either opens the whole usage picture — the week scoped to a model,
credits, and what the spending has gone on.

Both figures are drawn, and each carries its own colour: the week is what a run
of long days hits first, and one colour over both would hide a week at 96%
behind a session at 12%. The week shows no countdown — it comes back in days,
which is a panel line, not a status line.

Why: the line already carried this turn's dollars and the conversation's room,
and neither is the thing that actually stops the work. What stops it is the plan
window, and until now it could only be read by leaving the app and typing
`/usage` in a terminal — so the first the reader knew of it was an agent
refusing to run.

Three decisions worth keeping:

**Account-wide, so the server owns it and no screen asks.** Every chat on the
machine spends the same allowance. The sidecar reads it on a beat of its own —
every thirty seconds, for as long as any page is connected and not once when
none is — and says it down `/watch` as a `usage` frame. That frame belongs to no
session: it is never written into a chat's transcript, and a page opening is
told the figure in hand immediately, so two chats cannot disagree about one
number. `GET /api/workbench/usage` remains for a caller that wants it once.

Polling from the browser is what this replaced. The chips then moved only when
the chat they sat on moved, so a conversation left sitting while another spent
showed a figure minutes old (bw-dmoe).

**The kit is asked through one helper of ours, and nothing is derived.** The
five-hour and weekly figures are the server's, reached through the Claude SDK's
own `/usage` channel. The sidecar keeps a session of its own with nothing to say
for the purpose, and shuts it down after four idle minutes — measured
2026-08-20: 1.9s cold, 0 tokens. Asking whichever chat happens to be running was
tried and removed: the answer then depended on which chat that was, and the kit
serves a five-minute-old snapshot from disk, without saying so, when its live
read fails.

That snapshot is why an answer is weighed before it is drawn (`believable()`).
A window whose percentage has FALLEN while its reset time has not moved cannot
be true — an allowance is not un-spent inside its own window — and neither can
an answer that has dropped the five-hour or weekly figure altogether. Either is
refused, the last good reading stands, and the next read is five seconds later
rather than a full beat. A real fall comes with a new reset time and is
believed. Nothing here counts tokens or adds up dollars to guess at a
percentage; a guessed allowance is worse than none.

**A window nobody has draws nothing.** On an API key, on Bedrock, on Vertex,
`rate_limits_available` is false and both chips are absent — because a chip reading
0% there says "nothing spent", which is the opposite of "this account has no
plan window at all". The reading is in `src/workbench/plan-usage.ts`, shared by
the sidecar that normalises the kit's answer and the browser that draws it, and
tested against a real captured answer rather than a hand-written one: the answer
carries more than its published type admits, including windows under codenames
no plan of ours has.

Colour is a floor, never a ceiling: the server ranks each window itself and its
ranking is believed, but 80% and 95% raise the ranking anyway, so a build that
sends no severity cannot draw a calm chip at 99%.

**The chips are buttons, because they are the only door.** A `Badge` renders a
`<span>`, and a click handler on a span is reachable by mouse and by nothing
else — no tab stop, no Enter, nothing for a screen reader to press. These chips
are the only way into the usage picture anywhere in the app, so each is a real
`<button>` inside the badge (the pattern `ReportChip` already uses) and
announces the whole sentence rather than its own shorthand: `wk 56%` read aloud
is not a sentence. `scripts/shoot-plan-usage.mjs` proves it the way a reader
would — it focuses the chip, checks the focus actually landed on it, and presses
Enter — and that check earned its keep immediately by catching a stale served
bundle. What it does **not** yet do is keep the keyboard inside the panel once
it is open; that gap is every overlay in this app, not this one, and is filed as
bw-4dw5.

#### 8.2.9 What a chat says about itself, on every screen (bw-96is)

Constraint: a chat says the same three things wherever it is drawn, and they are
three separate things — what it is doing this second, where it stands when it is
doing nothing, and who holds it.

Why: four screens answered this four ways and none of them answered all of it.
The open chat's line drew one word; a row in the list drew a pill that was
either "ready" or "working"; a board card drew a pulsing dot and an activity; the
glance strip drew a dot, a word and a count of its own. The loudest of them, the
green **working** pill, was derived from the marker directory alone — occupancy,
not activity — so it sat on a terminal that had been at an empty prompt since
last night, and a chat that really was answering said nothing different. The
manager's reading of it, 2026-08-21: "just make sure everything about the state
of chat is intuitive. currently its awful."

**One reading, four drawings.** `src/workbench/chat-state.ts` is a pure function
from what the driver last published and what the sidecar says about the holder,
to the three facts. Every screen draws that and nothing else, so they cannot
disagree; it is a function rather than a component because the sidebar row, the
chat's own line, the board card and the glance strip all need the answer and
only two of them are in the same tree.

**The mark is the same mark, ours or somebody else's.** A spinner, the verb in
its own words, and the seconds — the picture §8.2.2 defines for our own agent —
is what a chat a terminal holds draws too, because to a reader those are the
same fact. A chat waiting on the reader wears a different mark, a hand, since it
is not working and saying so is the point.

**The badge never stands in place of the doing.** Another program holding the
conversation is a third fact, drawn as an `external` badge beside the mark, with
the kind of holder in its tooltip — a terminal, or a program driving through the
kit. It is drawn only on chats somebody else holds, so it means something by
being there; the word it replaced meant "occupied" and was read as "working",
which is the whole of what went wrong.

**A held chat has no writing box, and the line in its place agrees with the
mark.** The box used to be drawn in full and refuse every keystroke — a locked
door where there is no door — because a message typed into it would wake a
second agent on the same record (§6.3.3). What stands there instead is one
sentence, and its words come from the same reading the mark does (`heldLine`),
so the two cannot contradict: they *have this chat open*, and only when the mark
says working does the sentence add that they are working in it now. It promises
the box back when they **let go**, not when they stop — a terminal that has gone
quiet still holds the conversation, and the box does not return until it exits
(bw-96is.9).

**A chat that is asleep says nothing at all.** Most of a list is asleep, and a
pill on every row is a pill on none. The mark appears only when there is
something to say — working, waiting, reachable, or held.

**One clock for the page.** The seconds come off a single interval shared by
every chip, so a list of forty rows costs one beat a second rather than forty,
and the number they are all counting is the same number.

### 8.3 The board tab

Unchanged, plus one thing: decision 11 — a card being worked on shows its live
chat. `src/components/bead-card.tsx` gains a single `<CardLiveChat
beadId={bead.id}/>`, which renders nothing at all unless a running session is
linked to that card, and otherwise shows the same mark every other screen draws
(§8.2.9) — spinner, verb and seconds while it works, one word where it stands
otherwise — clicking through to the chat. The pulsing dot it used to draw said
"attached" and was read as "working", and it kept pulsing over a chat sitting
idle for as long as the tab stayed open.

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

### 8.5 Reports named in a chat

A report in a chat is a way through to it, never a viewer of its own
(bw-7ks.21.15). The chip on the chat's line and the card a `report.available`
event drops into the stream both push the report's own address under this
project — `/project?id=…&tab=reports&report=<slug>` — where the app draws the
report out of its own parts (`src/app/project/report-tab.tsx`). One report, one
place, one address, and no page held in a frame anywhere in the chat.

The card in the stream carries what decides whether to stop and read it: the
report's title, and a mark when a question on it is waiting on the manager's
answer. Both come from the one shared answer to "what reports are there"
(`useReports()` in `src/components/reports.tsx`, which goes through `apiUrl()`
like every other call in the app).

The self-contained page the report tools build (`GET
/api/reports/page?project=&slug=&path=`) still exists: it is what the builder
prints a link to for a reader with no app in front of him. Nothing in the app
sends anybody to it.

### 8.6 Shared state

The repo has no global store. It has one idiom for cross-component state:
`useSyncExternalStore` over a module-level listener set (`src/hooks/use-theme.ts`).
The workbench follows it — a single module-level store owns the one global
`EventSource` and the per-session state that the tray, the strip and the board
cards all read. One connection for the whole app, not one per component.

### 8.7 The two token numbers

The gauge on a chat's status line is a way in, not a label. Clicking it opens
`src/workbench/token-view.tsx`, which holds the only two token figures a chat
has and says in words which of them resets.

**Now — what fills the window.** Only the kit can answer this. The record on
disk holds what each turn COST, never what the next prompt will be MADE OF: the
system prompt, the tool schemas, the skills and the memory files are never
written into it. So `ClaudeDriver.windowNow()` asks the SDK's
`Query.getContextUsage()` down the channel that is already open — measured
2026-08-20 at ~1.4s and **0 tokens**, no turn taken — and
`src/workbench/window-now.ts` normalises the answer for the browser. Three
kinds of band come back and they are kept apart: the filled ones (which sum
exactly to `totalTokens`), the room ("Free space", "Autocompact buffer"), and
the deferred tools, which are NOT in the total because they cost nothing until
something calls them. `messageBreakdown` is the kit's own walk of the messages
and does **not** reconcile with the conversation band it sits under — 6,587
against a 4,504 band on a fresh chat — so `Inside.total` is the parts added and
the panel says so on the page rather than quietly implying agreement.

A chat this app is not driving cannot be asked at all, and is told so:
`NOT_OURS_TO_ASK` is printed verbatim rather than a figure worked out here from
a guess (decision 13).

The gauge takes its window from the same answer. The kit's ordinary messages
almost never state one, so the line sat on the 200,000 default while a session
actually running on a million read 3% full — and the panel that gauge opens,
which asks outright, said `26k/1M` on the same screen (bw-3ug7.11). So
`adoptWindow()` asks once per session on the first turn that reports fullness,
and re-states the gauge if the answer differs. `reads()` says a window of a
million as `1M`: written in thousands it came out `1000k`, four digits nobody
reads as a million (bw-3ug7.12).

Both this panel and the plan-usage panel beside it stand at the height of the
screen and scroll their own bodies. They were each one growing box with
`overflow-y-auto` and no ceiling, so a long picture ran off the bottom of the
window with its last rows unreachable (bw-3ug7.13, bw-3ug7.14).

The chip's test hook belongs on the painted pill, not on the button inside it.
The line above a conversation is checked by measuring these hooks against each
other, and a hook on the inner button reports a box a padding narrower than
what is drawn — which would have kept that check passing straight through the
overlap it exists to catch (bw-3ug7.9). The button carries a hook of its own,
`context-chip-open`, as the plan chips do.

**Ever — what the task has spent.** `src/workbench/token-picture.ts`, over the
chat's own record file, whole. Two traps, both measured on record `bde56edd`:

1. One answer is written as SEVERAL lines — thinking, words, each tool call —
   and every one of them repeats that answer's usage under the same
   `message.id`. Summing lines billed 722,555,101 against a true 531,313,155,
   36% high and worse the harder the agent works. So usage is deduplicated by
   id (`turnsIn`) — while tool calls are counted on EVERY line, because the
   blocks are divided between them rather than repeated, and deduplicating both
   lost two calls in five.
2. `getSessionMessages()` hands back only the turns since the last compaction —
   37 turns of a record holding 2,313. `allLines()` in
   `workbench/src/record-tail.ts` reads the file whole instead (124ms on 30MB),
   which is the only source that spans every forgetting.

Helpers are added in from their own files (`helpersOf`), so work sent away is
counted rather than lost with the agent that did it.

**One route, both halves.** `GET /api/workbench/tokens?session=<id>` returns
`TokenPicture`: `window` with `windowNote`, `spent` with `spentNote`. Either
half may be null, and when it is, the note is a sentence a manager can read —
the panel prints it rather than inventing a reason. Read once on open: neither
number moves fast enough to follow, and the click pays for both.

No price, ever: tokens are never converted into money anywhere in this app
(decision 12, §8.4f).

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
search, spend, plan usage, the token picture, report viewer), `tests/e2e/workbench.spec.ts`, this
document.

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
- The body of anything is cut to `KEPT`, four thousand characters. A file
  bigger than that cannot be read to its end from the chat: the cut line says
  how many characters were left out, and the whole of it is on disk in the
  kit's own record. Raising the number is a storage decision, not a drawing
  one (§8.2.5).
- Every hook event is forwarded (§3.1), so an install with hooks pays for its
  own rules: one hook on this machine answers with 10.7 KB, and hook lines were
  12,474 of the 17,104 quiet bytes measured. Cutting every body to `KEPT` and
  dropping the two lines that need none is what keeps that bounded. An install
  without hooks pays nothing.
- That the tool changes the permission mode by itself is held at driver level
  rather than in the browser, because whether the agent calls `ExitPlanMode` is
  the model's decision and a standing browser check resting on it goes red for
  no reason. It was watched happening once by hand instead, 2026-08-19
  (`scripts/README.md`).
- The plan figures come from the kit's own usage channel through a method the
  SDK shouts is unstable (`usage_EXPERIMENTAL_…_DO_NOT_RELY_ON_THIS_API_YET`).
  A version that renames or drops it degrades to `available: false`, which draws
  no chips at all — the state this feature replaced — and never to a wrong
  number. The alternative was adding up tokens to guess at a percentage, and a
  guessed allowance is worse than none.
- The reading always costs a session of its own: the sidecar starts one with
  nothing to say, asks it, and shuts it down after four idle minutes. It sends
  no message and spends no tokens (measured 2026-08-20: 1.9s cold, 0 tokens),
  but it is a process, and an install that never opens a chat still starts one
  the first time a page connects.
- The figure can be up to thirty seconds old, or thirty-five when an answer was
  refused as the kit's stale snapshot. A five-hour window does not move fast
  enough for that to mislead anyone.
- A refusal that never ends would freeze the figure, so only the account's own
  two windows can cause one. A per-model row that stops appearing is believed:
  a model legitimately drops out of a window it is no longer used in.
- Who is working in a chat is Claude's answer only. Codex writes no markers we
  read, so a Codex conversation somebody else is driving is drawn asleep and
  offered like any other (§6.3.4).
- The marker directory's shape is not a documented contract. It is read
  defensively — a half-written or unrecognised file is no marker rather than an
  error — and a version that moves or renames those files degrades to "nothing
  is running", which is the state this feature replaced.
- Only Linux tells a reused process number from a live one. On macOS and
  Windows a marker a crash left behind whose number the system has since given
  to something else reads as a working chat until that program exits.
- The lock only sees this machine. Two copies of the app on one machine share
  the markers and so agree; a conversation held on another machine is invisible
  to both, which is a remote-machines question (§10, `bw-4rw`).
- Following another program's chat is a poll, not a subscription: a stat every
  second and a half per chat being read. It is bounded by what is on screen —
  only chats somebody has open are followed — and the beat does not hold the
  sidecar up.

- The sidecar runs its TypeScript through a flag node still calls experimental
  (§1.2). It buys a chat server with no build step between an edit and a run,
  at the price of the import rule in §1.3 and of a flag that could change under
  us; a node that drops it degrades to a Chat tab that never comes up, which is
  loud rather than subtle.

Three faults found under this section's work are filed rather than fixed, and
each is still open: the menu of what a chat can do is republished whole every
turn and is four fifths of the stored log (`bw-7bj`); a frontend-only change is
never embedded in the installed binary, so the built product keeps serving the
previous screen unless the frontend is built first by hand (`bw-a4o`); and
every browser check and screenshot run leaves its chats on whichever list it
was pointed at (`bw-guo`).

Two more were found while the sent-off-agent panel was built and are filed
open: a browser that loses its stream and reconnects is subscribed again but
never re-follows the chat it was reading, so a chat another program is driving
goes quiet after the first drop (`bw-tous`); and the chat's own working line
keeps a spinner on a shell command that has already come back, because the line
is only rewritten when the next call starts (`bw-qxep`).

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
