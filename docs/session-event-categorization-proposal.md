# Provider-neutral session event categorization

Status: proposal  
Scope: Claude and Codex session records, live provider events, and future providers  
Decision owner: manager

## 1. Outcome

Every non-message event reaches the transcript through one provider-neutral
model. A reader can tell what happened, what it acted on, whether it changed
anything, and whether it was dangerous without knowing the provider's tool or
wire vocabulary.

Commands receive one additional guarantee:

## Innermost command invariant

**Categorization runs on the command that actually executes, never on the
provider call, orchestration program, shell launcher, remote launcher, or
working-directory prefix that carried it.**

For example, all of these classify as `test`, with `npm test` as the semantic
command:

```text
Claude Bash { command: "npm test" }
Codex exec { cmd: "npm test" }
/bin/bash -lc 'npm test'
env CI=1 bash -c 'npm test'
cd /repo && npm test
docker exec app sh -lc 'npm test'
ssh buildbox -- bash -lc 'npm test'
```

The wrappers are not thrown away. They remain structured context on the row and
the untouched provider input remains behind the row's disclosure. They simply
do not decide that `npm test` is “Bash”, “exec”, “Docker”, “SSH”, or a generic
script.

This invariant has one safety qualification: a boundary such as `ssh`,
`docker exec`, `kubectl exec`, `sudo`, or `xargs` remains an effect and risk
boundary even after its inner command is found. `ssh host rm -rf cache` is
categorized from `rm -rf cache` as a destructive deletion, and also records
that it ran remotely. Unwrapping must reveal risk, never erase it.

## 2. Why the current shape is insufficient

The current implementation has useful English rules, but provider decoding,
shell parsing, semantic classification, risk detection, and presentation are
too close together.

- Claude's `Bash.input.command` is already close to the command. Codex may put
  the same command inside a JavaScript code-mode call, JSON arguments, an
  app-server `commandExecution`, or a shell launcher string.
- A tool name is not a capability. Claude MCP names look like
  `mcp__server__method`; Codex live MCP calls are named `server/method`; MCP end
  events carry server and method separately.
- Every non-browser Claude MCP call currently becomes a generic network read,
  even when it authenticates, writes, sends, or deletes.
- Codex replay currently ignores its native MCP completion event even though it
  carries the server, method, arguments, result, duration, and read-only hint.
- Historical Claude attachment records include hook failures, queued commands,
  files, edits, diagnostics, and task state, but the message importer ignores
  the entire attachment family.
- Regex-only command peeling can find executable-looking words inside quoted
  data, source code, a here-document, or a search pattern. That can produce a
  confident but false sentence, which is worse than showing the raw call.

The fix is a normalization pipeline with explicit intermediate values rather
than a larger table of provider names.

The corpus behind this proposal was measured recursively rather than sampled:

| Source | Records/events observed |
| --- | ---: |
| Claude session files | 2,836 |
| Claude tool calls | 154,446 |
| Claude attachment rows | 212,985 |
| Claude MCP calls | 2,201 calls across 39 tool names |
| Codex session files | 128 |
| Codex response items | 36,566 |
| Codex event rows | 27,212 |

The counts are evidence for the first implementation, not a closed vocabulary.
New shapes must take the visible `unknown` path until deliberately classified.

## 3. Canonical event model

Provider adapters emit one of these semantic event families. Provider names
and native identifiers remain provenance, not categories.

| Family | Meaning | Examples |
| --- | --- | --- |
| `action` | Work was attempted through a tool | command, file read, MCP call, web search |
| `action_result` | An action progressed or ended | output, error, duration, diff, generated image |
| `permission` | Work waits on a person or policy | command approval, MCP elicitation, denied tool |
| `delegation` | Work was sent elsewhere | helper, background command, monitor, workflow |
| `hook` | A configured rule ran | started, succeeded, blocked, failed, cancelled |
| `status` | Provider/service state changed | retry, rate limit, authentication, interruption |
| `context` | Conversation storage/state changed | compaction, context use, model or mode change |
| `attachment` | A file or rich object entered the chat | image, document, persisted file, edit, diagnostic |
| `bookkeeping` | Provider-private indexing with no user meaning | title cache, file snapshot, queue index |
| `unknown` | A new shape has no rule yet | visible in “show everything”, with bounded raw body |

