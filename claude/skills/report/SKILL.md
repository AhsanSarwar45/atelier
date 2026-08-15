---
name: report
description: Build and publish the manager report page for a result — write the spec, run the builder, publish what it emits. Use for every non-trivial result; the chat message is one line plus the link.
---

# Report — fill a page, never write one

**When a page is owed** — the two triggers and what is exempt — is written in
`~/dev/beads-web/reporting/README.md`, "When one is owed", and nowhere else.
Both triggers are refused without a page: `bd close` while the page is behind
the work, and any question until it exists.

You supply words, numbers and pictures. The builder supplies the page. Slot
order, look and interaction are not yours to choose, and publishing a
hand-written page is blocked.

Reports do not belong to this project. The tools, the rules and every spec live
in `~/dev/beads-web/reporting/`, shared by every project; `report` is on the
path. Nothing about a report is ever copied back into this repo.

## Steps

1. **Find the running spec** for this piece of work: `report list`. One spec per
   piece of work, updated in place; a new spec means new work.
   Starting fresh: `report new <slug>` from this repo.
2. **Edit the spec.** Format and rules:
   `~/dev/beads-web/reporting/README.md`. Pictures go in as a `path`; it is
   resolved against this repo first, so point at a picture where it already
   lives.
3. **Build**, from this repo so its pictures resolve: `report <slug>`.
   A refusal names the rule and the fix — fix the spec, never the builder's
   output.
4. **Reply in chat**: one line — the result — and then the link the build
   printed, **last in the message**, with nothing after it. A report is never
   published anywhere; the Artifact tool refuses one.

## While writing the spec

The rules are in the doc above; these are the calls it cannot make for you.

- **Show, don't describe.** A before/after goes in a `compare` block, a
  measurement in a table or a chart. One short sentence is a block; a
  paragraph is refused.
- **Point the status at the card**, `"status": {"card": "<id>"}` — the
  checklist is then the board's answer, never yours. Only a report with no card
  behind it types its own, and it is then only as true as you are.
- **The plan's starting step is the headline the manager reads first** — it is
  lifted to the next-up line (README, "Next-up is the exception"), so write it
  as an effect he can judge, never as housekeeping.
- **Need a graphic that does not exist?** Add it to the shelf in
  `~/dev/beads-web/reporting/tools/blocks.py` — never style one page by hand.
- **Prove a rule you add.** A new gate gets a case in
  `~/dev/beads-web/reporting/tools/selftest.py` that goes red without it.
