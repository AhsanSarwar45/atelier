# Coverage grids

A grid is the full list of features in one area of a project (its rows),
the requirements each feature must meet (its columns), and for every pair a
cell that says whether that requirement is met and links to the proof. The
app owns grids the way it owns tasks (docs/tasks.md). Agents work through the
cells with tasks, and an agent cannot mark a cell proved without proof the
app can check again.

The case it was built for: a renderer's camera, with lens properties, glare,
sunstars, ghosts, exposure, colour transforms and camera presets. Every one
of them must have ground-truth tests, no logic duplicated between CPU and
GPU, run on the GPU where it should, be optimized, be physically accurate,
combine with the others without adding energy, not be hardcoded to one
scenario, and have physically grounded presets. When agents do this one
feature at a time they leave gaps. A grid shows the gaps.

## Principles

- The app owns grids. The only ways to change one are the `atelier grid` CLI
  (agents) and the Grids view (the owner). Both post to the same route.
- Rows come from the code. Each grid saves a **row search**: a command that
  lists the area's features. The app runs it again when the area changes, so
  a new feature shows up as a new row without anyone adding it.
- Nothing about a grid waits for the owner. A grid is live as soon as an
  agent drafts it. An edit, a check change, a template change or an N/A
  applies at once. The owner can still reopen any cell, and any agent can
  reopen a cell that no longer meets its requirement.
- **Proved** means there is proof the app can run again. The proof is the
  cell's checks (docs/tasks.md, Checks): column templates written when the
  grid is drafted, plus the cell's own. They must pass when the cell is
  proved, and the app runs them again on request. A proof stops counting as
  soon as the code it covers changes, or its checks change (stale).
- A cell with no check cannot be proved. It shows **Needs a check** until an
  edit gives its column (or the cell) one.
- A feature has one owner. A row id belongs to one grid in the project.
  Another grid that depends on it adds a reference row, which shows the
  owner's cells read-only. Rows are never copied.
- Tasks and cells are one-way. A task may reference cells, and its plan
  lists them, but no cell depends on a task. A cell is never held: any chat
  may prove a ready cell, and many tasks may reference one cell.
- Cases are reviewed by a fresh agent, not by the owner. Reviewing proved
  cells (audit) is done by a different chat from the one that proved them.
- Grid data (checks, cases, cell states)
  belong to the project, not to a branch. See Branches.

## Data

Stored in `workbench.db`, next to the task tables. The grid tables are created
the same way: `grids::SCHEMA`, a batch of `CREATE TABLE IF NOT EXISTS`, run
from `store.rs` `reconcile_capabilities` right after `tasks::SCHEMA`. This is
not a migration in `server/src/db.rs`, which is the projects and settings
database.

Ids (grid slug, row id, column id, template name) all match
`[a-z0-9][a-z0-9_-]{0,63}`. That keeps them inside a reference, a URL and a
CLI argument without quoting. A `.` or a `+` in an id is refused.

`grid`

| column | type | notes |
|---|---|---|
| `project_id`, `slug` | text | the key |
| `title` | text | ≤ 120 chars |
| `area` | text | one paragraph: what the area is, ≤ 600 chars |
| `status` | text | `approved` for a live grid; `draft` and `discarded` are only left by older builds, and discarded grids are hidden |
| `template` | text, null | name of a `grid_template` |
| `row_search` | json | `{command, watch[], timeout_s?}` (see Row search) |
| `pending` | json, null | always null now; older builds kept unapplied drafts here (see Older databases) |
| `created_by` | text, null | session that drafted it |
| `drafted_by` | text, null | session that drafted it last |
| `created_at`, `updated_at`, `approved_at` | integer ms | `approved_at` is when it went live |
| `discovery` | json, null | the last run: `{at, head, ok, added[], missing[], back[], skipped[{id, owner}], error?}` |

`grid_column`: `(project_id, slug, id)` is the key. Other columns: `name`,
`proof_rule` (text: what counts as proof for this requirement, ≤ 1000 chars),
`checks` (json: check templates, see Column checks), `position`,
`from_template` (0/1), `retired_at` (null while it counts) and `after`
(json array of column ids; see Order).

`grid_row`: `(project_id, slug, id)` is the key. Other columns: `name`;
`kind` (`feature`, `combination` or `reference`); `paths` (json array of
repo-relative files or folders); `of` (json array of row ids, combinations
only); `ref` (json `{grid, row}`, references only); `source` (`search` or
`manual`); `added_at`; `missing_since` (null while the row search still
prints it); `removed_at` (set when an edit drops a manual row);
`after` (json array of row ids; see Order).

- Ownership index:
  `CREATE UNIQUE INDEX grid_row_owner ON grid_row(project_id, id) WHERE kind <> 'reference' AND removed_at IS NULL`.

`grid_cell`: `(project_id, slug, row, col)` is the key. Every live feature or
combination row has one cell per column. Reference rows have no cells.

| column | type | notes |
|---|---|---|
| `state` | text | `unchecked`, `gap`, `proved`, `na` |
| `proof` | json, null | see Proof; kept when a cell reopens, until replaced |
| `fingerprint` | text, null | of the row's covered code when it was proved |
| `proved_by`, `proved_at` | text, integer | session and time |
| `last_check` | json, null | `{at, head, passed, results[{name, exit, ms, tail}]}` |
| `checks_changed` | 0/1 | set on a proved cell when its checks change; cleared by a passing `verify` or `prove` |
| `reason` | text, null | why it is a gap, why N/A, or why an audit reopened it |
| `checks` | json, null | the cell's own checks, `{checks: [Check], override?: true}` (see Column checks) |
| `approved_hashes` | json, null | sha256 of each resolved check's `files` and the harness files, taken in the chat's folder when the checks were written |
| `audited_at`, `audited_by` | integer, text, null | the last audit pass |
| `step`, `next` | text | see Cell states |

The old `claimed_task` and `claimed_from` columns stay in the table and are
always null.

`grid_event`: `(project_id, slug, seq, at, kind, row, col, session_id,
actor, payload)`. `row` and `col` are null for events about the whole grid.
Every change appends a row. A cell's history is its own events. Kinds:
`drafted`, `edited`, `changed`, `checks_set`, `checks_changed`,
`discovered`, `row_added`, `row_missing`, `row_back`, `column_added`,
`column_retired`, `order`, `cases`, `reviewed`, `proved`, `check_passed`,
`check_failed`, `na_set`, `audit_passed`, `reopened`, `note`.

`grid_template`: `(project_id, name)` is the key. Other columns: `columns`
(json `[{id, name, proof_rule, checks}]`), `pending` (always null now),
`updated_at` and `updated_by`.

