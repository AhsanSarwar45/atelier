# A commit you can click, in a Git rail with room for it

Job: bw-g6zy. Written 2026-09-21.

## What is wrong today

The Git rail draws its twenty most recent commits as plain list items. A row is
a `<li>` with a short sha, a subject and an author; it has no click handler, no
role and no keyboard reach. The history is there to be read and nothing more.

The rail is also one single scrolling column. The branch header, the remote
buttons, every change section, the commit composer and the log all share one
scroll. A repository with forty changed files pushes the message box, the
Commit button and the whole log off the bottom of the rail, so the one action
the panel exists for cannot be reached without scrolling past the thing you
were about to describe.

## What we are building

1. The Git tab becomes two panes with a draggable divider.
2. The commits pane gets real search and filters, answered by git itself.
3. A commit row becomes a button, and choosing one draws that commit's details
   and its diff in the diff pane that already exists.

Out of scope: a commit graph, blame, links out to a forge, and staging from
inside a commit's diff.

## Layout

**Top pane, two thirds by default.** The branch header and the fetch/pull/push
row are pinned at the top. Beneath them only the change sections scroll —
conflicted, staged, not staged, untracked — keeping the virtualisation they
already have past fifty rows. The commit composer is pinned to the bottom of
this pane, so the message box and the Commit button are on screen whatever the
file list is doing.

**The divider** is a real drag handle: pointer drag, and arrow keys to nudge
with Home and End collapsing a pane to its header. The fraction is remembered
per repository. Neither pane can be dragged out of existence; each keeps a
minimum height that still shows its header.

**Bottom pane, one third by default.** The search row is pinned at its top and
the commit list scrolls beneath it, asking for more as the end comes into view.

`src/workbench/split-column.tsx` is a new primitive — there is no resizable
component in `src/components/ui` today.

## Search and filtering

One input, taking bare text and GitHub-style qualifiers:

```
fix toast author:ahsan since:"2 weeks ago" path:src/workbench
```

Supported qualifiers: `author:`, `sha:`, `path:`, `since:`, `until:`, `ref:`.
Bare words search the message. A filter popover beside the box offers an author
list, date chips (Today, 7 days, 30 days, custom) and a path field; choosing
one writes the qualifier into the same input, so the text is the only source of
truth and the rail does not grow four rows of controls. Active filters draw
under the box as removable chips with a single clear.

The search is answered by git, not by filtering what has already been read, so
it reaches the whole history. `sha:` resolves a prefix. A bare query that is
itself a hex prefix is tried as a sha as well as as message text, so pasting a
sha just finds it.

Every value reaches git as its own argument; nothing is ever assembled into a
shell string. A `path:` that climbs out of the repository is refused.

Parsing and formatting live in `src/workbench/commit-query.ts`, pure and unit
tested, apart from the widget that uses them.

## Clicking a commit

The row becomes a button with a visible selected state. Up and down move the
selection, Enter opens, Escape returns to the working tree.

The diff pane gains a source: the working tree, as today, or one commit. A
"Working tree" control returns. Everything else about the pane is unchanged —
`GitDiffView`, `DiffTable`, the colouring, the virtualisation and the
focus-and-scroll plumbing are reused rather than duplicated.

### The header above the diff

Three quiet lines, not a data dump:

- The subject, full width, with the branch and tag badges this commit carries.
- Author, relative date with the absolute one on hover, the short sha which
  copies the full one when pressed, and a merge badge when the commit has two
  parents. A committer line appears only when the committer differs from the
  author — the rebase and cherry-pick case, and invisible otherwise.
- The changed-file count and the added and removed line counts, with a stat bar.

The message body follows, keeping its paragraphs, clamped to three lines behind
a "more" toggle. Parent shas are buttons, so history can be walked backwards.

A merge commit is diffed against its first parent and says so. A root commit is
diffed against the empty tree.

## Server

`server/src/routes/git.rs`:

- `GET /api/git/log` gains `skip`, `grep`, `author`, `since`, `until`, `sha`
  and `file`. Each commit gains `parents` and `refs`; the refs draw the badges.
- `GET /api/git/show?path=…&sha=…` is new and returns the commit's metadata —
  body, committer, parents, refs — together with its files in the shape the
  browser already draws. `read_unified_patch` is reused unchanged; it parses
  any unified patch and does not care that this one came from `git show`.

## Browser API

`src/lib/api.ts` gains `GitCommitDetail`, `GitShowResponse` and `git.show`.
`git.log` takes an options object carrying the filters and the offset; its one
caller and the test mocks move with it.

## Files

The log block inlined in `git-view.tsx` moves out. `git-view.tsx` is over
fifteen hundred lines already, and that is the main reason this feature is
awkward to add there.

- `src/workbench/split-column.tsx` — the divider.
- `src/workbench/commit-query.ts` — qualifier parsing and formatting.
- `src/workbench/commit-search.tsx` — the input, the popover and the chips.
- `src/workbench/commit-log.tsx` — the commits pane.
- `src/workbench/commit-details.tsx` — the header above a commit's diff.

## How it is proven

- Rust tests for the new log filters and for `show`, including a merge commit,
  a root commit and a binary file.
- Unit tests for the query parser, including quoted values and a stray colon.
- Component tests for the row click, the keyboard moves, and the divider
  remembering where it was left.
- The running app driven in a browser, with screenshots showing the commit box
  still on screen under a long file list, a filtered commits pane, and a
  commit's details and diff open. A passing test is not the proof here.
