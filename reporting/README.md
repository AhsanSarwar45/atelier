# Manager reports

A report is how a result reaches the manager. It is built from a spec, never
written by hand.

This directory is shared by every project. A project keeps no report code and
no report files of its own — it calls the command from here, and its reports
are filed under its own name in `pages/`.

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

Specs are committed here. A report is a running page — same page, same decision
numbers, updated in place for the life of the work.

The manager owns the final result and never the mechanism. Everything below
exists to keep a report readable in seconds by someone who will not open the
code.

## Slots

Six, in this order, and none of them optional:

| # | Slot | Holds |
|---|------|-------|
| 1 | Title | A short noun phrase, six words or fewer. Not a sentence, no explainer after a dash |
| 2 | What I need from you | The questions themselves, each answerable by clicking. Never a pointer to a decision number |
| 3 | Where we are | One "now" line, the very next piece of work, then done / drawn-once / not-started |
| 4 | Content | One card per section. Format is free |
| 5 | Decisions | Every call already made, each overridable by its number |
| 6 | Next | What happens if the manager says nothing, then the steps with a cost each |

A question reaches slot 2 only when the manager's input is genuinely required.
Everything else is decided and listed in slot 5, where a single button flags it
for change.

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
| Only shelf blocks appear | The builder, by name |
| A report is never published | `tools/publish-gate.py` refuses a built page |
| Every gate has teeth | `tools/selftest.py` — 24 faults, each of which must go red |

The gate recognises a page by the builder's hash of its own content, so a
report cannot reach the cloud by being renamed or lightly edited.

## Debt

- The phrasebook is seeded from the terms one project used most; it is not a
  complete list of what a report should not say.
- Charts are static pictures. No hover readouts, no live data.
- The checklist and the status are still typed into the spec by hand, so they
  can disagree with the board. Reading them from the board is the next step.
- Built pages are not yet shown by this project's own screen — the link opens
  the file directly in a browser.
- The gates run on every build, not in this project's own test run — a change
  to the tools is only caught the next time someone makes a report.