`grid_task_cell`: `(project_id, task, slug, row, col)`, the key, one row per
cell a task references. It changes nothing about the cell; the task card
reads it to list its cells. A proposal's cells wait in a `cells` json
column added to `task_proposal`.

### Derived, never stored

These are worked out each time a grid is read:

- **stale**: a `proved` cell whose row's fingerprint now differs from the one
  stored with the proof, or whose `checks_changed` is set.
- **missing**: a row with `missing_since` set. **retired**: a column with
  `retired_at` set.
- **counted cells**: cells of live feature and combination rows (not missing,
  not removed) in live columns, minus cells in state `na`.
- **percent proved** = `proved and not stale` / `counted`, rounded down.
- **resolved checks** of a cell: its column's templates with `{row}`
  replaced by the row id, followed by the cell's own checks; or only the
  cell's own when it has `override: true`.
- **needs a check**: a cell whose resolved checks are empty
  (`needsCheck: true`). It cannot be proved.

## Covered code and staleness

A row covers its `paths`. A combination row covers its own paths plus the
paths of every row in its `of`. A row also covers what its cells' checks
depend on: each check's `files`, and the extra paths it lists in `watch`
(with `{row}` filled in). Use `watch` for anything the proof relies on
that the row search does not list, such as a shared shader or a baseline
image.

The fingerprint follows what covered files pull in, so a row does not have
to list every file by hand. In Rust, a macro call with a file name, like
`include_str!("x.wgsl")`, `include_bytes!(…)`, `include!(…)` or a
project macro such as `wgsl!("iris.wgsl")`, adds that file. In WGSL and
GLSL, an `#include "x"` or `#import "x"` line does the same. Names resolve
against the including file's folder, then the repository root. The walk
is recursive and bounded, and only committed files count.

- **Checkout.** Every git question about a grid is asked in the project's
  folder (`local_path`, else `path`, as for tasks), at that folder's `HEAD`,
  except for proofs made on a branch the folder lacks (see Branches).
- **Fingerprint** = sha256 of the sorted output of
  `git ls-tree -r HEAD -- <paths…>`, that is, the path and blob id of every
  committed file under the covered paths. Only committed content counts. A
  file being edited does not make a proof stale. A commit that touches the
  row's files does.
- At `prove` the fingerprint is taken in the proving chat's folder at its
  HEAD. `prove` is refused when `git status --porcelain -- <paths>` shows
  uncommitted changes there ("commit the covered code first"), so the proof
  always describes committed code.
- On read, the fingerprint is taken in the project folder and cached by
  `(folder, HEAD sha, paths)`, so a grid read when HEAD has not moved costs no
  git calls. A path that no longer exists contributes nothing, so deleting
  covered code also makes the proof stale.

## Branches

Grid data (checks, cases, cell states)
belong to the project, not to a branch. There is one grid, whatever branch
a chat is on.

- `prove` runs in the chat's own checkout: the project's folder, or a
  worktree.
- A proof is judged, and re-checked, in the checkout that has its commit
  (`last_check.head`). A proof made in a worktree on a branch the project's
  folder lacks is judged in that worktree, at its HEAD. Once the branch is
  merged, the project's folder has the commit and judges it.
- One proof per cell: the latest counts, whichever branch it came from.
- Changed checks make a proof stale on every branch, since the checks are
  the project's.

## Row search

`row_search = {command, watch[], timeout_s?}`

- `command` is a shell command (`sh -c`) run in the checkout. A committed
  script is the norm, for example
  `scripts/grid-rows/camera.sh` or `cargo run -q -p xtask -- grid-rows camera`.
  It prints one JSON object per line:
  `{id, name, paths[], kind?: "feature"|"combination", of?: [row ids]}`.
  `kind` defaults to `feature`. A combination row is for features that
  interact, such as glare × exposure. Its `of` names at least two rows the
  same run prints.
- `watch` is the list of repo-relative path prefixes that make up the area,
  for example `["renderer/camera/", "shaders/camera/"]`. A commit that touches
  any of them reruns the search. It is required and must not be empty.
- `timeout_s` defaults to 120 and may be at most 600. Stdout is capped at
  1 MiB. A run that exits non-zero, times out, prints a line that is not
  valid JSON, uses an invalid id or repeats an id changes nothing. Its error
  is stored in `grid.discovery` and shown on the grid.

**Discovery** is one run of the search applied to the grid, inside one
write transaction:

- a new id adds a `search` row with an `unchecked` cell in every live
  column (`row_added`);
- a known id gets its name and paths updated (new paths change the
  fingerprint, so its proofs go stale on their own);
- a `search` row the run no longer prints gets `missing_since`
  (`row_missing`). Its cells and proof are kept, and it is no longer
  counted;
- a missing id that comes back is cleared (`row_back`);
- an id another grid owns is skipped and listed in `discovery.skipped` with
  its owner. An agent can add it here as a reference row through an edit.
- Manual rows are never touched.
- **When it runs.** `atelier grid discover SLUG` and the grid's **Discover**
  button run it straight away. The server also runs a grid watcher: one task
  that wakes every 60 s and, for each project with grids, reads
  `git rev-parse HEAD` in the project folder. When HEAD has moved since a
  grid's `discovery.head`, it runs `git diff --name-only <old> <new>` and
  reruns the search for each grid whose `watch` matches a changed path. It
  runs one grid at a time, at most one run per grid at once, and sends
  `grids.changed` after each run. The per-window Git panel watcher
  (`routes/git_watch.rs`) is not reused. It only runs while a window
  subscribes to it, and discovery has to happen with no window open.

## Column checks

Each column carries `checks: [Check]`, in the shape tasks use (docs/tasks.md,
Checks), written when the grid is drafted. A column holds only checks that
apply to every row and test the same requirement for each. In a template's
`name`, `command`, `given`, `when`, `then`, `red` and `files`, `{row}` is
replaced by the row id, so one template covers every row. `{row}` is the
only placeholder: a template with any other `{name}` is refused, because
row-specific scenarios, scenes, budgets or data belong in the cell's own
cases (see Cases).

Every check is one case and prints exactly one result line,
`CASE <grid>/<row>/<col>/<case> PASS|FAIL <measured> <limit>` (`-` for
no measure or limit). A column check's case id is `SLUG/{row}/COL/NAME`.
Wrap a command that does not print the line in `atelier case ID -- COMMAND`:
it hides the command's own `CASE` lines and prints the one line from its
exit code. `red` must contain the case id; left out, it is
`CASE <id> FAIL`.

