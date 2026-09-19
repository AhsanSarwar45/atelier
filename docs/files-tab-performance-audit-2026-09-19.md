# Files tab — architecture and performance audit, 2026-09-19

## Scope and method

The Files tab of the workbench, front to back: the tree rail
(`src/workbench/file-tree.tsx`), the viewer (`file-viewer.tsx`,
`code-editor.tsx`, `file-preview.tsx`), the tab that joins them
(`files-tab.tsx`), and the Rust routes they call (`server/src/routes/fs.rs`).
Audited at `1216a698`.

Every number below came from a **release build of this worktree**, run as a
disposable instance on port 3411 with its own data directory
(`scripts/files-perf-stack.sh`). The owner's app on 3008 was never touched.
The tree browsed is the `beads-web` checkout, read-only. The machine is the
owner's, idle, with a warm page cache; "6× slower" rows are the same run with
`Emulation.setCPUThrottlingRate: 6`, which is the honest stand-in for an
ordinary laptop.

Harnesses added by this audit, all reusable:

| script | what it answers |
|---|---|
| `scripts/files-perf-stack.sh` | starts the disposable instance |
| `scripts/files-server-cost.mjs` | what the server costs per tree/read call |
| `scripts/files-open-cost.mjs` | click-to-drawn, cold and re-opened, per file size |
| `scripts/files-click-through.mjs` | a click that lands while a read is in the air |
| `scripts/files-reveal-cost.mjs` | revealing a path the tree has not walked to yet |
| `scripts/files-typing-cost.mjs` | what a keystroke costs in the editor |

## The short answer

**The server is not the problem.** Reading a 1.9 MB file takes 7 ms and
listing a directory takes 2 ms. The whole of the Rust side is comfortably
inside a single frame.

The Files tab is slow for three reasons, all in the browser, and the worst one
is not slowness at all — it is a **dropped request**. A click that lands while
any file read is in the air is discarded, and the file it asked for does not
arrive until the next five-second poll. Measured: **5.6 seconds**, three times
out of three. That is the "sometimes very long".

The other two are that **nothing is ever cached anywhere**, so re-opening a
file you read two seconds ago repeats the entire journey and rebuilds the
editor from nothing; and that the tab **polls** — one request per open file
plus one per expanded folder, every five seconds, for ever.

## What the server costs

`scripts/files-server-cost.mjs`, 12 warm runs each, times are full request to
full body:

| call | cold | warm p50 | warm p95 | body |
|---|---|---|---|---|
| `fs/tree` checkout root | 35.8 ms | **2.0 ms** | 2.7 ms | 7.6 KB |
| `fs/tree` `src/workbench` | 7.4 ms | **2.0 ms** | 2.8 ms | 24.3 KB |
| `fs/tree` `node_modules` | 161.3 ms | **5.6 ms** | 8.1 ms | 120 KB |
| `fs/read` 3.9 KB | 0.7 ms | **0.6 ms** | 0.8 ms | 3.9 KB |
| `fs/read` 136 KB | 8.7 ms | **4.1 ms** | 4.6 ms | 136 KB |
| `fs/read` 918 KB | 25.1 ms | **3.6 ms** | 5.7 ms | 918 KB |
| `fs/read` 1.9 MB | 17.9 ms | **7.1 ms** | 8.4 ms | 1.9 MB |
| `git/status` | — | 4.2 ms | — | 152 B |
| `git/log` | — | 1.9 ms | — | 12.3 KB |
| `git/trees` | — | 6.3 ms | — | 1.2 KB |

There is real waste inside those numbers (§8), but at this scale it is
single-digit milliseconds. No endpoint recurses, nothing shells out to `git`
per file, and the only lock in the fs routes is never held across an `await`.

## What the browser costs

`scripts/files-open-cost.mjs`, click in the tree to text on screen:

| | this machine | 6× slower |
|---|---|---|
| tree, first row after the address is entered | 115–182 ms | 993 ms |
| README.md (14 KB) first open / re-open | 62 / 78 ms | 210 / 115 ms |
| chat-tab.tsx (133 KB) first open / re-open | 49 / 47 ms | 174 / 114 ms |
| package-lock.json (553 KB) first open / re-open | 76 / 48 ms | 134 / 88 ms |
| leaving the tab and coming back | 99 ms, 15 calls | 393 ms, 17 calls, 140 ms blocked |
| ten idle seconds, nothing expanded | 6 calls | 14 calls, 73 ms blocked |

