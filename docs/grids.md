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
- A grid counts only after the owner approves it. An agent drafts it and the
  owner approves or discards the draft on a card. A later edit to an approved
  grid is drafted and approved the same way.
- **Proved** means there is proof the app can run again. The proof names
  shell checks that must pass. The app runs them when the proof is given and
  again on request. A proof also stops counting as soon as the code it covers
  changes (stale).
- A feature has one owner. A row id belongs to one grid in the project.
  Another grid that depends on it adds a reference row, which shows the
  owner's cells read-only. Rows are never copied.
- Work on cells is done as tasks. A task claims its cells, and a claimed cell
  cannot be claimed again. When the task is done, every claimed cell has
  either proof or a reason why it has none.
- Approving N/A and approving a draft are the owner's decisions. Reviewing
  proved cells (audit) is done by a different chat from the one that proved
  them.

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
| `status` | text | `draft`, `approved`, `discarded` |
| `template` | text, null | name of a `grid_template` |
| `row_search` | json | `{command, watch[], timeout_s?}` (see Row search) |
| `pending` | json, null | a draft waiting for the owner (see Drafting) |
| `created_by` | text, null | session that drafted it |
| `drafted_by` | text, null | session that wrote `pending` |
| `created_at`, `updated_at`, `approved_at` | integer ms | |
| `discovery` | json, null | the last run: `{at, head, ok, added[], missing[], back[], skipped[{id, owner}], error?}` |

`grid_column`: `(project_id, slug, id)` is the key. Other columns: `name`,
`proof_rule` (text: what counts as proof for this requirement, ≤ 1000 chars),
`position`, `from_template` (0/1) and `retired_at` (null while it counts).

`grid_row`: `(project_id, slug, id)` is the key. Other columns: `name`;
`kind` (`feature`, `combination` or `reference`); `paths` (json array of
repo-relative files or folders); `of` (json array of row ids, combinations
only); `ref` (json `{grid, row}`, references only); `source` (`search` or
`manual`); `added_at`; `missing_since` (null while the row search still
prints it); `removed_at` (set when an approved edit drops a manual row).

- Ownership index:
  `CREATE UNIQUE INDEX grid_row_owner ON grid_row(project_id, id) WHERE kind <> 'reference' AND removed_at IS NULL`.
  Draft rows are kept only in `grid.pending` and do not get `grid_row`
  entries until the draft is approved, so a draft takes no ids away from
  other grids.

`grid_cell`: `(project_id, slug, row, col)` is the key. Every live feature or
combination row has one cell per column. Reference rows have no cells.

| column | type | notes |
|---|---|---|
| `state` | text | `unchecked`, `gap`, `in_progress`, `proved`, `na_pending`, `na` |
| `proof` | json, null | see Proof; kept when a cell reopens, until replaced |
| `fingerprint` | text, null | of the row's covered code when it was proved |
| `proved_by`, `proved_at` | text, integer | session and time |
| `last_check` | json, null | `{at, head, passed, results[{name, exit, ms, tail}]}` |
| `claimed_task` | integer, null | the task number that claims the cell |
| `claimed_from` | text, null | the state it had before the claim, restored on cancel |
| `reason` | text, null | why it is a gap, why N/A, or why an audit reopened it |
| `audited_at`, `audited_by` | integer, text, null | the last audit pass |

`grid_event`: `(project_id, slug, seq, at, kind, row, col, session_id,
actor, payload)`. `row` and `col` are null for events about the whole grid.
Every change appends a row. A cell's history is its own events. Kinds:
`drafted`, `approved`, `discarded`, `edit_drafted`, `edit_approved`,
`edit_discarded`, `discovered`, `row_added`, `row_missing`, `row_back`,
`column_added`, `column_retired`, `claimed`, `released`, `proved`,
`check_passed`, `check_failed`, `gap`, `na_asked`, `na_approved`,
`na_rejected`, `audit_passed`, `reopened`.

`grid_template`: `(project_id, name)` is the key. Other columns: `columns`
(json `[{id, name, proof_rule}]`), `pending` (json, null: a change waiting for
the owner), `updated_at` and `updated_by`.

