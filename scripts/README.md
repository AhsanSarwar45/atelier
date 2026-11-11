# Checks that run something real

Nothing here reads code. The screen checks drive a real browser at the running
server, because the ways this screen has failed could not be seen by any test
that stops at the code: it looked calm and simply showed the wrong thing. The
probes run somebody else's tool and report what it actually did, so a failure
can be pinned on their side or ours in a minute rather than a morning.

Everything here exits non-zero when it fails and prints what it measured either
way.

## Screen checks

They need a screen already serving (`atelier`, 127.0.0.1:3008 by default), a
`google-chrome` on the path, and `websocket-client` in the Python running them.

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
sidecar with its own data and never the one serving the owner's app:

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

And a command carrying a whole file in its arguments, because what a command
printed was cut and what it was asked to do was cut nowhere (bw-1u1.33). Shown
red by removing that cut — "a 60,000-character argument was kept as 60000
characters". The same file reaches the log twice more, as the side-by-side diff
and as the permission card every asking chat writes, and both were uncut
(bw-1u1.40, .42); shown red by removing each — "the same file as a diff was kept
as 60000 characters", "a 60,000-character permission card carried 60000
characters".

A quiet line longer than one line, because its text is cut at two hundred
characters and a row with no body cannot be opened (bw-1u1.39). Shown red by
removing that body — "a 500-character quiet line kept a body of 0 characters,
not 500".

And a mode the tool changed by ITSELF. The chat only said a mode changed when
the change came from its own menu, so approving a plan left the picker claiming
plan with nothing said — the same trap this job exists to close, on the one road
the first fix did not cover (bw-1u1.43). Two rules, because a status carrying
the mode arrives on every single API request: it says so once when the mode
differs, and not at all when it does not. Shown red both ways — "a mode the tool
changed by itself said 0 lines, not 1" and "the same mode arriving again said 1
lines, not 0".

That last one is driven rather than acted out in a browser on purpose: whether
the agent chooses to call `ExitPlanMode` is the model's decision, and a standing
check that depends on it is a check that goes red for no reason. That it really
happens was measured instead, 2026-08-19 — a session pinned to `plan`, one turn
asking for a plan, the card approved: `[tool] ExitPlanMode`, `[pinned] default`,
`Permission mode is now default.`

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

## `fresh-machine.sh`

What a reader actually has to install, proved by running the program on a
computer that has none of it.

Every folder, name ending and fallback in the tool lookup was written from
documentation and read back by nobody: the rest of the checks all run here,
where git, python, node, npm and bd are installed already and on the PATH. So
"the app finds what it needs" was a claim about code that had never been put to
a computer missing any of it (bw-dwxw).

It takes a container holding none of the five and adds them back one at a time
— none, git only, git and the board tool, all of them — and asks the program
itself, with `atelier tools`, what it can see. Each case is asked twice: once
normally, and once with the environment emptied, because a copy the machine
starts at login is handed no PATH at all and that is the case the whole lookup
exists for.

The second case takes python back off after git goes on, because Fedora's git
brings python with it. That is true of that distribution and not of others,
and it is the reason the case is built rather than assumed.

```
bash scripts/fresh-machine.sh
```

Needs docker. `ATELIER_BINARY` checks a binary you already have; `IMAGE`
changes the base, which must carry none of the five and a C library no older
than the one the binary needs.

## Adding to these

A new rule gets a fault injected against it before it is trusted — switch the
fix off, watch the check name that panel or that card, switch it back on. A
check that has never been red is not known to work.

## `measure-quiet.mjs`

Not a check — the measurement behind docs/agent-workbench.md §8.2.5. It drives
the driver through two turns, one running a command and one writing a file, and
tallies every event the chat would store: how many, how many bytes, and how much
of that is the quiet lines nobody reads unless they press Ctrl+O.

It runs in the mode that ASKS and answers each card as it arrives, because that
is the mode every chat starts in and the one the manager is in. The first
version ran the mode that never asks, so no permission card was written during
the whole run and the total it reported was not a total anyone pays
(bw-1u1.44).

Run it again whenever that section's numbers are questioned, rather than
arguing from the shape of the code — the first version of that paragraph priced
the wrong source entirely (bw-1u1.36), and this run is what found that three
quarters of a chat's stored bytes are the menu being republished (bw-7bj).

```
node scripts/measure-quiet.mjs
```

Needs a signed-in `claude` and spends two short turns.

## `chat-typing-cost.mjs`