An `action` has independent dimensions. A single enum cannot express them
without eventually lying.

```ts
interface NormalizedAction {
  id: string;
  provider: 'claude' | 'codex' | string;
  sourceKind: string;
  sourceName: string;

  // What kind of object or system was acted on.
  domain:
    | 'board' | 'version-control' | 'file' | 'code-search'
    | 'build' | 'test' | 'lint' | 'process' | 'web'
    | 'service' | 'data' | 'agent' | 'system' | 'unknown';

  // What happened to it. More than one may apply.
  effects: Array<
    'read' | 'search' | 'create' | 'update' | 'delete'
    | 'execute' | 'communicate' | 'authenticate' | 'wait'
  >;

  risk: 'read-only' | 'mutating' | 'destructive' | 'unknown';
  target?: string;
  summary: string;
  execution?: NormalizedExecution;
  confidence: 'schema' | 'parsed' | 'heuristic' | 'unknown';
  provenance: ProviderProvenance;
}
```

`domain` chooses the mark and broad visual band. `effects` supply accurate
verbs and filters. `risk` controls destructive emphasis and approval treatment.
The same Linear service can therefore produce a service/read action for
`get_issue`, a service/update action for `update_issue`, and a
service/delete/destructive action if it exposes a destructive method.

## 4. Provider boundary: extract facts, do not interpret them

Each provider adapter has one job: translate its wire shape into a lossless
candidate event. It must not decide what a command or MCP method means.

### 4.1 Claude

Recognized sources include:

- assistant `tool_use` plus user `tool_result`;
- live SDK tool progress and permission requests;
- `attachment` records for hook lifecycle, queued commands, files, edits,
  diagnostics, task state, plan state, and configuration changes;
- top-level mode, permission, worktree, cost, and relationship records.

For `Bash`, the adapter supplies the value under `command` as an execution
candidate. It does not label it “shell” beyond recording the source tool.
For other command-like tools, it consults a provider schema registry rather
than guessing from a name:

```text
Bash.command
Shell.command
run_shell_command.command
execute.args / execute.argv
terminal.command
```

Unknown tools remain ordinary tool actions; their inputs are never searched
blindly for something that looks like a command.

The registry keys native event kind plus tool identity, not tool name alone.
`Bash` from Claude is a declared command tool; an unrelated MCP service is free
to expose a method called `Bash` without having its inputs treated as local
shell. Aliases such as `cmd`, `command`, `script`, `args`, and `argv` are
accepted only where that provider/tool schema declares what they mean.

### 4.2 Codex

Recognized sources include:

- app-server items such as `commandExecution`, `fileChange`, `mcpToolCall`,
  `dynamicToolCall`, `webSearch`, `imageView`, `imageGeneration`, and sleep;
- rollout `response_item` calls and outputs;
- native end events such as `patch_apply_end`, `web_search_end`,
  `mcp_tool_call_end`, and `image_generation_end`;
- collaboration, permission, status, context, usage, and turn events.

Codex code mode is a transport. A call like this:

```js
const result = await tools.exec_command({ cmd: "npm test", workdir: "/repo" });
text(result.output);
```

produces one command candidate (`npm test`, cwd `/repo`). It is not categorized
from `exec`, `tools.exec_command`, JavaScript, or the `text()` call.

The decoder covers the observed forms and their versioned aliases, including
`tools.exec_command`, `tools.exec`, `functions.exec_command`, direct
`exec_command` function calls, and app-server `commandExecution`. Older Codex
records that label the whole JavaScript orchestration block as `Bash` still go
through code-mode decoding before any shell classifier sees them.

Code mode may contain several tool calls. The decoder must emit one candidate
per awaited tool call, in source order, linked to the one provider call. A
regex that returns only the first `cmd` silently loses work and is not an
acceptable implementation.

### 4.3 Future providers

A provider joins by declaring mappings from native shapes to canonical
candidates. It does not add cases to the renderer. The minimum conformance
fixture contains:

