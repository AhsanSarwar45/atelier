# Frontend and backend performance audit — 2026-08-29

## Scope and method

Read-only audit of commit `793918a`. It did not touch the owner's running
Atelier process. Measurements use the current board, current production build
artifacts, read-only SQLite queries, and source-level microbenchmarks.

## Ranked findings

### 1. Whole-board transfer is the largest systemic sink

`server/src/routes/beads.rs::read_beads_from_cli` runs `bd list --json --all`
and a second `bd sql` comments process, then `/api/beads` returns full objects
for the entire historical board.

- 3,168 cards; 7.04 MB formatted / 6.29 MB compact JSON.
- Only 405 are open (0.91 MB). Open work plus useful graph is 1,055 cards / 2.20 MB.
- Notes, descriptions, and close reasons contribute 3.79 MB.
- Five warm list runs were 120 ms each and peaked at 138–161 MB RSS. The
  comments process added 30 ms / 209 KB. Source comments record 0.6–4.3 s under
  real cold/contention conditions.

This cost is paid before Rust parsing/post-processing, cache writes,
serialization, transfer, browser parsing, React derivation, and painting. The
30-second memo hides repeats but not first reads or invalidation.

Fix: split list and detail representations. Send only card/filter fields for
open top-level work and the ancestry/child state needed for progress. Fetch
notes, descriptions, comments and history when detail opens. Compute progress
and counts server-side, keep a versioned snapshot, and apply deltas.

Target: first board payload under 1 MB; cold response under 250 ms; memo hit
under 20 ms; one-card delta under 20 KB. This supplies the backend contract for
`bw-1rwe.5`, `.7`, `.8`, `.13`, `.14`, `.15`, and `.17`.

#### Measured server-memory result

The bounded, shared board cache landed in `48e0a7d`. Comparing that commit with
its parent `59d911ca` using `BOARD_MEMORY_SAMPLES=9
scripts/benchmark-board-cache-memory.sh` measured nine fresh release-build
server processes per revision. Each process loaded eight identical boards of
3,168 rich cards and then served eight cached full-board reads. Fixtures, data,
processes, and dynamically selected server/workbench ports were isolated from
the installed Atelier instance.

| Linux process memory | Before | After | Change |
| --- | ---: | ---: | ---: |
| Median retained/peak memory | 172.527 MiB | 106.758 MiB | -65.770 MiB (-38.12%) |
| Median workload memory above idle | 153.914 MiB | 88.230 MiB | -65.684 MiB (-42.68%) |

Idle memory was comparable at about 18.6 MiB. Samples were bimodal because the
system allocator sometimes retained freed arenas: retained-memory samples were
135.270–173.762 MiB before and 73.109–107.762 MiB after. Every after sample was
below the corresponding range maximum before the change. The benchmark reads
`VmRSS` and `VmHWM` from `/proc/<pid>/status`; it measures the parent server
process, not its separately spawned chat-helper process or browser memory.

### 2. Project-page JavaScript is too large and eager

The production manifest loads 16 JavaScript files for `/project`: 1.70 MB raw,
478 KB gzip. Board, chat, markdown/highlighting, animation, charts, and other
panels share the route graph.

Fix: dynamically import by selected tab/panel; load the shell and selected tab
first. Analyze bundles and narrow heavy imports. Target initial project code
under 250 KB gzip and no unused-tab chunk before interaction. Promote the
existing app-size work named by `bw-2lzj` (`bw-2uh1`).

### 3. Board derivation is still O(epics × cards)

`src/components/epic-card.tsx` finds every child in `allBeads`; then
`computeEpicProgress` filters the whole board per epic. Memoization helps only
until the board array is replaced. With 3,168 cards and 265 epics, progress
scans alone measured 7.2 ms per pass in Node, excluding child finds, React, DOM,
layout, and paint.

Fix: build one `Map<id, bead>` and one `Map<parent, children>`, compute all
progress in one pass, preserve unchanged object identity across deltas, and add
React Profiler coverage. Target one board walk, fewer than five card commits,
and under 16 ms scripting for one-card updates. Owned by `bw-ufso.8` and
`bw-1rwe.17`.

### 4. Background work can still block foreground interaction

`bw-2lzj` already measures the shared chat-helper queue: whole-record reading,
173-chat read-ahead, and board reads can sit in front of a click, making it 4 ms
or several seconds. Finish `bw-2lzj.3`, add queue-wait/service-time/task-class
spans, and enforce separate foreground/background pools with yielding.

Target p95 foreground queue wait under 25 ms; the existing ten-click test stays
under 300 ms each and never exceeds 500 ms.

### 5. Development preview invalidates manual comparisons

`bw-v0na` measured production versus development on the same data: project list
94 vs 401 ms, report 109 vs 370 ms, reports list 113 vs 954 ms.
`scripts/live-preview.sh` still runs `next dev`.

Fix: serve a production build by default, retain an explicit HMR mode, and show
build mode/commit in diagnostics. Target preview within 20% of packaged speed.

### 6. Secondary costs

- `src/workbench/chat-sidebar.tsx` repeats one card split four times per visible
  row (`bw-p61.15`). Compute it once.
- `/api/workbench/watch` queries `beadsForSession` per session. The database has
  152 sessions / 877 links. Replace the N+1 with one grouped join.
- Search uses `LIKE '%query%'` over 4,144 messages; one measured query reached
  70 ms. Add FTS5 before history grows further.
- The largest chat has 135,702 events / 332 MB JSON, but current indexed,
  paginated transcript-window queries measured below 10 ms. Preserve this path;
  it is not the current priority.

## Ranked fix plan

1. Add server spans for queue wait and board read/serialize bytes/time, plus
   browser marks for chunk load, parse, React commit and settled paint. Store
   p50/p95 and payload budgets in `tests/speed.spec.ts`.
2. Ship the list/detail board API and server-computed indexes/progress. This one
   change reduces backend work, transfer, browser parsing, derivation, memory,
   and refresh cost.
3. Use versioned live deltas with stable client identity; finish one-pass
   frontend indexes and render-count tests.
4. Split the project bundle by selected tab/panel and lower its budget to 250
   KB gzip.
5. Finish foreground/background worker isolation (`bw-2lzj.3`) and report
   p50/p95/max queue wait in its click test.
6. Switch the standard preview to production mode (`bw-v0na`), then fix the
   chat-row repetition, watch-snapshot N+1, and FTS search in that order.

## Measurement limitations

No browser run was made against the protected owner instance. The isolated
harness starts with an empty project registry, so a production-like fixture is
the first plan step. Existing browser numbers are cited only where an open card
records their provenance.
