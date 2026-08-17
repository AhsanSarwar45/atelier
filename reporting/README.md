# Manager reports

A report is how a result reaches the manager. It is built from a spec, never
written by hand.

## When one is owed

Two triggers, and nothing else:

1. **A piece of work on the board finished** — a task, a subtask or a step
   ticked off. The page is brought up to date as part of closing it.
2. **A question for the manager** — any question, approval or choice between
   two ways. It goes in the page's own slot for it, with what each answer
   costs, before it is put to him.

Turns spent building, reading, searching or answering him owe nothing. Neither
does bookkeeping. Helpers an agent sends off owe nothing either: they answer to
the agent that sent them, and that agent owes the page.

Where a project's machinery can refuse, neither is a judgement call: closing a
card is refused while its page is behind the work, and asking anything is
refused until the page carrying it exists.

The tools here ship inside the product: making a report is one of the things it
is for, and the app carries this toolchain and lays it down the first time it
runs. A project keeps no report code of its own — it calls the command, which
every project shares.

**Reports themselves are never in a repository.** They are one person's own
work about their own projects, so they live where the computer keeps a
program's data, filed under the project's name: `<data>/reports/<project>/`.
That name is the project's main checkout, so a job done in a worktree still
files under the project rather than under the branch the worktree is named
after, which is deleted when the job lands.

```
report new <slug>                 # start a spec for the project you are in
report <slug>                     # build it; prints the link to hand over
report open <slug>                # build it and open it in the browser
report list                       # every spec, newest first
report check                      # the gates, on their own
```

A report is **never published anywhere**. The build prints a link to the file
it wrote, and that link is the whole delivery; `tools/publish-gate.py` refuses
a built page handed to the Artifact tool.

**The link goes last in the message that hands it over** — the manager's
standing instruction, so the thing they click is where their eye already is and
they never scroll back up for it. Nothing follows it: no recap, no next steps,
no sign-off.

`report` is on the path as a link to `bin/report`. The project a report is
about is the directory the command was run from: the pictures a spec names are
resolved there first, so a spec kept here can point at a render that lives in
the project.

Every build runs the gates first, so a broken rule costs the next report rather
than waiting for someone to run the checks by hand.

## Wiring a project to it

Three things, and none of them is report code:

1. A skill that tells an agent to use `report` and where the specs are —
   corsetta's is `.claude/skills/report/SKILL.md`.
2. The publish gate on the Artifact tool, pointed at `tools/publish-gate.py`,
   so a report cannot be pushed to the cloud instead of handed over.
3. A check that report machinery has not been copied back in — corsetta's is
   `crates/corsetta-core/tests/checks/reports_live_elsewhere.rs`.

## This project is a fork

Forked from `weselow/beads-web` at `c459cf3` (v0.12.2), branch `ours`, upstream
kept as the `upstream` remote. Everything of ours is under `reporting/`; taking
their updates is a merge that should not touch it.

A report is a running page — same page, same decision numbers, updated in place
for the life of the work. Nothing about it is committed anywhere: a spec and
its built page both sit in the data folder, which is what keeps one person's
projects out of something the whole team installs.

The manager owns the final result and never the mechanism. Everything below
exists to keep a report readable in seconds by someone who will not open the
code.

## Slots

Six, in this order, and none of them optional:

| # | Slot | Holds |
|---|------|-------|
| 1 | Title | A short noun phrase, six words or fewer. Not a sentence, no explainer after a dash |
| 2 | What I need from you | The questions themselves, each answerable by clicking. Never a pointer to a decision number |
| 3 | Where we are | Read from the board — see below |
| 4 | Content | One card per section. Format is free |
| 5 | Decisions | Every call already made, each overridable by its number |
| 6 | Next | What happens if the manager says nothing, then the steps with a cost each |

A question reaches slot 2 only when the manager's input is genuinely required.
Everything else is decided and listed in slot 5, where a single button flags it
for change.