1. a direct shell command;
2. an argv-form command;
3. a shell-launched command;
4. a file read and edit;
5. a service read and mutation;
6. permission allowed and denied;
7. progress, success, failure, and interruption;
8. an unknown event that survives visibly.

## 5. Command normalization

Command normalization is a bounded, recursive transformation. Every stage
returns the command it understood, the wrappers it removed, and a confidence
level. Failure at any stage preserves the last safe value.

```ts
interface NormalizedExecution {
  raw: unknown;                 // untouched provider input
  argv?: string[];              // faithful argv, when supplied
  text?: string;                // faithful command text, when supplied
  semanticCommands: CommandNode[];
  cwd?: string;
  environment: Record<string, string>;
  boundaries: ExecutionBoundary[];
  wrappers: ExecutionWrapper[];
  parseStatus: 'complete' | 'partial' | 'opaque';
}
```

### 5.1 Stage A: decode the provider envelope

Use the provider's declared schema first.

| Native form | Semantic candidate |
| --- | --- |
| Claude `Bash {command}` | the `command` string |
| Codex `commandExecution.command` | its command or argv value |
| Codex code-mode `tools.exec_command({cmd})` | the statically decoded `cmd` string |
| Function call `exec_command` with JSON arguments | decoded `cmd`/`command` field |
| Tool with declared argv schema | the argv array, without joining and re-splitting |

Code-mode JavaScript must be parsed as JavaScript or with a deliberately small
balanced-token reader. It must understand object keys, string escapes, template
literals without expressions, and multiple calls. Dynamic expressions such as
`cmd: makeCommand()` stay opaque. Executing the code to discover the value is
forbidden.

### 5.2 Stage B: preserve argv when it exists

An argv array is stronger evidence than a display string:

```json
["/bin/bash", "-lc", "npm test"]
```

must be read as three arguments, not reconstructed and tokenized again.
Re-joining loses the distinction between syntax and literal arguments. String
tokenization is only for providers that supplied a string.

### 5.3 Stage C: peel recognized process wrappers

Peel only a closed registry of wrappers with explicit argument grammars:

- environment/process: `env`, assignments, `command`, `exec`, `sudo`, `doas`,
  `nice`, `nohup`, `setsid`, `timeout`;
- shell launchers: `sh`, `bash`, `dash`, `zsh`, `fish`, with their command
  flags; PowerShell `-Command`; Windows `cmd.exe /c`;
- package launchers: `npx`, `pnpm exec`, `yarn exec`, `bunx`, where the next
  argv is the actual program but the package boundary remains context;
- development environment/proxy launchers with explicit grammars, such as
  `direnv exec`, `mise exec`, `nix develop -c`, and the observed `rtk` proxy;
- remote/container: `ssh`, `docker exec`, `podman exec`, `kubectl exec`;
- input-driven launchers: `xargs` and `find -exec`/`-execdir`.

Each grammar must consume its own options correctly before selecting an inner
command. Examples:

```text
sudo -u app -- bash -lc 'npm test'
timeout --signal=TERM 30s sh -c 'cargo test'
docker --context prod exec -u app container bash -lc 'pytest -q'
kubectl -n api exec pod/web -c web -- sh -c 'rm -rf /tmp/cache'
ssh -p 2222 buildbox -- env CI=1 npm test
find build -type f -exec rm -f {} +
printf '%s\n' cache | xargs -r rm -rf
```

The semantic commands are respectively `npm test`, `cargo test`, `pytest -q`,
`rm -rf /tmp/cache`, `npm test`, `rm -f {} +`, and `rm -rf`.
The container/remote/user/time-limit boundaries remain attached.

A wrapper is not recognized merely because its basename appears somewhere in
the string. `grep "bash -lc" notes.txt` is a grep, and a here-document
containing `rm -rf` does not delete anything during the command that writes it.

Wrapper option parsing is executable-specific. A shared rule such as “skip
dash-prefixed words” is insufficient: `sudo -u app`, `ssh -p 2222`,
`docker --context prod exec`, `kubectl -n api exec`, and `env -u NAME` consume
different numbers of arguments. A wrapper grammar either identifies its inner
argv without ambiguity or leaves the invocation partial/opaque.