What one keystroke costs on a long conversation, and a check that it stays
cheap. Typing into the composer redraws the chat around the transcript — the
same redraw an arriving word causes, and the same one the busy clock caused once
a second while an agent worked. On two hundred messages that redraw was the
whole conversation: every message's markdown parsed again, every diff coloured
again. A quarter of a second per character, which is what made a chat feel
broken (bw-uiyz.5).

The conversation is fed to the app's own event stream rather than taken from
whatever chats the machine happens to hold, so the number means the same thing
on any machine and the run needs no agent.

```
node scripts/chat-typing-cost.mjs http://127.0.0.1:3008 200
```

It exits red above 40ms a keystroke. Injected against the fault it was written
for: 268ms a keystroke with the rows drawn inline in the chat, 4ms with each row
remembered against its own item.

## `chat-open-cost.mjs`

Where the wait goes when a chat is opened. Prints how long the conversation
took to arrive, how many rows it holds, how many pieces of screen they cost, and
how long the main thread stayed busy after the bytes landed — so a slow open can
be blamed on the wire, on the fold or on the drawing rather than guessed at.

A chat whose record has been read again republishes its whole transcript behind
a `transcript.reset`, and the reset throws away everything before it. Opening
the longest chat on this machine therefore sent three and three quarter
megabytes across the wire for the forty-two events still on the screen. The
sidecar folds the log itself now and sends the conversation it built
(bw-uiyz.4).

```
BEADS_E2E_URL=http://127.0.0.1:3032 node scripts/chat-open-cost.mjs <sessionId>
```

Against the four longest chats on this machine: 3.77MB arriving in 361ms became
0.09MB in 67ms, and 3.65MB and 1.83MB became 0.11MB and 0.14MB.

## The Files tab's cost — `files-*.mjs`, `files-perf-stack.sh`

Six harnesses that together say where the wait goes when a file is opened.
They were written for the audit in
`docs/files-tab-performance-audit-2026-09-19.md`, and every number in it came
from them. Run them against a BUILT instance of the worktree under test, never
against the owner's app.

`files-perf-stack.sh` starts that instance: the release binary from this
worktree, on a port named by `BEADS_WEB_PORT`, with its own data directory. It
refuses a port somebody else is on.

```
BEADS_WEB_PORT=3411 scripts/files-perf-stack.sh
curl -X POST http://127.0.0.1:3411/api/projects -H 'content-type: application/json' \
  -d '{"name":"perf","path":"<a checkout>"}'
```

`files-server-cost.mjs` times the two calls opening a file makes — one level of
the tree and the text of a file — cold and warm, with the bytes each carries.
It is what showed the server is not the problem: 2 ms for a directory, 7 ms for
a 1.9 MB file.

```
BEADS_E2E_URL=http://127.0.0.1:3411 node scripts/files-server-cost.mjs <checkout>
```

`files-open-cost.mjs` clicks a file in the tree and stops the clock when its
text is on screen, then steps away and back so what the app kept shows up in
the second number. It also counts what an untouched tab costs in calls, and
what coming back to the tab costs. `CPU_SLOWER=6` slows the main thread to
something like an ordinary laptop.

```
BEADS_E2E_URL=http://127.0.0.1:3411 node scripts/files-open-cost.mjs <projectId> <checkout> README.md package-lock.json
```

`files-click-through.mjs` is the one that found the 5.6-second stall: a click
that lands while a read is in the air is dropped, and the file it asked for
waits for the next five-second poll. `SLOW_READ_MS` slows the answers so the
overlap is certain rather than lucky; the third section needs no slowing at all
and uses the tab's own re-read of the open file as the overlap.

```
BEADS_E2E_URL=http://127.0.0.1:3411 SLOW_READ_MS=600 \
  node scripts/files-click-through.mjs <projectId> package-lock.json tsconfig.json components.json
```

`files-reveal-cost.mjs` opens a deep path straight from the address — the shape
of every "open this file" link in the app — and prints the tree calls it took
and the gaps between them. Five serial journeys for a three-deep path.

```
BEADS_E2E_URL=http://127.0.0.1:3411 SLOW_TREE_MS=200 \
  node scripts/files-reveal-cost.mjs <projectId> <checkout>/server/src/routes/fs.rs
```

`files-typing-cost.mjs` times each keystroke in the editor against files of
several sizes. It is what ruled typing out as a size problem.

```
BEADS_E2E_URL=http://127.0.0.1:3411 node scripts/files-typing-cost.mjs <projectId> <file> <file>
```