### Where we are, read from the board

`"status": {"card": "<id>"}` and nothing else. The children of that card become
the checklist — closed is a tick, claimed or part-finished is the half tick,
the rest are empty — and the now line is the first of those under way. A spec
that names a card and also types a status is refused: the board owns them or
none of them.

**Next-up is the exception, and comes from the plan** — the step slot 6 marks
as `starting`, or its first step. The list can only ever name a stage, and it
reads as nothing-started whenever an agent is behind on ticking rows off; what
happens next is the agent's to say. Manager's ruling, 2026-08-13. With no plan
step left, the line falls back to the list; with every row ticked, the list's
own last word stands, because a plan step under a full set of ticks reads as
work still to come.

**So the starting step is the first thing the manager reads.** Write it as an
effect he can judge, never as housekeeping — the words for that are in the
phrasebook and the builder flags them here like anywhere else.

Only the card's direct children reach the page. Their own steps are internal.

**The list is in the order the job runs**, never sorted by state: when the card
was made, then its own number. Ticks fall where the work fell. Grouping the
finished ones at the top reads as two lists running in opposite directions,
which is what a checklist must never be.

A row is named by the step it belongs to when exactly one child wears that
step, because a step's own title only repeats the goal's. When several children
share a step — they are the job's work, and that is the normal shape — each is
named by its own title instead, or the page would print one word many times.

**So a card's title is manager-facing.** It reaches the page unedited and is
held to the same phrasebook as everything else; a title written in our own
words costs the report a plain-words warning, naming the card.

Typing the status by hand still works for a report with no card behind it, and
then it is only as true as whoever typed it.

### Decision numbers

A number is permanent. Once published, an id is never withdrawn, never reused,
and never quietly given a different meaning — the manager may have answered it
in chat a week earlier. Changing what a decision says requires marking it
revised; the builder compares against the committed spec and refuses otherwise.

## Content

### Shelf

The blocks a report may contain live in `tools/blocks.py`. Anything else is
refused by name. A graphic nobody has built yet gets **added to the shelf**,
never hand-written into one page — that is what stops the look forking. New
shapes are free; a new colour or typeface is not, and comes to the manager as a
question, asked once.

### Jargon

A noun on a report must be something the manager can see, click, buy or feel. A
word that only exists inside the code is flagged, along with the shapes code
leaves behind: file paths, run-together names, call syntax, shouted initials.

This one **warns rather than blocks** — the manager's call, so an unfamiliar
term never costs a report. The build names every hit and what to say instead;
the count rides along in the line the agent reports back.

`tools/phrasebook.json` carries both halves — the banned term and what to say
instead. It grows: a term that leaks into a report and gets caught in review
belongs in the phrasebook the same day.

The one escape is a **gloss**: up to six terms per page may appear if the page
explains each inline. Past six, the page is written for the wrong reader.

## What is enforced, and where

| Rule | Enforced by |
|------|-------------|
| Slot order, completeness, one recommended answer per question | The builder refuses to emit a page |
| Decision numbers never move | The builder, against the committed spec |
| No markup, colours or sizes in content | The builder refuses to emit a page |
| Plain words | The builder warns, naming each term and its replacement |
| A status is the board's or the spec's, never both | The builder refuses to emit a page |
| Only shelf blocks appear | The builder, by name |
| A report is never published | `tools/publish-gate.py` refuses a built page |
| Every gate has teeth | `tools/selftest.py` — one fault per rule, each of which must go red |

The gate recognises a page by the builder's hash of its own content, so a
report cannot reach the cloud by being renamed or lightly edited.

## Debt

- The phrasebook is seeded from the terms one project used most; it is not a
  complete list of what a report should not say.
- Charts are static pictures. No hover readouts, no live data.
- Built pages are not yet shown by this project's own screen — the link opens
  the file directly in a browser.
- The gates run on every build, not in this project's own test run — a change
  to the tools is only caught the next time someone makes a report.