### 5.4 Stage D: peel shell launchers recursively

Shell launchers often nest. Decode the payload of `-c`, `-lc`, `-Command`, or
`/c` once, parse it, and run the wrapper stages again on each executable node.
Set a recursion limit (proposed: eight) and a total-node limit (proposed: 256).
On either limit, mark the remainder opaque and keep it raw.

Quoting rules belong to the launcher being peeled. A POSIX shell payload must
not be parsed with PowerShell rules, and a PowerShell command must not be
treated as POSIX shell because it contains `&&`.

An interpreter is not automatically a shell wrapper. `python -c 'print(1)'`,
`node -e '...'`, `ruby -e '...'`, and `bash script.sh` are script executions;
their program text or file contents are not reinterpreted as shell. Likewise,
`make`, a package script, and a shell function may run commands that are not
present in the provider payload. The row describes only what can be established
from that payload, and does not read files or expand aliases to manufacture a
more specific answer.

### 5.5 Stage E: lift execution context, not behavior

These prefixes affect where or how work runs but do not describe the work:

```text
FOO=bar npm test
env FOO=bar npm test
cd /repo && npm test
export FOO=bar; npm test
```

Record environment and cwd when they can be determined statically, then
classify `npm test`. Do not discard a `cd`, assignment, or export if it is the
only executable effect. `cd /repo` alone is still a process/context action.

### 5.6 Stage F: parse the compound command

Use a shell-aware parser that distinguishes:

- sequencing (`;`, newline), conditional sequencing (`&&`, `||`), and
  backgrounding (`&`);
- pipelines, with each executable stage retained;
- subshells and command substitutions as executable nodes;
- redirections as read/write effects on files;
- quoted strings, escaped characters, comments, and here-document bodies;
- shell functions and inline scripts.

The parser produces executable nodes; it does not yet write English. A pipeline
like `rg TODO src | wc -l` contains a search and a count, while
`npm test 2>&1 | tail -40` is principally a test and the tail is output shaping.
Presentation may collapse shaping stages, but risk detection examines every
executable node, including substitutions and remote/container children.

The parser must also distinguish syntax that decides execution from text sent
to another program. In `ssh host 'rm -rf cache'`, the quoted value is executable
because the declared SSH grammar makes it the remote command. In
`printf '%s' 'rm -rf cache'`, the same bytes are data. In
`sh -c 'echo "$(rm -rf cache)"'`, the command substitution is executable and
must reach risk analysis even if presentation reduces the outer `echo`.

### 5.7 Stage G: classify semantic commands

Classifiers run on executable nodes after unwrapping. Their inputs are argv,
redirections, cwd, environment, and boundaries—not the original provider call.

Rules should prefer strong evidence in this order:

1. exact executable plus subcommand (`git push`, `cargo test`, `bd close`);
2. project script metadata (`npm run test`, package script names);
3. conventional executable families (`pytest`, `ruff`, `tsc`);
4. shell structure (file redirection, executable script body);
5. conservative heuristic;
6. unknown, showing the semantic raw command.

The result combines all meaningful nodes. It may choose a principal domain for
the mark, but it must union effects and take the highest risk. A chain that
builds, tests, and deletes is destructive even when “build” is the main story.

## 6. Safety invariants

1. **Raw input is immutable.** Permission cards and expanded details can always
   show exactly what the provider proposed.
2. **Risk sees more than presentation.** Output-shaping stages may disappear
   from the sentence; no executable node disappears from risk analysis.
3. **Unwrapping never lowers risk.** The normalized action's risk is the maximum
   of wrapper risk, boundary risk, and every inner command.
4. **Unknown is not safe.** Unknown commands and service mutations use
   `risk: unknown`, never read-only styling.
5. **Hints are evidence, not authority.** MCP `readOnlyHint` helps classify but
   cannot override an observed delete/mutation method or a local policy.
6. **No evaluation.** Normalization never executes JavaScript, expands shell
   variables, performs command substitution, sources files, or contacts a
   service.
7. **No quoted-data promotion.** Text becomes an inner command only through a
   recognized launcher's declared command argument.
8. **Parse failure is visible.** Partial/opaque commands retain raw text and a
   confidence marker; they do not receive an invented precise sentence.