```json
{"id": "gpu", "name": "Runs on the GPU", "proof_rule": "The effect runs in a compute or fragment pass, not on the CPU",
 "checks": [{"name": "on-gpu", "kind": "test",
   "command": "atelier case renderer/{row}/gpu/on-gpu -- cargo test -p renderer --test gpu_passes {row}_runs_on_gpu -- --exact",
   "given": "the {row} effect enabled", "when": "a frame renders", "then": "its work is in a GPU pass and the CPU path is not called",
   "red": "CASE renderer/{row}/gpu/on-gpu FAIL", "files": ["renderer/tests/gpu_passes.rs"]}]}
```

A check run whose output has no `CASE` line, more than one, or one with
another id is **invalid**, not failed: `task start`, `task check`, `task
done` and `grid prove` refuse it and name the wrapper. A `FAIL` line fails
the check, whatever the exit code.

- A cell that needs more, or something else, carries its own checks in the
  draft's `cells: [{row, col, checks, override?}]`. Without `override` they
  are added to the column's; with `override: true` they replace them.
- A drafted column without checks is allowed, but every cell under it
  shows **Needs a check** until an edit adds them, and cannot be proved.
  The draft card names those columns.
- When checks are written (a draft, an edit, `grid checks`, a template
  change), the hashes of their files and the harness files are taken in
  the chat's folder and stored with the grid. Nothing is locked: `prove`
  runs the checks as they are, and a proof made while a recorded check file
  or a helper beside it differs lists them in `changedCheckFiles`.
- Changed checks reopen nothing, but every proved cell whose resolved
  checks changed (a column's templates, or the cell's own) is marked
  `checks_changed` (`checks_changed` event). It reads stale until a passing
  `verify` or `prove` under the new checks.
- Grids made before column checks, and cells proved before them, keep the
  old rules: `prove` takes its own `checks` in the payload.
- To set the checks of some columns without drafting the grid again, run
  `atelier grid checks SLUG --input FILE` with
  `{"columns": [{"id": "docs", "checks": [ … ]}]}`. Only column checks are
  allowed in this payload. They apply at once. Rows, columns, cells, proofs
  and history are kept.
- To add or remove a few rows or columns, run
  `atelier grid change SLUG` with only the change:
  `{"addColumns": [{"id": "scenes", "name": "Saved scenes", "after": "first-col",
  "checks": [ … ]}], "removeColumns": ["old"], "addRows": [{"id": "bloom",
  "name": "Bloom", "paths": ["src/bloom.rs"]}], "removeRows": ["gone"]}`.
  Every field is optional, but at least one is needed. `after` puts a new
  column right after the one it names; without it the column goes last.
  `proof_rule` defaults to "its checks pass". The change applies at once.
  Kept cells keep their proofs. A removed row stays removed, even one the
  row search finds. A new row or column has no place in the order, so its
  cells sit at step order until an agent runs `atelier grid order SLUG`
  again with it listed.
- `atelier grid next` never calls a grid finished while cells need a check.
  It says how many need one and names `atelier grid checks`. Its JSON has
  `finished: false`, and the command exits non-zero when it hands out
  nothing and the grid is not finished.

## Cases

