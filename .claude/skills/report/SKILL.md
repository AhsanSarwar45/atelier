---
name: report
description: Build and publish the manager report page for a result — write the spec, run the builder, publish what it emits. Use for every non-trivial result; the chat message is one line plus the link.
---

# Report — fill a page, never write one

**When a page is owed**, along with the two triggers and what is exempt, is written in
the shared report tools' own README, "When one is owed", and nowhere else.
`report` is on your path and the tools sit beside it (`dirname $(readlink -f
$(which report))/..`), so the README is always one hop away.
Both triggers are refused without a page: `bd close` while the page is behind
the work, and any question until it exists.

You supply words, numbers and pictures. The builder supplies the page. Slot
order, look and interaction are not yours to choose, and publishing a
hand-written page is blocked.

Reports do not belong to any one project. The tools, the rules and every spec
live in the shared report home, and nothing about a report is ever copied back
into a project's own repository.

## Steps

1. **Find the running spec** for this piece of work: `report list`. One spec per
   piece of work, updated in place. A new spec means new work.
   Starting fresh: `report new <slug>` from this repo.
2. **Edit the spec.** Format and rules: the shared README above. Pictures go in
   as a `path`, which is
   resolved against this repo first, so point at a picture where it already
   lives.
3. **Build**, from this repo so its pictures resolve: `report <slug>`.
   A refusal names the rule and the fix. Fix the spec, never the builder's
   output.
4. **Reply in chat**: one line saying the result, then the link the build
   printed, **last in the message**, with nothing after it. A report is never
   published anywhere; the Artifact tool refuses one.

## While writing the spec

The rules are in the doc above. These are the calls it cannot make for you.

- **Show, don't describe.** A before/after goes in a `compare` block, a
  measurement in a table or a chart. One short sentence is a block. A
  paragraph is refused.
- **Point the status at the card**, `"status": {"card": "<id>"}`. The
  checklist is then the board's answer, never yours. A report with no card
  behind it types its own checklist, which is only as true as you are.
- **The plan's starting step is the headline the manager reads first.** It is
  lifted to the next-up line (README, "Next-up is the exception"), so write it
  as an effect they can judge, never as housekeeping.
- **Need a graphic that does not exist?** Add it to the shelf in
  the shared shelf of blocks. Never style one page by hand.
- **Prove a rule you add.** A new gate gets a case in
  the report tools' own suite that goes red without it.
