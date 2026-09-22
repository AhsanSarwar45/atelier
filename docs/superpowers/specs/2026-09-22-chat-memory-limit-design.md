# A memory limit for chats

## The problem

A chat can run away with memory. Its adapter, its provider, its subagents and
every shell it spawns all descend from the server, and nothing stops the total
from growing until the machine is in trouble. The memory badge already shows
the number; nobody acts on it.

## What this adds

One setting: a memory limit in GB, unset by default. While it is unset nothing
changes. While it is set, a chat that measures above the limit on two
consecutive samples is stopped, then handed a message naming what it spent and
asking it not to do that again. Delivering that message relaunches the chat by
the path a person's own message already takes to a sleeping chat.

## What it measures

`server/src/workbench/memory.rs` already reports, per chat, the proportional
set size plus swap of every process the chat owns — its adapter, its provider
and everything below them. That per-chat total is the number the limit is
compared against. Nothing new is measured.

## The guard

`server/src/workbench/memory_limit.rs` runs one task, started at boot beside
the push watcher. Every three seconds it:

1. Reads the limit. Unset means forget every strike and do nothing.
2. Asks `memory::report` for the current per-chat totals.
3. Gives a chat over the limit a strike; clears the strike of every chat at or
   under it. A chat gone from the report loses its strike too.
4. On the second consecutive strike, enforces.

Two samples rather than one so a command that briefly balloons and exits does
not cost the chat its life. Three seconds is the cadence the badge already
polls at, so the limit reacts about as fast as the number a person can see.

## Enforcing

For the offending chat, in order:

1. Take the invoice: the chat's total, and the largest processes under it.
2. `session.close` through the registry, which removes the driver and tears
   down the adapter's process group — provider, subagents and shells with it.
3. Append a `notice` to the transcript, so the person reading it later sees
   why the chat stopped.
4. Send the invoice into the chat as a message. The chat has no driver, so the
   existing dormant branch of `prompt.send` launches a fresh one and delivers
   it. The agent's first sight of its new process is the bill for its old one.

After enforcing, that chat is left alone for sixty seconds. A relaunched chat
needs time to settle, and killing it again on the two samples that follow its
own restart would be a loop rather than a limit.

## The setting

Key `workbench.memory.limit-gb` in the `settings` table, alongside the search
and update settings. `GET`/`PUT /api/settings/memory` carries
`{ "limitGb": number | null }`. A stored limit must be between 0.5 and 512 GB;
null clears it. The screen draws one numeric field in the Chats section.

## Not in this

No per-chat override, no warning before the kill, no second setting for how
long a chat may stay over. One number, one behaviour.