A cell's checks are its column's checks plus its own **cases**. Each case
is one scenario of the row's feature: `{id, given, when, then, command,
red?, covers?, files?, timeout_s?}`, with case id `SLUG/ROW/COL/ID`.

```
atelier grid cases SLUG ROW COL   <<< '{"cases":[{"id":"low-sun","given":…,"when":…,"then":…,"command":"atelier case camera/glare/gpu/low-sun -- cargo test glare_low_sun","covers":"r1g1"}],"dismiss":{"r1g2":"covered by the perf column"}}'
atelier grid review SLUG ROW COL
```

- `grid cases` replaces the cell's case list, and answers review gaps: a
  case's `covers` names the gap it answers, and `dismiss` gives a reason
  for each gap that needs no case. Editing the cases of a reviewed cell
  sends it back to step cases and clears the review.
- `grid review` is run by Atelier, not by the chat: a fresh agent with no
  tools and no chat context gets only the column's name and proof rule,
  the row's name and paths, the column checks and the cases (with answered
  gaps), and returns the scenarios that are missing as gaps (`r1g1`, …). A
  review is refused while a gap is unanswered. The cell is **reviewed**
  when a review returns no gaps, or once the gaps of its 3rd round are
  answered (no 4th review runs). No one approves cases: the owner has no
  step here, and agents never wait for one.
- No cell of a row is handed out (`grid next`) or proved until every cell
  of the row is reviewed. Such a cell shows **Needs cases**; `grid next`
  lists those rows with each cell's step and next command, and the refusal
  names them too.
- Grids from before cases keep their proofs. Every cell without reviewed
  cases shows "Needs cases" and cannot be proved again until it goes
  through cases and review.

## Proof

`prove` runs the cell's checks; the payload only says what was done:

```json
{
  "summary": "Glare kernel matches the reference renderer within 0.5% RMS",
  "tests": ["renderer::camera::glare::tests::glare_matches_reference"],
  "commits": ["9f3c2ab"],
  "benchmarks": [{"name": "glare pass 4K", "value": 0.82, "budget": 1.0, "unit": "ms", "lower_is_better": true}],
  "evidence": ["shots/glare-vs-reference.png"]
}
```

- `summary`: required, ≤ 600 chars.
- The checks are the cell's resolved checks. Each `command` is run with
  `sh -c` in the proving chat's checkout (see Branches). Exit
  0 means pass (a benchmark also needs its budget met), and each output
  must hold exactly one `CASE` line for that check, saying `PASS`. Every
  check must pass, or `prove` is refused with the failing check's exit code and the
  last 40 lines of its output. A `checks` list in the payload is refused
  for a cell with checks, and required for a cell under the old
  rules (at least one; `timeout_s` defaults to 600, max 3600).
- `tests`: names, kept for people and auditors. A check should run them.
- `commits`: each must exist in the proving chat's repository (the same
  `git cat-file -e` test `task done` uses).
- `benchmarks`: each `value` must meet its `budget` (`≤` when
  `lower_is_better`, which defaults to true; `≥` otherwise). Numbers alone
  are claims. The guidance tells agents to add a check that fails when the
  benchmark is over budget.
- `evidence`: image or video paths, uploaded and rewritten to
  `/api/presentation-assets/…` the same way task evidence is.

**Re-check** (`atelier grid verify SLUG [ROW COL]`, the cell's **Re-check**
button, the grid's **Re-check stale**) runs a cell's checks again in the
checkout the proof is judged in (see Checkout above) and stores `last_check`. All passing gives `check_passed`, and
if the cell was stale the fingerprint is taken again and `checks_changed`
is cleared, which makes it fresh: the checks pass on the current code. One failing gives `check_failed`, and the
cell becomes `gap` with reason `check "<name>" failed on re-check (exit N)`.
Proof is kept. Only one run per cell happens at a time. Grid-wide re-checks
go one cell at a time, and each result is announced as it lands.

Checks run outside the database writer, like the commit lookup for tasks:
first the checks run, then the result goes to the writer. The proving chat's
CLI waits for them, so `prove` uses a 1-hour HTTP timeout.

## Cell states

| from | event | to | who | refused when |
|---|---|---|---|---|
| — | grid drafted, row added, column added | `unchecked` | app | |
| any but `na` | `prove` | `proved` | any agent, from any chat | the cell is at step order or cases; it has no checks; a prerequisite is not proved or N/A; a check fails; a benchmark misses its budget; a commit is missing; covered paths are dirty |
| `proved` | re-check fails | `gap` | app | |
| `proved` | audit pass | `proved` (audited) | agent | the agent's chat proved it; the cell is stale |
| `unchecked`, `gap` | `na --reason` | `na` | agent | no reason |
| `proved`, `na` | reopen (reason) | `gap` | any agent, or owner | |

- Every cell also stores its **step**, order → cases → reviewed → proved
  (or `na`), and the one command that moves it on (`next`). Grids from
  before the order step have no order, so their cells move to step order:

  | step | when | next |
  |---|---|---|
  | order | its row or column has no place in the written order | `atelier grid order SLUG` |
  | cases | no cases, unanswered gaps, or not yet reviewed clean | `atelier grid cases SLUG ROW COL`, or `atelier grid review SLUG ROW COL` once the gaps are answered |
  | reviewed | the review is finished (no gaps, or round 3's gaps answered); not proved, or stale | `atelier grid prove SLUG ROW COL` |
  | proved | proved | `atelier grid next SLUG` |
  | na | `na` | `atelier grid next SLUG` |

  The app sets the step on every change; a database from before steps gets
  them filled in once, and its proofs are kept. A cell is proved by its
  passing checks; `grid prove` needs no task and works from any chat. It is
  refused only for a cell at step order or cases, one marked N/A, or one
  with no checks. `grid show SLUG ROW COL` prints
  `Step: STEP. Next: COMMAND`, and so does `grid prove`.
- Stale is not a state. A stale proved cell is shown and counted as open. It
  can be re-checked or proved again.

## Drafting (`@matrix AREA`)

`@matrix` is a bare word reference, like `@task`. The rest of the owner's
message describes the area. The server adds an entry that tells the agent to:

1. Read the area's code. Write (and commit) a row-search script that prints
   one line per user-visible feature, plus combination lines for features
   that interact (anything that shares energy, a buffer or a pass). Run it
   and check the output.
2. Run `atelier grid template list`, pick the template that fits, and add
   grid-specific columns only for requirements the template lacks. Give
   every column check templates with `{row}` (write the test files they
   name first), and cell checks where a row needs something else.
3. Run `atelier grid list --rows` to see which features other grids already
   own, and add reference rows for them instead of new rows.
4. Run `atelier grid draft`. The grid is live at once. Then write its order
   (`atelier grid order SLUG`) and each cell's cases.

`atelier grid draft` payload:

```json
{
  "slug": "camera", "title": "Renderer camera", "area": "Physical camera: lens, glare, sunstars, ghosts, exposure, colour transforms, presets.",
  "template": "physics",
  "row_search": {"command": "scripts/grid-rows/camera.sh", "watch": ["renderer/camera/", "shaders/camera/"]},
  "columns": [{"id": "presets_grounded", "name": "Presets physically grounded", "proof_rule": "Each preset cites a real lens/sensor datasheet and a test loads it",
    "checks": [{"name": "presets-{row}", "kind": "test", "command": "cargo test -p renderer --test presets {row}_presets_cite_datasheets -- --exact",
      "given": "every {row} preset", "when": "it is loaded", "then": "it names a datasheet and its values match it",
      "red": "{row}_presets_cite_datasheets.*FAILED|running 0 tests", "files": ["renderer/tests/presets.rs"]}]}],
  "cells": [{"row": "ghosts", "col": "presets_grounded", "override": true, "checks": [{"name": "no-ghost-presets", "kind": "structure",
    "command": "! grep -rn 'ghost' renderer/camera/presets/", "given": "the preset files", "when": "they are searched", "then": "no preset sets ghosts directly", "red": "ghost"}]}],
  "rows": [
    {"id": "glare_x_exposure", "name": "Glare × exposure", "kind": "combination", "of": ["glare", "exposure"], "paths": []},
    {"id": "tonemap", "name": "Tone mapping (owned by colour grid)", "kind": "reference", "ref": {"grid": "colour", "row": "tonemap"}}
  ]
}
```

- The server runs `row_search` in the drafting chat's folder. The grid's
  rows are the search's rows plus the manual `rows` from the payload
  (`source: manual`). A manual id that the search also prints is refused.
  The rows are always exactly what the saved search produces, so the search
  is proven to rerun.
- The columns are the template's columns (`from_template`) followed by the
  payload's own. An own column with the same id as a template column is
  refused. Checks are validated as for tasks (a malformed one is refused);
  a `cells` entry for a row or column not in the draft is refused.
- Refused when: a feature or combination id is owned by another grid (the
  error names that grid and says to use a reference row); a reference
  points at a row that does not exist or is itself a reference; `of` names
  a row not in the draft; there are no columns; there are more than 400
  rows or 40 columns.
- Gating: none. Any chat may draft a grid, with or without `@matrix`
  (suggesting one is fine), and drafting an existing slug redrafts it
  whole.
- Inside one transaction the server writes `grid_column`/`grid_row` and an
  `unchecked` cell for every new pair, retires dropped columns, sets
  `removed_at` on dropped manual rows (cells and proof kept), and marks
  proved cells whose checks changed. Kept cells keep their proofs. The
  event is `drafted` for a new grid and `edited` for a redraft.
- The CLI prints a `grid` widget with `event: "draft"`. The **draft card**
  shows the title, area, template, columns (template ones marked), rows
  grouped by kind (combinations show their `of`, references show their
  owner), each column's checks (folded, with weak-check flags) and the
  columns that have none, and the row-search command. It is read-only. The
  owner asks for changes in chat, and the agent drafts again or runs
  `grid change`.

## Templates

```
atelier grid template list
atelier grid template set NAME   {columns: [{id, name, proof_rule, checks}]}
```

- `set` applies at once and prints a `grid` widget with
  `event: "template"` that shows the column diff and lists the grids it
  affects.
- For every grid using the template: a new template column becomes a
  `grid_column` with `from_template = 1` and an `unchecked` cell for every
  live row (`column_added`); a removed template column is retired in each
  grid (`column_retired`, proof kept, no longer counted); a renamed column
  or one with a changed `proof_rule` is updated in place. Existing proofs
  are not reopened when a rule changes; changed checks mark proved cells
  `checks_changed`. The card says to `@audit` the grids that are affected.
- A grid's own column may not reuse a template column's id. If a template
  adds an id that a grid already has as its own column, the grid keeps its
  own column, and the card lists the clash.

## Work on cells

- **Selection reference.** `@grid:SLUG` names a grid, and
  `@grid:SLUG.ROWS.COLS` names cells. `ROWS` and `COLS` are each `*` or ids
  joined by `+`. The cells are every pair of a listed row and a listed column:
  `@grid:camera.*.gpu` is a column, `@grid:camera.glare.*` is a row, and
  `@grid:camera.glare+sunstar.gpu+perf` is a block. Like `@diff`, it has its
  own id scanner in `references.rs` and `references.ts`, with cases added to
  `atelier-references.cases.json`. Its entry lists each cell's row, column,
  `proof_rule`, state (stale marked), reason and current proof summary.
  With a bare `@task` in the same message it adds: "Create one task for
  these cells and give them as `cells` in the create payload."
- **Tasks reference cells.** Task create (and propose) takes an optional
  top-level `cells: [{grid, row, col}]` next to `type, title, why, plan`.
  Each cell must exist in a live row and column, or the create is refused
  and names the cell. The task records them in `grid_task_cell`, and its
  plan lists them, one `done_when` item per cell with id `ROW.COL`. The
  cells do not change, and many tasks may reference one cell. A task with
  `cells` still needs the owner's `@task` like any task (or a proposal, or
  the owner's grid pick below).
- **Next cell.** `atelier grid next SLUG [--row ROW | --col COL] [--batch N]`
  (`GET /grids/:project/:slug/next[?row=|?col=][&batch=N]`) hands out one cell at a time:
  the first ready cell in the grid's order, over the whole grid or the row
  or column named. The order is the one an agent wrote with `grid order`
  (rows in their listed order, and in each row the columns in theirs);
  there is no default. A free cell (unchecked, gap, or stale) is ready when
  every cell it comes after is proved or N/A; otherwise it waits, and
  `next` lists it with what it waits for. `--batch N` hands out up to N
  ready cells in that order, for cells that are cheap to do together. Each
  ready cell comes with its proof rule, notes and its
  `atelier grid prove SLUG ROW COL` command. `next` also says how many free
  cells the whole grid has left. Cells that need a check, need cases or
  need order are not free; `next` lists them apart. When nothing is ready
  it says why (waiting, needing a check, cases or order) and exits 3; only
  a grid whose every cell is proved or N/A gets
  `No gaps left in camera. Every cell is proved or N/A.`
- `atelier grid next` never calls a grid finished while cells need a check.
  It says how many need one and names `atelier grid checks`. Its JSON has
  `finished: false`.
- **Order.** A grid has no default order. Before any cell is worked, an
  agent writes it: no owner is involved, but the server refuses
  `grid cases`, `grid review` and `grid prove`, and `grid next` hands out
  nothing, for a cell whose row or column the order does not yet name
  (step order, "Needs order" in `grid next`). `atelier grid order SLUG` takes
  `{"rows": [{"id": ROW, "after": [ROW…], "reason": TEXT}], "columns": [{"id": COLUMN, "after": [COLUMN…], "reason": TEXT}], "cells":[{"row": ROW, "col": COLUMN, "after": [[ROW, COLUMN]…], "reason": TEXT}]}`
  on stdin or `--input FILE`. `rows` and `columns` must each list every
  live row and column once, in the order cells are handed out; each entry
  needs a reason of at least three words, and its `"after"` may name only
  entries listed earlier. `cells` is optional; a cell not listed keeps its
  list. Rows and columns store their place (`order_seq`) and reason
  (`order_reason`), cells their `after_reason`. A new order may add
  prerequisites but may not drop one whose cell is not proved or N/A:
  `that order drops prerequisites whose cells are not proved or N/A:
  sunstar.gpu after glare.gpu`. A column's `"after"` holds back its cell in
  each row until that row's cells in the named columns are proved or N/A
  (glare's GPU cell waits for glare's iris cell); a row's `"after"` does
  the same down each column. A cell's `"after"` names cells in any row
  that must be proved or N/A first (sunstar's GPU cell waits for glare's
  perf cell). Missing, unknown or repeated ids, a missing or one-word
  reason, an `"after"` naming a later entry, and cycles (over rows, columns
  and cells together) are refused, and nothing changes. A prerequisite
  counts as done when it is N/A, or proved and not stale. `grid prove` and
  `task check` refuse a cell whose prerequisites are not done:
  `camera.sunstar.gpu waits for camera.glare.perf, which is not proved or N/A. Next: \`atelier grid next camera\``. Any agent may rewrite
  the order at any time within those rules; each change is a grid event
  of kind `order`.