Two things to notice. **Re-opening costs the same as opening** — there is
nothing kept. And an idle tab is never idle.

## Ranked findings

### 1. A click that lands while a read is in the air is thrown away (P0)

`files-tab.tsx:365-397` reads the open file through
`useFolderReads(folder, readFile)`, which wraps it in `useSerialReads`
(`use-serial-reads.ts:38-58`). That hook allows one read at a time and queues
at most one more:

```ts
if (busyReading.current) { oneMore.current = true; return; }
```

The queued retry then re-runs `read` — but `read` is the **closure captured
when the in-flight call started**, so it re-reads the *old* file. `readFile`
guards on `wanted.current !== asked` and drops the answer. The newly clicked
file is never asked for at all. It arrives only when the five-second interval
fires again.

Measured with `scripts/files-click-through.mjs`, reads answered in 600 ms:

```
patient: package-lock.json drawn 658ms after the click
clicked tsconfig.json 100ms into the read of package-lock.json: drawn after 5632ms

clicked tsconfig.json as the tab re-read package-lock.json of its own accord: drawn after 5634ms
clicked tsconfig.json as the tab re-read package-lock.json of its own accord: drawn after 5636ms
clicked tsconfig.json as the tab re-read package-lock.json of its own accord: drawn after 5632ms
```

The third case needs no fast clicking and no slow disk: the tab re-reads the
open file every five seconds by itself (§5), so **every open file carries a
recurring window in which the next click costs 5.6 seconds**. The window is as
wide as one read, so it grows with file size, with a cold page cache, with a
network filesystem, and with remote access. On this machine, unthrottled,
clicking 40 ms after a previous click already produced a 497 ms stall.

The screen during those seconds says `Reading…`.

Fix: the read of the open file is not a folder re-read and should not share
its queue. Give the viewer its own fetch, keyed on the path, cancelled by
`AbortController` when the path changes — the newest click always wins and
older reads are aborted rather than allowed to suppress it. Keep
`useSerialReads` for the tree, which is what it was written for.

### 2. Nothing is cached, at any layer (P0)

- `src/lib/api.ts:272-276` sends `cache: 'no-store'` on every request.
- `server/src/main.rs:95-105` stamps `Cache-Control: no-store` on every
  `/api/*` answer, and `serving.rs` has a test asserting it
  (`nothing_about_the_work_may_be_kept_at_all`).
- `fs/read` returns no `ETag` and no `Last-Modified`. Verified on the wire:

  ```
  HTTP/1.1 200 OK
  content-type: application/json
  cache-control: no-store
  ```

- The only thing resembling a cache is in-flight de-duplication
  (`api.ts:202-215`), explicitly documented as keeping nothing after it lands.
- File text is never held. The open-files strip remembers *which* paths are
  open (`open-files.ts:89-113`) and never their contents.

So clicking back to a file you read four seconds ago re-reads it from disk,
re-serialises it, re-transfers it, re-parses the JSON and rebuilds the editor.
That is why "re-open" in the table above is never cheaper than "open". Zed and
VS Code are instant here because the buffer is still in memory.

`no-store` is the right instinct for a board whose address cannot express its
version. A file is not that: it has an mtime and the read already computes a
`sha256`. Fix in two halves — an LRU of recently read file text in the client,
keyed by path and validated by sha; and `ETag` + `no-cache` (not `no-store`)
on `fs/read` so a revalidation is a 304 and a stat instead of a re-read.

### 3. The editor is destroyed and rebuilt on every open (P0)

`files-tab.tsx:391-396` blanks the read before starting the new one:

```ts
setRead({ file: null, error: null });
void readAgain();
```

With `read.file === null` the viewer renders the `Reading…` notice instead of
`<CodeEditor>` (`file-viewer.tsx:333-336`), so CodeMirror's mount effect
(`code-editor.tsx:220-288`) tears the `EditorView` down and builds a new one
with a new `EditorState` for every file — despite the comment at
`code-editor.tsx:4-15` saying the view survives. Every open therefore pays a
guaranteed blank frame, a full extension rebuild, and a fresh lazy `import()`
of the grammar when the language changes (`code-editor.tsx:321-340`).

Fix: keep the last document on screen until the next one is ready, and
`dispatch` a document replacement into the existing view instead of
remounting. This is also what removes the flash.

### 4. Markdown is re-parsed and re-highlighted, whole, on every render (P1)

