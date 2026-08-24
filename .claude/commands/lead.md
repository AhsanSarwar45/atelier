---
description: Start a piece of work under the Fable lead. It plans and reports, and hands every code change to an Opus builder
argument-hint: "<what you want done>"
allowed-tools: Agent
---

# lead — hand this piece of work to the Fable lead

Call the `Agent` tool once, with `subagent_type: "lead"`, and pass it
`$ARGUMENTS` as the work to run, together with anything from this conversation
it needs and cannot see: what the manager has already ruled on, in their own
words, and any card, file or constraint already in play. It has no memory of this
session.

Do not do any of the work yourself, do not pre-plan it, and do not pour a card
for it. That is the lead's job.

The call returns as soon as the lead launches, carrying no answer. Wait for its
result, then pass its reply through to the manager unchanged apart from
trimming: the outcome first, and the report link last.
