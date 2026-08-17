# Checks that run something real

Nothing here reads code. The screen checks drive a real browser at the running
server, because the ways this screen has failed could not be seen by any test
that stops at the code: it looked calm and simply showed the wrong thing. The
probes run somebody else's tool and report what it actually did, so a failure
can be pinned on their side or ours in a minute rather than a morning.

Everything here exits non-zero when it fails and prints what it measured either
way.

## Screen checks

Both need a screen already serving (`beads-web`, 127.0.0.1:3008 by default), a
`google-chrome` on the path, and `websocket-client` in the Python running them.

## `board-columns-agree.py <project-path>`

Asks `bd` where every card belongs, opens the project screen, reads back which
card each column drew, and names any card in the wrong place.

The rule it encodes, which is the screen's and not `bd`'s: **a job is one card,
put where the pieces directly under it put it** — the manager's ruling, corsetta
`docs/board.md#3a1`. A step is not a card of its own; the goal it belongs to
stands in for it and lists it inside. Nothing below that one level is read, so a
card and the list of pieces printed under it cannot say different things — the
mismatch that made an untouched job read as waiting on a reader. A card the
board itself placed — read, waiting on the manager, closed — keeps that place.

Several sessions work one board at once, so the board is read either side of the
screen and only the cards that sat still across both are compared; it says how
many it left out.

Two more rules ride along with the columns:

- **the heading counts the cards its own column drew**, so a column scrolled
  past its first screenful still says how much is in it
- **the manager's column is the oldest job first**, so nothing waits in it
  quietly while newer work lands on top. That is when each job was opened, not
  how long it has waited on him — corsetta `cor-lxwb`. It needs two cards
  waiting before it can say anything; with fewer,
  `src/lib/__tests__/board-agreement.test.ts` is what holds that rule.

A second rule rides along, because it needs the same loaded screen: **a card's
report is drawn inside the card.** It walks up from every "Manager report" on
the page looking for a card frame around it, so a report parked beside a card
is caught rather than counted as that card's own.

## `panel-drawers-agree.py <project-path>`

Opens each side panel and samples it 120 ms later, while it should still be
moving. Two rules about the drawer itself:

- **every drawer slides** — one already in place at that moment never animated,
  and one still fully off-screen never started
- **no drawer takes more than half the screen** — what is behind it is what the
  reader came back to

Their widths need not match: a drawer holding a document is not the same thing
as a drawer holding a card's details.

Then it opens a card's report, scrolls it to the end, and reads three more rules
about the page the drawer holds:

- **the report is inset from the drawer's edges** — 12 px is the least that
  reads as a margin rather than as the drawer's own wallpaper
- **its contents list is still on screen at the bottom of the page** — the rail
  is only sticky on a wide screen, and a drawer is not one
- **the page never reaches wider than the drawer** — a sideways scrollbar means
  the right-hand column of every table is off the screen

## `chat-wakes-on-send.py`

Holds the rule that a click is a read: after `session.open` the chat is still
dormant and has not moved up the list, and after one message it is awake and has
(the manager's rule, 2026-08-17; docs/designs/app-shell.md §1.9). A browser
cannot see this one — what must not happen is a process starting — so it drives
the sidecar and reads back the session row either side.

It starts a real chat and spends one small turn on it, twice, so it wants a
sidecar with its own data and never the one serving the owner's board:

```
XDG_DATA_HOME=<a copy of ~/.local/share> BEADS_WORKBENCH_PORT=3019 \
  node --experimental-strip-types --disable-warning=ExperimentalWarning \
       --disable-warning=MODULE_TYPELESS_PACKAGE_JSON workbench/src/server.ts &
XDG_DATA_HOME=<the same copy> python3 scripts/chat-wakes-on-send.py
```

## Probes

### `workbench/scripts/probe-claude-resume.ts`

Answers one question the restore list rests on and that we do not own: does the
Claude tool really bring back a conversation the owner began in a terminal? It
starts one outside the app, resumes it by id through the software library
alone, and asks it to repeat a word only the first half could know — no helper
process, no server, no browser. Run it whenever the restore end-to-end test
fails, before reading any of our own code:

```
node --experimental-strip-types --disable-warning=ExperimentalWarning \
     --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
     workbench/scripts/probe-claude-resume.ts
```

It lives beside the helper rather than here because the library it drives is
the helper's dependency, not the app's.

## Adding to these

A new rule gets a fault injected against it before it is trusted — switch the
fix off, watch the check name that panel or that card, switch it back on. A
check that has never been red is not known to work.