`file-preview.tsx:443` renders `<MarkdownBody>` → `markdown-body.tsx:479-484`
`<ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}
rehypePlugins={[rehypeHighlight]}>`. No `useMemo`, no virtualization, and
every fenced block is highlighted synchronously.

Measured on `docs/agent-workbench.md` (173 KB):

```
markdown 173KB: drawn 1722ms, blocked 1227ms in 5 tasks (worst 405ms)
  pieces of screen: 4576
  untouched for 12s: 2 re-reads of the same file, blocked 228ms in 2 tasks (worst 119ms)
```

1.2 seconds of blocked main thread to open it, a single 405 ms task inside
that, and then **another ~119 ms freeze every five seconds, for ever**, on a
file nobody is touching, because the poll (§5) hands back the same text and
the whole document is parsed again.

Fix: memoize the parse on the text, and cut the re-render off at the source by
not replacing state when the sha is unchanged. Long documents want
virtualization or an incremental renderer; 4,576 nodes for one file is already
past what a single commit should carry.

### 5. The tab polls, and the polling grows with how much of the tree is open (P1)

`use-folder-reads.ts:49` sets `FOLDER_MS = 5_000`. Every five seconds the tab
re-reads the open file, and `file-tree.tsx:220-230` re-reads **every expanded
folder**:

```ts
const drawn = new Set([root, ...open]);
const wanted = moved.length === 0 ? [...drawn] : …
await Promise.all(wanted.map(readLevel));
```

Measured, same page, twelve seconds of doing nothing:

| state | calls in 12 s |
|---|---|
| nothing expanded | 6 (`fs/tree`×2, `git/status`×2, `git/log`×2) |
| 7 folders expanded | 20 (`fs/tree`×16, …) |
| …and a 553 KB file open | 31 (`fs/tree`×24, …) |

Each `fs/tree` answer calls `setRead(new Map(had).set(dir, entries))`
(`file-tree.tsx:204-213`) — a copy of the map of *every* directory ever read —
which invalidates the `rows` memo and re-walks the whole flattened tree. Twenty
open folders means twenty map copies, twenty tree walks and twenty renders per
tick.

The polling exists because the watching does not work. `live-wire.ts:165-168`
watches exactly **one** folder — the last registrant wins — and in the Files
tab there are two: the tree registers the root (`file-tree.tsx:234`) and the
tab registers the open file's folder (`files-tab.tsx:389-390`), which is
registered later and wins. **While a file is open the tree receives no
filesystem events at all.**

Fix: make the wire carry a set of watched paths rather than one, let the tree
and the viewer both subscribe, and then lengthen or drop the interval. The
server already has the watcher (`fs_watch.rs`); the client is the part that
can only hold one.

### 6. Revealing a deep path is one round trip per level (P1)

`file-tree.tsx:300-313` expands one ancestor per effect run, so the levels are
strictly sequential. `scripts/files-reveal-cost.mjs`, directory answers slowed
to 200 ms so the ordering is visible rather than lucky:

```
src/routes/fs.rs  3 folders deep
  revealed after 1050ms with each folder answered in 200ms
  5 tree calls: bw-19hv, +77ms beads-web, +208ms server, +211ms src, +208ms routes
```

Five serial journeys for a three-deep path. Locally each is 2 ms and nobody
notices; over remote access, or into a folder like `node_modules` (161 ms
cold), it is the whole wait. Every "open this file" link in the app — path
chips, diff headers, the Git rail — goes through this path.

Fix: ask for the ancestors in one call (`dir[]=…`), or let `fs/tree` take a
`reveal=<path>` and answer with every level down to it in one body.

### 7. Leaving the tab throws the whole tree away (P2)

`app/project/page.tsx:293` mounts the Files tab conditionally, so switching to
Chat unmounts it and discards `read` (every directory listing) and `open`
(every expanded folder). Measured: three folders open before leaving, **zero**
after coming back, and the tree re-read from the root.

Fix: keep the tree's state outside the component, or keep the tab mounted and
hidden.

### 8. Server-side waste that only matters because of §5 (P2)

None of these is visible in a single call; all of them are multiplied by the
polling above.

- `fs/read` makes roughly four passes over the content: read into a `Vec`
  (`fs.rs:381-385`), `Sha256::digest` over all of it (`fs.rs:409`),
  `String::from_utf8_lossy(&bytes).into_owned()` (`fs.rs:414`), then
  `serde_json::to_value(...)` followed by serializing that `Value`
  (`fs.rs:420`) — two full serialization passes rather than one.