`grid_task_cell`: `(project_id, task, slug, row, col)`, the key, one row per
cell a task ever claimed. A claim is released on done or cancel, so this is
what the task card reads to keep listing its cells afterwards. A proposal's
cells wait in a `cells` json column added to `task_proposal`.

### Derived, never stored

These are worked out each time a grid is read:

- **stale**: a `proved` cell whose row's fingerprint now differs from the one
  stored with the proof.
- **missing**: a row with `missing_since` set. **retired**: a column with
  `retired_at` set.
- **counted cells**: cells of live feature and combination rows (not missing,
  not removed) in live columns, minus cells in state `na`.
- **percent proved** = `proved and not stale` / `counted`, rounded down.
  `na_pending` counts as open. Only approved grids have a percent.

## Covered code and staleness

A row covers its `paths`. A combination row covers its own paths plus the
paths of every row in its `of`.

- **Checkout.** Every git question about a grid is asked in the project's
  folder (`local_path`, else `path`, as for tasks), at that folder's `HEAD`.
  Proof given in another worktree counts once its commits reach that
  folder's HEAD, which matches how the Merged badge reads merges.
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

**Discovery** is one run of the search applied to the grid:

- To a draft grid: the rows in `pending` are replaced by the run's rows, and
  the manual rows are kept.
- To an approved grid, inside one write transaction:
  - a new id adds a `search` row with an `unchecked` cell in every live
    column (`row_added`);
  - a known id gets its name and paths updated (new paths change the
    fingerprint, so its proofs go stale on their own);
  - a `search` row the run no longer prints gets `missing_since`
    (`row_missing`). Its cells and proof are kept, and it is no longer
    counted;
  - a missing id that comes back is cleared (`row_back`);
  - an id another grid owns is skipped and listed in `discovery.skipped` with
    its owner. The owner can add it here as a reference row through an edit.
  - Manual rows are never touched.
- **When it runs.** `atelier grid discover SLUG` and the grid's **Discover**
  button run it straight away. The server also runs a grid watcher: one task
  that wakes every 60 s and, for each project with approved grids, reads
  `git rev-parse HEAD` in the project folder. When HEAD has moved since a
  grid's `discovery.head`, it runs `git diff --name-only <old> <new>` and
  reruns the search for each grid whose `watch` matches a changed path. It
  runs one grid at a time, at most one run per grid at once, and sends
  `grids.changed` after each run. The per-window Git panel watcher
  (`routes/git_watch.rs`) is not reused. It only runs while a window
  subscribes to it, and discovery has to happen with no window open.

## Proof

```json
{
  "summary": "Glare kernel matches the reference renderer within 0.5% RMS",
  "checks": [{"name": "glare ground truth", "command": "cargo test -p renderer glare_matches_reference", "timeout_s": 600}],
  "tests": ["renderer::camera::glare::tests::glare_matches_reference"],
  "commits": ["9f3c2ab"],
  "benchmarks": [{"name": "glare pass 4K", "value": 0.82, "budget": 1.0, "unit": "ms", "lower_is_better": true}],
  "evidence": ["shots/glare-vs-reference.png"]
}
```

- `summary`: required, ≤ 600 chars.
- `checks`: at least one. `command` is run with `sh -c` in the proving chat's
  folder. Exit 0 means pass. `timeout_s` defaults to 600, max 3600. Every
  check must pass when `prove` is called, or `prove` is refused with the
  failing check's exit code and the last 40 lines of its output.
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
project folder and stores `last_check`. All passing gives `check_passed`, and
if the cell was stale the fingerprint is taken again, which makes it fresh:
the checks pass on the current code. One failing gives `check_failed`, and the
cell becomes `gap` with reason `check "<name>" failed on re-check (exit N)`.
Proof is kept. Only one run per cell happens at a time. Grid-wide re-checks
go one cell at a time, and each result is announced as it lands.

Checks run outside the database writer, like the commit lookup for tasks:
first the checks run, then the result goes to the writer. The proving chat's
CLI waits for them, so `prove` uses a 1-hour HTTP timeout.

## Cell states