9. **One source of truth.** Titles, live working lines, filters, permission
   context, destructive styling, and history replay consume the same normalized
   action.

## 7. MCP and external services

MCP is a protocol, not an action category. Normalize naming differences first:

```text
mcp__claude_ai_Linear__get_issue  -> server=Linear, method=get_issue
linear/get_issue                  -> server=linear, method=get_issue
mcp_tool_call_end.invocation      -> server=linear, method=get_issue
```

Then classify using, in order:

1. MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
   `openWorldHint`) and the actual completion status;
2. a cached tool schema/capability description supplied by the provider;
3. an explicit server-tool override for ambiguous or high-risk tools;
4. controlled verb/object rules over the method and schema;
5. unknown service action.

Method verbs map to effects, not directly to colours:

| Method family | Likely effects | Minimum risk |
| --- | --- | --- |
| `get`, `list`, `read`, `search`, `find` | read/search | read-only |
| `create`, `send`, `publish`, `apply`, `label` | create/update/communicate | mutating |
| `update`, `edit`, `set`, `move`, `copy` | update | mutating |
| `delete`, `remove`, `revoke`, `destroy` | delete | destructive |
| `authenticate`, `login`, `connect` | authenticate | mutating or unknown |
| `execute`, `run`, generic proxy tools | execute | unknown unless schema resolves it |

The object matters to the sentence: “Read Linear issue KEY-1309”, “Searched
Sentry events”, “Updated a Notion page”, “Deleted a Gmail label”. The row keeps
the service identity, but the mark and risk come from the capability.

Browser automation is similarly split by effect. Taking a screenshot and
reading console messages are reads; navigation, clicking, typing, form filling,
uploading, dialog handling, and page script execution are interactions or
execution. A browser script is not automatically destructive, but it is not a
passive read either.

## 8. Treatment of every observed non-message family

### 8.1 Claude

| Observed shape | Proposed treatment |
| --- | --- |
| `tool_use` / `tool_result` | canonical action/result; normalize tool capability |
| thinking blocks | thinking row |
| image/document blocks | first-class image/document attachment |
| hook success/start | quiet hook detail |
| hook blocking/nonblocking error, cancelled | visible hook failure/interruption |
| queued command/task notification | command or delegation lifecycle, linked by IDs |
| file / edited text file | attachment or diff action |
| task status/reminder | delegation lifecycle; suppress duplicate reminder prose |
| diagnostics | diagnostic attachment/status |
| MCP/deferred tool/skill/agent listings | configuration bookkeeping; not transcript prose |
| mode/permission/auto/plan/worktree | context event; header plus optional quiet history |
| token reminder/cost state | context/usage; deduplicate repeated snapshots |
| compact reference/history suppression | compaction context |
| title, last prompt, file snapshots/deltas, queue/bridge/frame links | bookkeeping; retain for state, hide from transcript |
| unknown attachment/top-level row | bounded unknown detail, never silently dropped |

### 8.2 Codex

| Observed shape | Proposed treatment |
| --- | --- |
| custom/function tool call and output | canonical action/result after envelope decoding |
| `commandExecution` | command candidate, then full command normalization |
| `fileChange` / patch end | one edit action with diffs; deduplicate by native call ID |
| web search item/end | one web/search action with result metadata |
| MCP item/end | one service action with annotations and result |
| image view/generation item/end | read or generation action plus image attachment |
| reasoning/plan | thinking or plan context |
| collaboration/subagent/world state | delegation lifecycle |
| approval/elicitation | permission event |
| turn start/complete/abort | session status; interruption remains visible |
| token/settings/compaction | context/usage |
| session metadata/inter-agent metadata | provenance/bookkeeping unless it changes visible state |
| unknown response item/event | bounded unknown detail, never silently dropped |

Begin/end duplicates must coalesce by native call ID. The richer end event may
complete or enrich a row opened by an item event; it must not create a second
row. Provider event identity remains the canonical deduplication key.

## 9. Presentation

The closed row shows the normalized summary and a mark derived from domain and
risk. It does not show provider transport syntax.

