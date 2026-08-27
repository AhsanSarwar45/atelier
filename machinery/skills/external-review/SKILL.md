---
name: external-review
description: Run or assess an independent external code review with explicit scope, evidence, bounded execution, and a machine-readable verdict. Use when work needs a second model or process to review changes it did not author.
---

# External review

An external review is an independent verdict, not another implementation pass.
The reviewer must not edit work, update its tracker, or silently broaden scope.

Establish the repository root, immutable base and head commits, acceptance
criteria, project instructions, and test evidence. Evidence is not proof. Inspect
the complete change and surrounding behavior. Report only actionable correctness,
security, data-loss, compatibility, or contract findings supported by exact
evidence and confidence of at least 80/100. Exclude pre-existing defects,
unsupported hypotheticals, formatting taste, and style preferences.

`PASS` means no qualifying finding. `NEEDS_WORK` includes at least one finding.
The runner alone produces `REVIEWER_ERROR` or `TIMEOUT`; silence, malformed
output, tool denial, and unavailable models never pass.

Model, tools, skill preload, and turn limits belong in the personal reviewer
agent. Use one bounded attempt, emit heartbeats, preserve raw and normalized
results, and keep review execution separate from Git and tracker mutations.

Read [references/practices.md](references/practices.md) when creating, changing,
or debugging a review runner.