| from | event | to | who | refused when |
|---|---|---|---|---|
| — | grid approved, row added, column added | `unchecked` | app | |
| `unchecked`, `gap`, stale `proved` | task created with this cell | `in_progress` | agent (with `@task`) | another open task claims it; fresh `proved`; `na`, `na_pending`; row missing or column retired |
| any but `na`, `na_pending` | `prove` | `proved` | agent | claimed by a task held by another chat; a check fails; a benchmark misses its budget; a commit is missing; covered paths are dirty |
| `in_progress` | claiming task done, cell listed with a reason | `gap` (reason) | app | |
| `in_progress` | claiming task cancelled | `claimed_from` | app | |
| `proved` | re-check fails | `gap` | app | |
| `proved` | audit reopen | `gap` (reason) | agent in an `@audit` chat, or owner | the agent's chat proved it |
| `proved` | audit pass | `proved` (audited) | agent in an `@audit` chat | the agent's chat proved it; the cell is stale |
| `unchecked`, `gap`, `in_progress` | `na --reason` | `na_pending` | agent | no reason |
| `na_pending` | approve N/A | `na` | owner | |
| `na_pending` | reject N/A (note) | `gap` (note), or `in_progress` if claimed | owner | |
| `na` | reopen | `gap` (reason) | owner | |
| `proved` | owner reopen (reason) | `gap` | owner | |

- A claim (`claimed_task`) is held until the task ends, separate from the
  state. A cell proved during its task stays claimed until the task is done
  or cancelled, so nobody else can claim it in that time.
- Stale is not a state. A stale proved cell is shown and counted as open. It
  can be re-checked, claimed or proved again.

## Drafting (`@matrix AREA`)

`@matrix` is a bare word reference, like `@task`. The rest of the owner's
message describes the area. The server adds an entry that tells the agent to:

1. Read the area's code. Write (and commit) a row-search script that prints
   one line per user-visible feature, plus combination lines for features
   that interact (anything that shares energy, a buffer or a pass). Run it
   and check the output.
2. Run `atelier grid template list`, pick the template that fits, and add
   grid-specific columns only for requirements the template lacks.
3. Run `atelier grid list --rows` to see which features other grids already
   own, and add reference rows for them instead of new rows.
4. Run `atelier grid draft` and stop. Continue when the owner's answer
   arrives.

`atelier grid draft` payload:

```json
{
  "slug": "camera", "title": "Renderer camera", "area": "Physical camera: lens, glare, sunstars, ghosts, exposure, colour transforms, presets.",
  "template": "physics",
  "row_search": {"command": "scripts/grid-rows/camera.sh", "watch": ["renderer/camera/", "shaders/camera/"]},
  "columns": [{"id": "presets_grounded", "name": "Presets physically grounded", "proof_rule": "Each preset cites a real lens/sensor datasheet and a test loads it"}],
  "rows": [
    {"id": "glare_x_exposure", "name": "Glare × exposure", "kind": "combination", "of": ["glare", "exposure"], "paths": []},
    {"id": "tonemap", "name": "Tone mapping (owned by colour grid)", "kind": "reference", "ref": {"grid": "colour", "row": "tonemap"}}
  ]
}
```

- The server runs `row_search` in the drafting chat's folder. The draft's
  rows are the search's rows plus the manual `rows` from the payload
  (`source: manual`). A manual id that the search also prints is refused.
  The draft is always exactly what the saved search produces, so the search
  is proven to rerun.
- The columns are the template's columns (`from_template`) followed by the
  payload's own. An own column with the same id as a template column is
  refused.
- Refused when: the slug belongs to a grid created by another chat that is
  still a draft; a feature or combination id is owned by another approved
  grid (the error names that grid and says to use a reference row); a
  reference points at a row that does not exist or is itself a reference;
  `of` names a row not in the draft; there are no columns; there are more
  than 400 rows or 40 columns.
- Gating: if the slug is new, `draft` is refused unless the chat's latest
  owner message has a bare `@matrix`, the same rule as `task create`. It is
  allowed without one when the chat is redrafting its own pending draft
  because the owner asked for changes.
- Where the draft goes: for a new slug, a `grid` row with `status: draft` and
  `pending` set. For an approved grid, only `pending` is set (an edit). The
  live rows and cells do not change until the owner approves.
- The CLI prints a `grid` widget with `event: "draft"`. The **draft card**
  shows the title, area, template, columns (template ones marked), rows
  grouped by kind (combinations show their `of`, references show their
  owner), the row-search command, and for an edit a diff (rows and columns
  added, retired or removed). It has **Approve** and **Discard** buttons. The
  owner asks for changes in chat, and the agent drafts again, which replaces
  `pending` and the card's content (the card rereads on `grids.changed`).