- **The work-through loop.** `grid next` → `grid prove` each cell it hands
  out, which runs its checks → `grid next` again, until no gaps are left.
  A task is optional: when one references the cell, tick its item with
  `atelier task check N ROW.COL` after the proof.
- **Owner's grid pick.** On the Grids screen the owner selects cells and
  presses Create task, choosing an existing chat or a new one. The server
  keeps the selected cells that need work (with **Only gaps**, only
  unchecked and gap cells, not stale proofs), refuses when none is left,
  creates a todo task held by that chat that references the cells, and
  tells the chat: `The owner created task #N from the camera grid (Glare
  row, 5 cells). …`. This is the owner's yes, so no `@task` is needed. A
  new chat is started in the project's folder on the provider of the
  project's latest chat, titled like the task: `camera: Glare row` for a
  whole row (a whole column or grid is named the same way), or a count,
  `camera: 3 cells`, for any other pick.
- **Proving** is `atelier grid prove SLUG ROW COL`, from any chat, once the
  cell is at step reviewed and its prerequisites are proved or N/A.
- **Task done** takes a shared field `cells: [{grid, row, col, reason}]`
  that lists a proof, N/A or reason for each cell the task references.
  An entry for a cell the task does not reference is refused. Done and
  cancel leave the cells as they are.
- The task card lists its cells with live states: task JSON has `cells:
  [{grid, row, col, state, reason}]`. A proposal's JSON has the `cells` it
  asked for.