```text
✓ Ran the tests
✓ Read Linear issue KEY-1309
! Deleted cache on buildbox
? Used an unknown service operation
```

Opening the row shows, in this order:

1. semantic command or structured service request;
2. cwd/environment and remote/container/user boundaries;
3. provider and native tool name;
4. untouched raw input;
5. output/result, duration, and error;
6. normalization confidence and any partial/opaque remainder.

Filters use canonical domains/effects, not raw tool names. An optional deeper
filter can still group by provider or service. Thus Claude and Codex test calls
both live under Tests even when one arrived as `Bash` and the other as
`commandExecution`.

Permission cards continue to lead with literal execution text. A summary may
appear as supporting context, never as a substitute for the exact command or
service request the person is approving.

## 10. Verification

### 10.1 Corpus replay

The check recursively scans every Claude and Codex record, not merely direct
project-session files. It reports separately:

- source shapes and counts;
- normalized event families;
- command envelopes and wrapper stacks;
- complete, partial, and opaque parses;
- raw/fallback actions;
- read-only, mutating, destructive, and unknown risks;
- events silently dropped (required: zero outside an explicit bookkeeping
  allowlist);
- deduplicated native begin/end pairs;
- time per event and per command node.

Coverage is measured on semantic commands after wrapper removal. Counting
`bash`, `exec`, or `tools.exec_command` as recognized does not count as command
coverage.

### 10.2 Equivalence fixtures

Each fixture group expresses one action through multiple provider forms and
requires the same semantic result:

```text
npm test
bash -lc 'npm test'
Claude Bash(command='npm test')
Codex exec -> tools.exec_command({cmd:'npm test'})
docker exec app sh -c 'npm test'
```

The expected principal domain is `test`; effects include `execute`; the
container form alone has a container boundary.

Separate adversarial fixtures prove that these are not equivalent:

```text
grep 'bash -lc "rm -rf /"' notes.txt
cat <<'EOF' > example.sh
rm -rf /
EOF
printf '%s' 'rm -rf /'
```

None executes `rm` during that command. Conversely these must be destructive:

```text
bash -lc 'rm -rf cache'
ssh host -- sh -c 'rm -rf cache'
docker exec app rm -rf cache
find cache -type f -delete
printf '%s\n' cache | xargs rm -rf
```

### 10.3 Property and mutation tests

- Adding any recognized wrapper around a command preserves its semantic domain
  and cannot lower its risk.
- Quoting an executable string as data never turns it into a command node.
- Joining argv for display and reparsing it cannot be used for semantics.
- Removing or renaming a provider field makes the fixture opaque rather than
  silently selecting a neighboring string.
- Every event not on the bookkeeping allowlist emits a canonical event.
- Every native call ID produces at most one visible action row.

### 10.4 Performance

Normalization happens once when the canonical event is written. Rendering,
filtering, and replay consume the stored result rather than parsing again.
The corpus check reports parsing and classification separately so a faster
fallback cannot hide a slower or incomplete parser.

## 11. Delivery order

1. Introduce canonical action dimensions and provenance without changing the
   current row appearance.
2. Move Claude and Codex tool extraction into provider adapters with fixtures
   made from real records.
3. Implement argv-preserving envelope and wrapper decoding.
4. Replace regex command splitting with shell-aware executable nodes and union
   risk across all nodes.
5. Normalize MCP names and annotations across providers.
6. Import meaningful Claude attachments and Codex native completion events,
   with native-ID deduplication.
7. Switch titles, marks, filters, permission context, and live status to the
   canonical action.
8. Add recursive corpus replay as a required check and maintain the explicit
   bookkeeping allowlist.

The migration should dual-write or compare old and new categorization during
development. Any case where the new path lowers risk, loses a command node, or
turns a previously visible event into bookkeeping blocks the switch.

## 12. Decisions requested

1. Approve the split between domain, effects, and risk instead of extending the
   current single `RanKind` enum.
2. Approve parser-backed command normalization rather than accumulating regex
   exceptions.
3. Approve showing unknown non-bookkeeping events by default under machine
   detail, while keeping known bookkeeping hidden.
4. Approve storing the normalized action in the canonical event log so all
   consumers use one interpretation.