- **Approve**: inside one transaction, re-checks ownership (another grid may
  have taken an id since), writes `grid_column`/`grid_row` and an `unchecked`
  cell for every new pair, retires dropped columns, sets `removed_at` on
  dropped manual rows (cells and proof kept), sets `status: approved`, and
  clears `pending`. **Discard** clears `pending`. A draft that was never
  approved becomes `discarded`, and its slug can be drafted again.
- The drafting chat is told the answer with `tell_chat` (the proposal
  mechanism): `Owner approved grid "camera" (14 rows × 9 columns). …` or
  `Owner discarded …`.

## Templates

```
atelier grid template list
atelier grid template set NAME   {columns: [{id, name, proof_rule}]}
```

- `set` stores the change in `grid_template.pending` and prints a `grid`
  widget with `event: "template"` that shows the column diff and lists the
  approved grids it affects. The owner approves or rejects it on the card. A
  template change touches every grid that uses it, so it goes through the
  owner the same way a draft does.
- On approval, for every approved grid using the template: a new template
  column becomes a `grid_column` with `from_template = 1` and an `unchecked`
  cell for every live row (`column_added`); a removed template column is
  retired in each grid (`column_retired`, proof kept, no longer counted); a
  renamed column or one with a changed `proof_rule` is updated in place.
  Existing proofs are not reopened when a rule changes. The card says to
  `@audit` the grids that are affected.
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
  `proof_rule`, state (stale marked), reason, current proof summary and the
  task claiming it, if any. With a bare `@task` in the same message it adds:
  "Create one task for these cells and give them as `cells` in the create
  payload."
- **Task create** (and propose) takes an optional top-level
  `cells: [{grid, row, col}]` next to `type, title, why, plan`. Inside the
  task transaction (both sets of tables are in `workbench.db`), each cell
  must be claimable (see Cell states), or the whole create is refused and the
  refusal names the first cell that blocks and why, for example
  `camera.glare.gpu is claimed by #14 in chat "Glare GPU"`. Claimed cells
  become `in_progress` with `claimed_task = N` and `claimed_from` set, and
  get a `claimed` event. A proposal checks the cells when it is made and
  claims them only when the owner answers **Create task**. If one was taken
  in the meantime, that answer is refused with the reason. The guidance
  recommends type `feature` with one criterion per cell, id `ROW.COL`.
- **Proving** during the task: `atelier grid prove SLUG ROW COL`, run from
  the chat that holds the claiming task (`take` moves the claim with the
  task, because the claim belongs to the task number).
- **Task done** takes a shared field `cells: [{grid, row, col, reason}]`.
  `done` is refused while a claimed cell is still `in_progress` and has no
  entry with a reason here. On done, those cells become `gap` with the
  reason (`gap` event, payload `{task: N}`), and every claim of the task is
  released. `proved` and `na_pending` cells keep their state. For review
  types, the release happens when the task enters `review`.
- **Cancel** releases the claims, and each `in_progress` cell goes back to
  `claimed_from`.
- The task card lists its cells with live states: task JSON has `cells:
  [{grid, row, col, state, claimed, reason}]`, and a proposal's JSON has the
  `cells` it asked for. The cell detail links to
  its claiming task.

## N/A

`atelier grid na SLUG ROW COL --reason TEXT` sets the cell to `na_pending`
(`na_asked`) and prints a `grid` widget with `event: "na"`. The reason is
required, ≤ 600 chars. The owner gives the answer on that card or in the
cell detail: **Approve N/A** (→ `na`, no longer counted) or **Reject** with a
note (→ `gap`, or `in_progress` if still claimed). The asking chat is told the
answer with `tell_chat`. Only the owner can move a cell to `na`.

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