- `fs/tree` builds an `ignore::WalkBuilder` **twice per request**
  (`fs.rs:216-243`, called at `fs.rs:269`) with `.parents(true)`, so every
  ancestor `.gitignore`, `.git/info/exclude` and the global gitignore is
  re-read and re-parsed on every single directory expansion, twice. Nothing is
  memoized.
- Blocking `std::fs` on the async runtime, without `spawn_blocking`:
  `validate_path_security` canonicalizes the path *and* the home directory and
  calls `UserDirs::new()` on **every** request (`routes/mod.rs:479-536`);
  `read_file` stats with `std::fs::metadata` (`fs.rs:362`); `tree` stats every
  entry with `symlink_metadata` in a loop after the walk (`fs.rs:292`);
  `write_file` does a whole-file read, a SHA-256 and an `fsync` on the runtime
  (`fs.rs:460-505`).

Fix, in order of payoff: serialize once instead of via `Value`; cache the
ignore matcher per root and invalidate it when a `.gitignore` moves; memoize
the canonical home; move the stat loops to `spawn_blocking`.

### 9. Smaller things worth recording (P3)

- Above 2 MiB or 50,000 lines the viewer drops to a raw `<pre>`
  (`file-viewer.tsx:344-346`) with no virtualization and no gutter — one giant
  text node.
- `tooLargeToParse` (`file-viewer.tsx:69-77`) scans the body for newlines
  **during render**, so it re-scans on every keystroke. Bounded at 50,000
  iterations, but needless.
- The `Opening` context value is rebuilt on every URL change
  (`open-path.tsx:166-179`, `params` from `useSearchParams()` is a new object
  each navigation), re-rendering every consumer in the app on every file click.
- `FileTree` is not `React.memo`'d and receives unstable callbacks
  (`files-tab.tsx:226`, `:311-314`), so it re-renders fully on every click.
  The row *computation* is saved by the `rows` memo, so the cost is bounded to
  the ~65 visible rows.
- Typing is fine and is **not** a size problem: measured p50 33–49 ms per key
  including ~32 ms of harness overhead, with no correlation to file size
  (553 KB was the fastest). The full `doc.toString()` per keystroke
  (`code-editor.tsx:274`, `:294`) is real but costs about a millisecond.

## Ranked fix plan

**Stage 1 — stop losing clicks and stop re-doing work.** Fixes the reported
symptom outright.

1. Give the viewer its own abortable read, out of `useSerialReads` (§1).
   Target: no open above 150 ms at the 99th percentile, no 5 s outliers.
2. Hold the last document on screen and dispatch into the live `EditorView`
   instead of remounting (§3). Target: no blank frame between two files.
3. Keep recently read text in an LRU on the client; add `ETag` + `no-cache` to
   `fs/read` (§2). Target: re-open under 16 ms with no body on the wire.

**Stage 2 — stop the background load.**

4. Let the live wire watch a set of paths, subscribe the tree and the viewer
   both, and lengthen the interval to a safety net (§5). Target: an untouched
   Files tab makes no calls at all.
5. Memoize the markdown parse and skip the state update when the sha is
   unchanged (§4). Target: no repeating freeze on an open document.

**Stage 3 — the rest.**

6. One call to reveal a path (§6).
7. Keep the tree's expansion across a tab switch (§7).
8. Serialize `fs/read` once, cache the ignore matcher per root, move the stat
   loops off the runtime (§8).
9. Virtualize the plain fallback and hoist `tooLargeToParse` out of render
   (§9).

## Reproducing

```bash
BEADS_WEB_PORT=<free port> scripts/files-perf-stack.sh
curl -X POST http://127.0.0.1:<port>/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"perf","path":"<a checkout>"}'

BEADS_E2E_URL=http://127.0.0.1:<port> node scripts/files-server-cost.mjs <checkout>
BEADS_E2E_URL=http://127.0.0.1:<port> node scripts/files-open-cost.mjs <projectId> <checkout> README.md package-lock.json
BEADS_E2E_URL=http://127.0.0.1:<port> SLOW_READ_MS=600 node scripts/files-click-through.mjs <projectId> package-lock.json tsconfig.json components.json
BEADS_E2E_URL=http://127.0.0.1:<port> node scripts/files-reveal-cost.mjs <projectId> <checkout>/server/src/routes/fs.rs
```
