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

## `board-counts-agree.py <project-path>`

Asks `bd` what each job holds, opens the project screen, and reads the fraction,
the percentage and the dropped note off every job card.

The rule it encodes: **dropped work is not part of a job** — the manager's
ruling, 2026-08-17. A job of sixteen pieces with five dropped is a job of
eleven; it reads 11/11 and 100% once those eleven are done, and says "5 dropped"
beside them. Counting the dropped ones in the total is what left a job with
nothing left to do sitting at 69% with the sign-off button withheld, and no test
that stops at the code could see it: the screen looked calm and drew the wrong
number.

Two rules ride along, because they are the same disagreement one step further
out:

- **the percentage is the fraction it is drawn beside**, not some other reading
  of the same job
- **the list of pieces says the same two numbers the count above it does**, so a
  bar counting eleven never sits over a list of sixteen

`--count-dropped` puts the old rule back on the check's side, which is how it is
shown to bite: against a screen that is right it must name every job that
dropped anything. It also fails when no job on the board has dropped work, since
then it compared nothing.

The numbers come off the progress bar's own label and the block around it, never
off the card's whole text — a job whose title says "reads 100% on the board"
would otherwise be measured against its own description.

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

## `chat-shows-its-work.mjs`

Holds the rule that a working chat says so: it opens a chat, sends one real
prompt, and samples the screen every second. It fails when any second of a busy
turn has nothing at the foot of the transcript, and when a turn that thought said
nothing about it — neither the thinking itself nor, when the brand withholds the
words, how much of it there has been (docs/agent-workbench.md §8.2.2).

Wants a screen serving the checkout under test and an instance with its own data:

```
NEXT_PUBLIC_BACKEND_URL=http://127.0.0.1:3018 npx next dev -p 3017
BEADS_E2E_URL=http://127.0.0.1:3017 BEADS_E2E_BACKEND=http://127.0.0.1:3018 \
  node scripts/chat-shows-its-work.mjs
```

`SHOT=<path>` saves a picture of the first working second; `ASK=` replaces the
prompt. It spends one small turn.

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

## `chat-draws-every-message.mjs`

Holds the rule that nothing the agent kit sends is dropped. It drives **the
driver** — the class the app runs — and reads back what it drew. Two halves: a
real chat, one short turn and then `/compact`, so the answer the manager never
got has to arrive and arrive once; and a message of a kind this app has never
heard of, handed straight to the driver, because that is the whole rule — no
list of kinds it is willing to hear.

The first version of this check asked the driver's two exported tables whether a
kind had a name, which is a question they answer whether or not any code is left
that draws one: deleting the message loop's catch-all arm left it green
(bw-1u1.28). Shown red by deleting that arm — "a kind the driver has no branch
for was dropped".

It also hands the driver a message the kit wrote ITSELF, with no stream behind
it and its words only in `message.content` — the arm that drew nothing at all
before this job. The live half cannot guard that one: the same sentence arrives
as a status first, and the second copy is deliberately not drawn twice
(bw-1u1.35). Shown red by switching that arm off — "a message with no stream
behind it drew 0 lines, not 1".

```
node scripts/chat-draws-every-message.mjs
```

Needs a signed-in `claude` and spends one short turn.

## `chat-takes-every-mode.mjs`

Holds the rule that every permission mode the picker offers can actually be
taken, and that a mode which changes says so in the chat. Bypass came back as a
500 the first time the manager picked it, because the session had not been
launched with permission to switch.

It drives **the driver**, not the kit: a copy of the launch options inside the
check would pass with its own flag set while the app's own session was refused,
which is the fault it exists for. Shown red by removing that one line —
"bypassPermissions: REFUSED".

It also picks one mode twice in a row and requires two lines for it. The rule
that stops the chat saying one thing twice cannot tell a repeated sentence from
a repeated decision, and used to swallow the second (bw-1u1.32); shown red by
putting that back — "said so 1 time(s)".

```
node scripts/chat-takes-every-mode.mjs
```

Starts a session and sends no turn to it.

## `shoot-chat-everything.mjs`

Not a check — the one picture the chat work is judged on, and both halves of the
claim are in it: a command opened onto what it ran and what it printed, and the
line the compact answer gave. It was two pictures, and the named one carried
half (bw-1u1.29); it now refuses to save anything unless the command row really
is open onto its output.

```
BEADS_E2E_URL=http://127.0.0.1:3017 BEADS_E2E_BACKEND=http://127.0.0.1:3018 \
  node scripts/shoot-chat-everything.mjs tests/results/chat-shows-everything.png
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

## `measure-quiet.mjs`

Not a check — the measurement behind docs/agent-workbench.md §8.2.5. It drives
the driver through two turns, each running one command, and tallies every event
the chat would store: how many, how many bytes, and how much of that is the
quiet lines nobody reads unless they press Ctrl+O.

Run it again whenever that section's numbers are questioned, rather than
arguing from the shape of the code — the first version of that paragraph priced
the wrong source entirely (bw-1u1.36), and this run is what found that four
fifths of a chat's stored bytes are the menu being republished (bw-7bj).

```
node scripts/measure-quiet.mjs
```

Needs a signed-in `claude` and spends two short turns.