- `pass` and `reopen` from an agent are refused unless the chat's latest
  owner message has `@audit SLUG` for this grid, and refused for a cell whose
  `proved_by` is this chat. This is what makes the audit a separate agent.
  The owner can start the audit in a fresh chat, but one that has never
  proved the cell is enough. `pass` on a stale cell is refused ("re-check or
  re-prove first").
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
atelier grid template list
atelier grid template set NAME               {columns:[{id,name,proof_rule}]}
atelier grid draft                           {slug,title,area,template?,row_search,columns,rows}
atelier grid discover SLUG
atelier grid prove SLUG ROW COL              {summary,checks,tests?,commits?,benchmarks?,evidence?}
atelier grid verify SLUG [ROW COL]           re-run checks (whole grid: proved cells)
atelier grid na SLUG ROW COL --reason TEXT
atelier grid audit SLUG [--done]
atelier grid pass SLUG ROW COL [--note TEXT]
atelier grid reopen SLUG ROW COL --reason TEXT
```

`show` prints one line per row: one character per column (`·` unchecked,
`✗` gap, `~` in progress, `✓` proved, `s` stale, `?` N/A pending, `-` N/A),
followed by the row name. Under that come a column key and a list of open
cells with their reasons.

## HTTP

JSON is camelCase.

- `GET /api/workbench/grids?project=ID` (or `?session=ID`, as for tasks) →
  `{projectId, grids: GridSummary[], templates: Template[]}`, where
  `GridSummary = {projectId, slug, title, area, status, template, rowSearch,
  createdBy, approvedAt, updatedAt, pending, discovery, percent, counts:
  {counted, proved, stale, gap, unchecked, inProgress, naPending, na}}` and
  `Template = {name, columns, pending, updatedAt}`.
- `GET /api/workbench/grids/:project/:slug` → `{grid: GridSummary, head,
  columns: [{id, name, proofRule, position, fromTemplate, retired}], rows:
  [{id, name, kind, paths, of, ref, source, missing, removed}], cells: [{row,
  col, state, stale, claimedTask, reason, provedBy, provedAt, auditedAt,
  lastCheck: {at, passed}|null, proofSummary}]}`. A reference row's cells
  are the owner grid's cells for columns with the same id, marked `ref:
  true`. Columns that do not match are left out.
- `GET /api/workbench/grids/:project/:slug/cells/:row/:col` → `{cell (with
  full proof and lastCheck), row, column, events: GridEvent[]}`. When the
  proof lists commits, the cell also has `merged: boolean`: every one of them
  is in the project's base branch.
- `POST /api/workbench/grid` with `{action, actor, session?, project?, slug?,
  row?, col?, payload?, files?}` → `{grid?, cell?, widget, summary, failed?,
  template?, audit?}` or `400 {error}`. `failed` is set when the action ran
  but its checks or search failed (a re-check that reopened a cell, a
  discovery whose search failed; the CLI exits 1). A discovery whose search
  fails answers `400 {error}` after recording it in `discovery`. Template
  actions (`template_set`, `approve_template`, `reject_template`) name the
  template in `slug`. Grid-wide `verify` takes `payload.staleOnly` to re-check
  only stale cells, and has no widget. Agent actions: `draft discover prove verify na audit_done
  pass reopen template_set`. Owner actions: `approve discard approve_na
  reject_na reopen verify discover approve_template reject_template`. Long
  actions (`prove`, `verify`, `discover`) run their commands before going to
  the writer.
- Every change sends `{type: "grids.changed", kind: "grids.changed",
  projectId, slug}` on the `workbench` feed. Claim changes also send
  `tasks.changed`.
- Widget: `{type: "grid", event, grid: GridSummary, cell?, template?,
  audit?}`, validated in `media.rs` like `task`. A `template` widget has no
  `grid`; its `template` is `{name, projectId, columns, pending, updatedAt,
  change: {added, removed, changed, affects: [slug], clashes: [{grid,
  column}]}}`. `event` is one of `draft`,
  `template`, `prove`, `na`, `audit`, `reopen`, `pass`, `discover`.

## Reconnect

`tasks::open_section` adds grid lines for the chat, when it has any:

```
Grid drafts awaiting the owner: camera (Renderer camera)
Cells claimed by your tasks: #14 → camera.glare.gpu [in_progress], camera.glare.perf [proved]
N/A awaiting the owner: camera.ghosts.presets_grounded
```

## Front end

- **Tasks tab switch.** A segmented control, **Tasks | Grids**, at the top of
  the Tasks tab. The address is `tab=tasks&view=grids`. `grid=SLUG` opens a
  grid, and `cell=ROW:COL` also opens that cell's detail. These are added to
  `src/lib/address.ts` like `task=`.
- **Grids list.** One row per grid: title, a bar with "N/M proved", and chips
  for gap, stale and N/A pending, plus an **Awaiting approval** chip when
  `pending` is set. Draft grids come first, then the rest by lowest percent
  first. Discarded grids are hidden. Templates are listed under the grids,
  read-only, with any pending change.
- **Grid view.** A heatmap with rows down the side (combinations indented
  under their first `of` row, references in italics with their owner),
  columns along the top, their names reading upwards and wrapping rather
  than cut (hovering shows the `proof_rule`), and one square per
  cell coloured by state: unchecked muted, gap destructive, in progress info,
  proved success, stale success hatched, N/A pending warning outline, N/A
  dash. Missing rows are dimmed and retired columns are hidden behind a
  "Show retired" toggle. Above the heatmap: discovery status (last run,
  added/missing counts, error), **Discover**, **Re-check stale**, and the
  pending-edit banner with Approve/Discard.
- **Selection.** Clicking a column header selects that column. Clicking a
  row header selects that row. Clicking a cell opens its detail and outlines
  it; ctrl- or cmd-click selects the cell without opening it. Shift-click or
  drag selects the rectangle from the anchor. A selection is always a row set
  × column set, which is what `@grid:` encodes. The selection bar, shown only
  for a selection made this way and not for a cell opened, reads "N cells (M
  claimable) · **New task**".
  New task uses the Tasks tab's New task flow (new chat or an existing chat)
  and prefills `@task @grid:SLUG.ROWS.COLS ` through `prefillChat`, with
  `startTaskIn` given the line. Cells that are not claimable are listed in a
  tooltip with the reason.
- **Cell detail panel.** State (and stale or claimed, with a link to the
  task); reason; proof: summary, checks with the last result and time,
  benchmarks as a value/budget/unit table with pass marks, tests, commits
  (with the Merged badge logic), evidence inline; history from the cell's
  events; buttons: **Re-check**, **Approve N/A** and **Reject** (with a note)
  when `na_pending`, and **Reopen** (with a reason) when proved or N/A.
- **Cards** (widget `grid`): the draft card, the template card and the N/A
  card carry their owner buttons in the chat. Prove, audit and discover cards
  are read-only summaries. Every card rereads on `grids.changed`. Draft and
  N/A cards start open. Others start folded (as in `opensByDefault`).
- **`@` menu.** Adds "Draft a coverage grid" (`@matrix `), "Audit a grid"
  (`@audit ` then grid slugs offered), and grids by title (`@grid:slug`) in
  `mention.rs`.
- Hooks: `useGrids(projectId)` and `useGrid(projectId, slug)`, refetched on
  `grids.changed`, modelled on `useTasks`.

## Agent guidance

The tasks builtin (`machinery/skills/tasks/SKILL.md`, id `atelier-tasks`,
always on) gets a short **Grids** section: what a grid and a cell are, the
command list above, "prove only with checks that pass; commit the covered
code first", "a task with `cells` must end with proof, N/A or a reason for
every cell", and "never pass or reopen cells outside an `@audit` request". The
step-by-step instructions for drafting and auditing are in the `@matrix` and
`@audit` reference entries, as `@merge` carries its own steps. That way
sessions that never touch grids pay for six lines, not a page.
`session_policy.rs`'s test that every session gets the task rules is
extended to check for `atelier grid prove`.

## Module layout

- `server/src/workbench/grids/mod.rs`: SCHEMA, rows, `apply` (one
  transaction, one event per change), percent, counts, claim and release
  helpers called from `tasks::apply_in`.
- `server/src/workbench/grids/search.rs`: running the row search and
  validating its output.
- `server/src/workbench/grids/proof.rs`: proof validation, running checks,
  fingerprints and their cache.
- `server/src/workbench/grids/watch.rs`: the 60 s HEAD watcher's loop and
  rules; what a tick reads and writes is `watch` in
  `server/src/routes/workbench/grids.rs`.
- `server/src/workbench/grids/cli.rs`: `atelier grid`.
- `server/src/routes/workbench/grids.rs`: routes, `announce`, reuse of
  `tell_chat`, which moves to a shared spot in `routes/workbench`.
- `src/workbench/grids/`: `types.ts`, `use-grids.ts`, `grids-view.tsx`,
  `grid-heatmap.tsx`, `cell-detail.tsx`, `grid-card.tsx`, `selection.ts`
  (selection ↔ `@grid:` id).

## Tests

Rust unit tests (`grids/mod.rs` and its siblings, in the style of the tasks
tests):

- `a_draft_is_what_the_row_search_prints_plus_manual_rows`
- `a_new_grid_draft_needs_the_owners_matrix`
- `approving_writes_rows_columns_and_unchecked_cells`
- `a_feature_belongs_to_one_grid_and_a_reference_reads_the_owners_cells`
- `an_edit_to_an_approved_grid_waits_for_the_owner`
- `a_template_change_adds_unchecked_cells_and_retires_removed_columns`
- `discovery_adds_new_rows_marks_missing_and_skips_owned_ids`
- `a_failing_or_bad_row_search_changes_nothing`
- `prove_needs_a_passing_check_budgets_met_and_existing_commits`
- `prove_is_refused_while_the_covered_paths_are_dirty`
- `a_commit_to_covered_code_makes_a_proof_stale_and_a_recheck_freshens_it`
- `a_failed_recheck_reopens_the_cell`
- `percent_counts_fresh_proof_over_live_cells_without_na`
- `a_task_claims_its_cells_and_a_second_claim_is_refused`
- `task_done_needs_proof_or_a_reason_for_every_claimed_cell`
- `cancel_restores_the_cells_it_claimed`
- `na_waits_for_the_owner`
- `an_audit_verdict_from_the_proving_chat_is_refused`
- `audit_verdicts_need_the_owners_audit`
- `the_grid_widget_is_a_valid_block` (media.rs)
- reference parsing: `@matrix`, `@audit slug`, `@grid:` ids, shared cases JSON.

Front end (vitest, `src/workbench/grids/__tests__/`): selection to `@grid:` id
and back; the heatmap draws each state, with stale hatched; New task prefills
the composer; the cell detail shows proof, history and the N/A buttons; the
draft card's Approve and Discard; the list orders and counts; the deep link
`grid=…&cell=…` opens the cell.

E2E (`tests/e2e/`, against a test project with a scratch git repo and a
throwaway grid; never the owner's app on port 3008):

- `a-grid-is-drafted-approved-and-shown.spec.ts`: draft through the HTTP
  route as an agent (row search is a script in the fixture repo), approve on
  the card, see the heatmap at 0%.
- `cells-become-a-task-and-proof-fills-them.spec.ts`: select a column, New
  task, the prefilled composer; create the task with `cells`, prove one cell,
  finish with a reason for the other; the heatmap shows proved and gap; a
  second claim is refused.
- `a-commit-makes-a-proved-cell-stale.spec.ts`: commit to a covered path and
  see the hatched cell and the percent drop; Re-check makes it fresh.
- `a-new-feature-appears-as-a-row.spec.ts`: add a feature file and commit,
  run discover, and the new row appears with empty cells.

## Rollout

1. Server: schema, `grids::apply`, row search, proof and fingerprints, CLI,
   routes, `grids.changed`, unit tests.
2. Task integration: `cells` on create/propose/done/cancel, the grid
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
   grounded, no coupling or duplication), and the first real grid is
   approved from its draft card.

## Criteria map

| id | where |
|---|---|
| model | Data; Cell states; CLI; HTTP |
| templates | Data (`grid_template`); Templates; Drafting (columns) |
| draft | Drafting (`@matrix AREA`); Row search; Front end (draft card) |
| proof | Proof; Covered code and staleness; Cell states |
| na | N/A; Cell states; Front end (cell detail, N/A card) |
| discovery | Row search (Discovery, When it runs) |
| ownership | Principles; Data (ownership index); Drafting refusals; HTTP (reference rows) |
| work | Work on cells; Cell states (claims); Front end (Selection) |
| audit | Audit (`@audit SLUG`); Cell states |
| ui | Front end (Tasks tab switch, Grids list, Grid view, Cell detail panel) |
| corsetta | Rollout, step 5 |
| verified | Tests |