## N/A

`atelier grid na SLUG ROW COL --reason TEXT` marks an unchecked or gap cell
N/A at once (`na_set`) and prints a `grid` widget with `event: "na"`. The
reason is required, ≤ 600 chars. An N/A cell is no longer counted.
`atelier grid reopen` (or **Reopen** in the cell detail) undoes it.

## Notes

Anyone can leave a note on a grid, a row, a column or one cell, at any time
and in any state: `atelier grid note SLUG [--row ROW] [--col COL] --text
TEXT` from any agent, or **Add note** in the cell panel from the owner.
Naming neither row nor column notes the whole grid; a row alone notes every
cell in the row, a column alone every cell in the column. The text is
required, at most 4000 characters, and the row or column must exist.

A note is a `note` event (`{text}` payload) and changes nothing else. Each
cell shows its own notes and those of its row, column and grid, oldest
first, each labelled Cell, Row, Column or Grid. They are in the cell panel,
in `atelier grid show SLUG ROW COL`, and under each cell in `atelier grid
next`, so whoever takes the cell sees them before starting.

## Audit (`@audit SLUG`)

`@audit` is a bare word reference, followed by a grid slug. Its entry tells
the agent to review every proved cell in the grid adversarially: whether the
checks actually test the column's `proof_rule`, whether the ground truth is
independent of the code under test, whether benchmarks are measured, and
whether the combinations are really exercised. It then gives a verdict on
each.

```
atelier grid audit SLUG                       proved cells (fresh first), each with its column's proof_rule, proof and last check
atelier grid pass SLUG ROW COL [--note TEXT]
atelier grid reopen SLUG ROW COL --reason TEXT
```

- `pass` is refused for a cell whose `proved_by` is this chat. This is what
  makes the audit a separate agent: any chat that has never proved the cell
  may pass it. `pass` on a stale cell is refused ("re-check or re-prove
  first").
- `reopen` may come from any agent, even the chat that proved the cell: the
  bar for proof changes, and a cell that no longer meets its requirement
  should be reopened.
- `pass` sets `audited_at` and `audited_by` (`audit_passed`). `reopen` sets
  the cell to `gap` with the reason (`reopened`), keeps the proof for the
  record, and the reason is shown wherever the cell is.
- A summary widget (`event: "audit"`) is printed once the agent runs
  `atelier grid audit SLUG --done`. It shows passed and reopened counts and
  the reopened cells with their reasons.

## CLI

Like `atelier task`, it reads `ATELIER_CHAT_SESSION_ID` and `ATELIER_PORT`.
Payloads are JSON on stdin or `--input FILE`. Mutating calls print an
`atelier-widget` block of type `grid` and a one-line summary. Errors exit
non-zero and name the field that is wrong.

```
atelier grid list [--rows]                   grids with % proved and open counts; --rows adds every owned row id
atelier grid show SLUG [ROW COL]             the matrix as text, or one cell with proof and history
atelier grid next SLUG [--row ROW | --col COL] [--batch N]  the next ready cell (or N), each with its prove command
atelier grid order SLUG                      {rows:[{id,after,reason}],columns:[{id,after,reason}],cells?:[{row,col,after:[[row,col]],reason}]}  the hand-out order and what must be proved or N/A first; required before any work
atelier grid template list
atelier grid template set NAME               {columns:[{id,name,proof_rule,checks?}]}  applies at once
atelier grid draft                           {slug,title,area,template?,row_search,columns,rows,cells?}  the grid is live at once
atelier grid change SLUG                     {addColumns?,removeColumns?,addRows?,removeRows?}  add or remove rows and columns; applies at once
atelier grid checks SLUG                     {columns:[{id,checks}]}  column check templates; apply at once
atelier grid discover SLUG
atelier grid cases SLUG ROW COL              {cases?:[{id,given,when,then,command,red?,covers?}],dismiss?:{GAP:reason}}  the cell's cases and gap answers
atelier grid review SLUG ROW COL             Atelier's coverage review of the cell's cases (3 rounds at most)
atelier grid prove SLUG ROW COL              {summary,tests?,commits?,benchmarks?,evidence?}  runs the cell's checks (old cells: checks in the payload)
atelier grid verify SLUG [ROW COL]           re-run checks (whole grid: proved cells)
atelier grid na SLUG ROW COL --reason TEXT   marks the cell N/A at once
atelier grid note SLUG [--row ROW] [--col COL] --text TEXT  a note on the grid, a row, a column or a cell
atelier grid audit SLUG [--done]
atelier grid pass SLUG ROW COL [--note TEXT]
atelier grid reopen SLUG ROW COL --reason TEXT
```

`next` prints the cell (or batch) it hands out with its proof rule, notes
and its `atelier grid prove` command, the cells waiting and what each
waits for, and what is left.

`show` prints one line per row: one character per column (`·` unchecked,
`✗` gap, `✓` proved, `s` stale, `-` N/A),
followed by the row name. Under that come a column key and a list of open
cells with their reasons.

## HTTP

JSON is camelCase.

- `GET /api/workbench/grids?project=ID` (or `?session=ID`, as for tasks) →
  `{projectId, grids: GridSummary[], templates: Template[]}`, where
  `GridSummary = {projectId, slug, title, area, status, template, rowSearch,
  createdBy, approvedAt, updatedAt, discovery, percent, counts:
  {counted, proved, stale, gap, unchecked, na}}` and
  `Template = {name, columns, updatedAt}`.
- `GET /api/workbench/grids/:project/:slug` → `{grid: GridSummary, head,
  columns: [{id, name, proofRule, position, fromTemplate, retired}], rows:
  [{id, name, kind, paths, of, ref, source, missing, removed}], cells: [{row,
  col, state, stale, checksChanged, step, next, reason, provedBy, provedAt,
  auditedAt, lastCheck: {at, passed}|null, proofSummary, checks: Check[],
  needsCheck?: true}]}` (`checks` are the resolved checks; `needsCheck` is
  set when they are empty). Columns also carry their `checks` templates. A
  reference row's cells are the owner grid's cells for columns with the
  same id, marked `ref: true`. Columns that do not match are left out.
- `GET /api/workbench/grids/:project/:slug/cells/:row/:col` → `{cell (with
  full proof and lastCheck), row, column, events: GridEvent[]}`. When the
  proof lists commits, the cell also has `merged: boolean`: every one of them
  is in the project's base branch.
- `GET /api/workbench/grids/:project/:slug/next[?row=ROW|?col=COL][&batch=N]` →
  `{grid, title, scope: {kind: "row"|"col", id, name}|null, cells: [{row,
  col, rowName, colName, state, stale, proofRule, notes, next}], left,
  needsCheck, needsCheckInGrid, waiting, waitingInGrid, needsCases,
  needsCasesInGrid, needsOrder, needsOrderInGrid, finished}`. Each cell's
  `next` is its `atelier grid prove` command. `scope` is null when nothing
  is handed out; `left` counts free cells in the whole grid. `400 {error}`
  for an unknown grid, row or column.
- `POST /api/workbench/task` with `{action: "create", actor: "owner",
  project, grid: {slug, rows, cols, onlyGaps}, chat, brand?}`: the owner's
  grid pick. `rows` and `cols` are lists of ids or `"*"`; `chat` is a
  chat id or `"new"` (`brand` picks the new chat's provider). → `{task,
  sessionId}` or `400 {error}` when no selected cell needs work.
- `POST /api/workbench/grid` with `{action, actor, session?, project?, slug?,
  row?, col?, payload?, files?}` → `{grid?, cell?, widget, summary, failed?,
  template?, audit?}` or `400 {error}`. `failed` is set when the action ran
  but its checks or search failed (a re-check that reopened a cell, a
  discovery whose search failed; the CLI exits 1). A discovery whose search
  fails answers `400 {error}` after recording it in `discovery`.
  `template_set` names the template in `slug`. Grid-wide `verify` takes
  `payload.staleOnly` to re-check only stale cells, and has no widget.
  Agent actions: `draft checks change discover prove verify na audit_done
  pass reopen template_set note order cases review`. Owner actions:
  `reopen verify discover note order`; none of them is an approval. Long
  actions (`prove`, `verify`, `discover`, `review`) run their commands
  before going to the writer.
- Every change sends `{type: "grids.changed", kind: "grids.changed",
  projectId, slug}` on the `workbench` feed.
- Widget: `{type: "grid", event, grid: GridSummary, cell?, template?,
  audit?}`, validated in `media.rs` like `task`. A `template` widget has no
  `grid`; its `template` is `{name, projectId, columns, updatedAt,
  change: {added, removed, changed, affects: [slug], clashes: [{grid,
  column}]}}`. `event` is one of `draft`,
  `template`, `prove`, `na`, `audit`, `reopen`, `pass`, `discover`.

## Reconnect

`tasks::open_section` adds a grid line for the chat when its open tasks
reference cells that are not proved yet:

```
Cells your tasks reference that are not proved yet: #14 → camera.glare.gpu [gap], camera.glare.perf [unchecked]
```

## Older databases

When the app opens a database from an older build, `bring_over` in
`grids/mod.rs` moves it to these rules once:

- A cell that was `in_progress` goes back to the state it had before its
  task (or `gap`). Every claim is cleared.
- A pending N/A request (`na_pending`) becomes `na`.
- A grid draft, edit or check change that was waiting is applied, so the
  grid is live. One that no longer applies (for example, a row id another
  grid now owns) is dropped and logged.
- A waiting template change is applied to the template and its grids.
- Cells that waited for their cases to be approved count as reviewed.

## Front end

- **Tasks tab switch.** A segmented control, **Tasks | Grids**, at the top of
  the Tasks tab. The address is `tab=tasks&view=grids`. `grid=SLUG` opens a
  grid, and `cell=ROW:COL` also opens that cell's detail. These are added to
  `src/lib/address.ts` like `task=`.
- **Grids list.** One row per grid: title, a bar with "N/M proved", and chips
  for gap and stale. Grids are listed by lowest percent first. Templates are
  listed under the grids, read-only.
- **Grid view.** A heatmap with rows down the side (combinations indented
  under their first `of` row, references in italics with their owner),
  columns along the top, their names reading upwards and wrapping rather
  than cut (hovering shows the `proof_rule`), and one square per
  cell coloured by state: unchecked muted, gap destructive, proved success,
  stale success hatched, N/A dash, needs a check a dotted outline with the
  tooltip "Needs a check". Missing rows are dimmed and retired columns are
  hidden behind a "Show retired" toggle. Above the heatmap: discovery
  status (last run, added/missing counts, error), **Discover** and
  **Re-check stale**.
- **Selection.** Clicking a column header selects that column. Clicking a
  row header selects that row. Clicking a cell opens its detail and outlines
  it; ctrl- or cmd-click selects the cell without opening it. Shift-click or
  drag selects the rectangle from the anchor. A selection is always a row set
  × column set, which is what `@grid:` encodes. The selection bar, shown only
  for a selection made this way and not for a cell opened, reads
  "N cells · **New task**". New task uses the Tasks tab's New task flow (new
  chat or an existing chat) and prefills `@task @grid:SLUG.ROWS.COLS `
  through `prefillChat`, with `startTaskIn` given the line.
- **Cell detail panel.** State (and stale, or checks changed); step and next
  command; reason; the cell's checks and cases (Given/When/Then and command,
  the column's marked apart from the cell's own), or **Needs a check**;
  proof: summary, checks with the last result and time, benchmarks as a
  value/budget/unit table with pass marks, tests, commits (with the Merged
  badge logic), evidence inline; history from the cell's events; buttons:
  **Re-check**, and **Reopen** (with a reason) when proved or N/A.
- **Cards** (widget `grid`): draft, template, N/A, prove, audit and discover
  cards are read-only summaries; none carries a button for the owner. Every
  card rereads on `grids.changed`. Draft cards start open. Others start
  folded (as in `opensByDefault`).
- **`@` menu.** Adds "Draft a coverage grid" (`@matrix `), "Audit a grid"
  (`@audit ` then grid slugs offered), and grids by title (`@grid:slug`) in
  `mention.rs`.
- Hooks: `useGrids(projectId)` and `useGrid(projectId, slug)`, refetched on
  `grids.changed`, modelled on `useTasks`.

## Agent guidance

The tasks builtin (`machinery/skills/tasks/SKILL.md`, id `atelier-tasks`,
always on) gets a short **Grids** section: what a grid and a cell are, that
a grid may be drafted without `@matrix` and is live at once, that nothing
about a grid waits for the owner, that every column needs check templates
with `{row}` (a cell may add or override) and a cell without one shows
"Needs a check" and cannot be proved, the command list above, the
work-through loop (`grid next` → `grid prove` each cell → repeat; a task
that references a cell ticks it with `task check N ROW.COL`), the cell
steps order → cases → reviewed → proved with the `Step:` line, the order an
agent must write first (every row and column, each with a reason; no
default), cases (`atelier grid cases`, `atelier grid review`, "Needs
cases"), the `CASE <grid>/<row>/<col>/<case> PASS|FAIL` line and
`atelier case`, cell prerequisites in `grid order`
(`"cells":[{"row":…}]`), that grid data
belong to the project, not to a branch, "`grid prove` runs the cell's checks; commit the covered code
first", "a task with `cells` ends with proof, N/A or a reason for every
cell", and "never pass a cell your chat proved; reopen any cell that no
longer meets its requirement". The step-by-step instructions for drafting
and auditing are in the `@matrix` and `@audit` reference entries, as
`@merge` carries its own steps. That way sessions that never touch grids
pay for a few lines, not a page. `session_policy.rs`'s test that every
session gets the task rules is extended to check for `atelier grid prove`.

## Module layout

- `server/src/workbench/grids/mod.rs`: SCHEMA, rows, `apply` (one
  transaction, one event per change), percent, counts, `bring_over`, and
  the cell links (`link`, `check_done_cells`, `task_cells`) called from
  `tasks::apply_in`.
- `server/src/workbench/grids/search.rs`: running the row search and
  validating its output.
- `server/src/workbench/grids/proof.rs`: proof validation, running checks,
  fingerprints and their cache.
- `server/src/workbench/grids/watch.rs`: the 60 s HEAD watcher's loop and
  rules; what a tick reads and writes is `watch` in
  `server/src/routes/workbench/grids.rs`.
- `server/src/workbench/grids/cli.rs`: `atelier grid`.
- `server/src/routes/workbench/grids.rs`: routes and `announce`.
- `src/workbench/grids/`: `types.ts`, `use-grids.ts`, `grids-view.tsx`,
  `grid-heatmap.tsx`, `cell-detail.tsx`, `grid-card.tsx`, `selection.ts`
  (selection ↔ `@grid:` id).

## Tests

Rust unit tests (`grids/mod.rs` and its siblings, in the style of the tasks
tests), among them:

- `a_draft_is_what_the_row_search_prints_plus_manual_rows`
- `any_chat_drafts_or_redrafts_a_grid_with_no_matrix`
- `a_draft_writes_rows_columns_and_unchecked_cells_at_once`
- `a_feature_belongs_to_one_grid_and_a_reference_reads_the_owners_cells`
- `an_edit_to_a_live_grid_applies_at_once`
- `a_template_change_adds_unchecked_cells_and_retires_removed_columns`
- `discovery_adds_new_rows_marks_missing_and_skips_owned_ids`
- `a_failing_or_bad_row_search_changes_nothing`
- `prove_needs_a_passing_check_budgets_met_and_existing_commits`
- `prove_is_refused_while_the_covered_paths_are_dirty`
- `a_commit_to_covered_code_makes_a_proof_stale_and_a_recheck_freshens_it`
- `a_failed_recheck_reopens_the_cell`
- `percent_counts_fresh_proof_over_live_cells_without_na`
- `a_task_references_its_cells_without_claiming_them`
- `task_done_needs_nothing_of_its_cells_and_leaves_them_as_they_are`
- `cancel_leaves_its_cells_as_they_are`
- `na_applies_at_once_and_reopen_undoes_it`
- `a_task_with_cells_still_needs_task`
- `next_lists_one_row_of_ready_cells_with_their_prove_commands`
- `the_owner_creates_a_task_from_a_selection_and_its_cells_are_claimed`
- `refusals_say_what_to_do`
- `an_audit_verdict_from_the_proving_chat_is_refused`
- `any_other_chat_passes_or_reopens_cells_in_an_audit`
- `any_agent_reopens_a_proved_cell`
- `the_grid_widget_is_a_valid_block` (media.rs)
- reference parsing: `@matrix`, `@audit slug`, `@grid:` ids, shared cases JSON.

Integration tests (`server/tests/it/`): `grid_without_approvals.rs` (a
drafted grid, a change, new checks, N/A and a template change all apply at
once; the owner approval actions are gone; any chat proves a cell a task
references; two tasks may reference one cell; `next` hands out cells with
no task payload; a database from before is brought over) and
`grid_branches.rs` (a cell proved on a branch is fresh from main, stays
fresh after the branch merges, the latest of two proofs counts, and
changed checks make a proof stale on every branch).

Front end (vitest, `src/workbench/grids/__tests__/`): selection to `@grid:` id
and back; the heatmap draws each state, with stale hatched; New task prefills
the composer; the cell detail shows proof and history; the list orders and
counts; the deep link `grid=…&cell=…` opens the cell.

E2E (`tests/e2e/`, against a test project with a scratch git repo and a
throwaway grid; never the owner's app on port 3008):

- `grid-without-approvals.spec.ts`: a grid is live, changed and marked N/A
  with no owner step.
- `grid-row-cases.spec.ts`: a row goes through cases and review to ready
  with no owner step.
- `grid-card-shows-checks.spec.ts`: the grid card shows checks, names and
  the row search.

## Rollout

1. Server: schema, `grids::apply`, row search, proof and fingerprints, CLI,
   routes, `grids.changed`, unit tests.
2. Task integration: `cells` on create/propose/done, the grid
   reference kinds (`@grid`, `@matrix`, `@audit`) on both sides, widget
   validation, reconnect lines.
3. Front end: Grids view, heatmap, selection to task, cell detail, cards,
   `@` menu entries. Vitest and E2E.
4. Guidance: the tasks skill's Grids section. Changelog entry.
5. Operational, not code: the owner opens a Corsetta chat and asks
   `@matrix renderer camera: lens properties, glare, sunstars, ghosts,
   exposure, colour transforms, camera presets`. A `physics` template is set
   first (ground-truth tests, no CPU/GPU duplication, on the GPU where it
   belongs, optimized within budget, physically accurate, energy-conserving
   in combination, not hardcoded to one scenario, presets physically
   grounded, no coupling or duplication), and the first real grid is live
   as soon as the agent drafts it.

## Criteria map

| id | where |
|---|---|
| model | Data; Cell states; CLI; HTTP |
| templates | Data (`grid_template`); Templates; Drafting (columns) |
| draft | Drafting (`@matrix AREA`); Row search; Front end (draft card) |
| proof | Proof; Covered code and staleness; Cell states |
| na | N/A; Cell states; Older databases |
| discovery | Row search (Discovery, When it runs) |
| ownership | Principles; Data (ownership index); Drafting refusals; HTTP (reference rows) |
| work | Work on cells; Cell states; Branches; Front end (Selection) |
| audit | Audit (`@audit SLUG`); Cell states |
| ui | Front end (Tasks tab switch, Grids list, Grid view, Cell detail panel) |
| corsetta | Rollout, step 5 |
| verified | Tests |
