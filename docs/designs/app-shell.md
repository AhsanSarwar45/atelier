# The app shell

The window is two bars and one box of work. Card: `bw-9is`.

## 1. What the shell is

### 1.1 Two bars, then the work

1. **The project bar** — back, the project's name, its menu, and on the right
   what follows the owner everywhere: the strip of chats running now and the
   tray of chats waiting on him. It is the same on every tab, so it is drawn
   once, above the tabs.
2. **The tab bar** — the tab selector, and beside it a slot the open tab fills
   with its own tools.

Both carry `data-shell-bar`. The acceptance suite counts them: a third bar
cannot appear by accident, only by declaring itself.

The shell is exactly the height of the window and clips. Nothing above the work
can be scrolled away, because the document has no scroll to give.

### 1.2 What is allowed to scroll

Four places: the row of board columns (sideways), each column (down), the chat
list, and the conversation.

The constraint a reader could break: every flex ancestor between one of those
panes and the shell needs `min-h-0`. A flex child's default minimum height is
its content, so one missing `min-h-0` anywhere in the chain and the pane never
clips — the scroll silently lands on the document and carries the bars off the
top of the screen.

### 1.3 The tab fills the bar from where it stands

`TabTools` is a portal into the second bar, used inside the tab's own tree,
rather than a prop passed down from the page that draws the bar. The board's
filter row holds eleven controls and all of their state; lifting the controls
would drag that state with them for no gain.

Constraint: the board stays mounted behind the chat so its cards are not
fetched twice, so a tab's tools must be tied to which tab is *showing*, not to
whether the tab is mounted.

### 1.4 One set of parts

The manager's rule, 2026-08-16: the screen uses components defined in one place
rather than each piece redrawing them. A chip and its round form the pill are
one part (`Badge`); a boxed piece of content is another (`Panel`); a row of
controls is a third (`Toolbar`).

Constraint: no file under `src/` may spell a chip or a panel out of utility
classes, in markup or in CSS. `src/lib/__tests__/one-set-of-parts.test.ts` reads
them and fails on one, because drift is invisible one class at a time.

### 1.5 Where a colour is spelled

Constraint: a part names a colour only through the theme variables in
`src/app/themes.css`. A hue belonging to the data rather than the theme enters
as a number and is mixed against the live theme; a finished colour inside a
component is a defect.

External reality: the kit these parts came from is written for Tailwind v4,
whose colour names do not exist on the v3 this app builds with, and resolve to
nothing rather than to an error (bw-ccm).

### 1.6 Only the tab in front is mounted

Constraint: a tab that is not showing is not mounted, and a list that can outrun
a screenful draws a screenful and grows as it is pulled. Day headings survive
that because a group is cut from rows already drawn. Held by
`tests/e2e/chat-shell.spec.ts`; the numbers behind it are in §3.

### 1.7 The address is the state (bw-m8o)

Constraint: everything a reader could arrive at is in the address, and every
move he makes by hand is pushed onto the history. One shape, on one route:

```
/project?id=<project>&tab=chat|board&chat=<sessionId>&card=<cardId>
```

`tab` is which part is mounted, `chat` is the conversation drawn in it, and `card` is
the card panel over the top of either. Nothing that a link could carry is held in
a component's own state: a screen that keeps its own copy answers the address on
the first paint and then quietly disagrees with it, which is what made Back do
nothing and made an open chat unlinkable.

Pushed, not replaced: `router.replace` leaves no history entry, so Back stepped
straight out of the app. A tab switch, an opened chat and an opened card are all
pushes; only spending a one-shot parameter is a replace.

External reality: this app ships as a static export embedded in the binary
(`next.config.js` `output: 'export'`), so a path segment holding an id that only
exists at runtime — `/project/<id>/chat/<sid>` — cannot be pre-rendered, and a
cold open of such a link is a 404 until the Rust server learns to serve the shell
for unknown paths. Search parameters need no such fallback and carry the same
three effects: a link that opens the same thing, a Back that goes back, and a
state a second window agrees with. Prettier paths are their own job.

`?bead=<id>` is still read, as the old spelling of `card`, so links already
pasted into cards and chats keep working.

### 1.8 One card panel, over whatever is showing

Constraint: a card opens where the reader already is. The panel is mounted by the
project screen, not by the board, and it is driven by `card` in the address —
so a chip on a chat's line, a chip on a chat's row, and a card on the board all
open the same panel over the tab that is showing. Closing it goes back.

The panel reads the board's list itself and is mounted only while a card is open,
which keeps the chat tab free of the board's cost (§1.6) — the price is one extra
read of the card list while a card is open on the board tab.

### 1.9 Opening a chat is a read

Constraint: clicking a chat draws what was said and starts nothing. The agent is
woken by the first message sent to it, and by nothing else — the manager's rule,
2026-08-17: "clicking just opens it. it only resumes when we send another
message."

Two consequences in the sidecar. A chat is opened with `session.open`, which
gives a conversation begun in a terminal an id and reads its past into the event
log without attaching a driver. And `prompt.send` to a chat with no driver
attached wakes it first and then sends, so a link into a sleeping chat is a
working chat the moment he types.

A row must not move for being read: `last_active_at` is stamped by every
`updateSession`, so opening may write nothing to the session row. That stamp is
what sent a clicked chat to the top of the list.

### 1.10 Images and comparisons stay in chat (bw-pc1z)

Constraint: agent-produced images are part of the conversation, not a reason to
leave it. Ordinary images draw inline and open at full size. A before-and-after
pair is written as a compact `atelier-image-compare` block naming two files
inside the project and a `side_by_side` or `wipe` mode. The sidecar validates
and materializes both files; the browser replaces the block with the native
comparison widget. Paths outside the project are refused.

Questions use the provider's native question card. There is no Reports tab,
report page, report API, waiting badge, or separate report-delivery workflow.

### 1.11 A chat draws only the kinds asked for (bw-qdim)

Constraint: a busy chat is mostly the agent's own working — files read, commands
run, quiet notes about itself — and what it SAID is a handful of rows buried in
it. The chat's toolbar carries one control over all of it, opening a tree of
switches: you and the agent at the top; the agent's replies, thinking, commands,
status lines and questions beneath it; under commands one entry for
every tool this conversation actually used, and under status lines one for every
family of machine line it holds (bw-jkh2.14).

Four rules make the tree behave the way a reader expects rather than the way a
set of checkboxes does.

**What is remembered is what he switched OFF** (`workbench.chat-filter`). A
switch nobody has touched is on, so a tool used here for the first time — and a
kind the chat grows next month — arrives visible rather than silently missing
from a conversation he thought he was reading whole. It is remembered for the
browser, not for one chat.

**A group off is one entry, and forgets what was off inside it**, so turning it
back on hands him all of it rather than whatever remained of it last time. The
cost is that a switch inside a group that is off has nothing of its own to
remove, and clicking it would do nothing at all — so flipping one on opens each
group above it and switches that group's other children off individually,
leaving the one he asked for standing and the group reading half-on (bw-qdim.9).
That is why flipping a switch needs the whole tree and not just the switch.

**A command run inside another command goes with its parent.** Hiding the row
that sent a subagent off while leaving the work it spawned standing loose would
read as the agent doing that work itself. The count beside a switch counts those
rows too, because the screen draws them too — a check that counted only the rows
at the top compared its number against a different set and came apart on any
chat that dispatched a subagent (bw-qdim.12).

**Every line carries its count for THIS conversation**, zero included: it is what
lets him see the cost of turning something off before he turns it off, and what
tells him a group is empty here without opening it. So the count is taken over
the rows as the page DRAWS them: a folded run of eight retries is one chip with
an 8 on it and counts once, because one row is what turning it off would remove.
There was once a second control holding the quiet lines back, and the count was
taken over what it let through — so a chat carrying thirty-three status lines
reported none and the panel said there was nothing there (bw-qdim.10,
bw-jkh2.13). Switching everything off leaves
the window empty, which is indistinguishable from a broken chat, so the
conversation says which it is and offers one click back (bw-qdim.6).

Two things the panel has to look like. The toolbar button goes loud the moment
anything is off, because a reader who has forgotten he filtered a conversation is
reading one with holes in it and no way of knowing (bw-qdim.5). And a switch that
is off draws its empty box in the edge the app gives a box you type into: the
fainter edge is a shade off the panel behind it, which on a dark theme is no box
at all, and a switch nobody can see is a switch nobody knows they can turn back
on (bw-qdim.11).

Held by `tests/e2e/chat-filter.spec.ts` against a real past conversation on the
reader's own instance, and by `src/workbench/__tests__/`.

## 2. Deliberate drops

- The app-wide bar is gone. Its four pieces moved: the tray and the live strip
  into the project bar, "Search chats" and "What it cost" into the chat tab's
  tools — the manager's own description of the two bars, 2026-08-16.
- The chat tab used to subtract a hardcoded bar height from the window height.
  A measurement of the chrome, held in a place that could not see the chrome,
  is wrong the moment a bar changes; the shell hands the tab its height instead.
- The terminal theme's header printed `N beads // N epics // N blocked`.
  Dropped: every column already counts what it drew, so the totals restated the
  board back to itself.

## 3. Measured, so it is not guessed at

Measured on the project with the most of both — Corsetta, 320 chats and 411
cards, installed build at 1600x1000, 2026-08-16 (bw-ccm.3):

| | |
|---|---|
| Click Chat, first chat row | 10.8 s |
| Land on Chat directly, first chat row | 1.2 s |
| Click Board again | 10.4 s |
| Click Chat a second time | 0.3 s |
| The sidecar answering with all 320 chats | 0.15 s |
| Four of those answers at once | under 1 ms each |

The wait is drawing, not answering: the same list costs 1.2 s alone and 10.8 s
with the board alive behind it. An earlier reading of 1.7 s for the list on its
own (bw-9is.4) was taken with the board absent and is not a reading of this
screen; the ruling it carried — a long list left undivided — is reversed by the
table above.

## 4. Not built yet

- Nothing tells a chat's row that the chat has begun touching a new card until
  the row is opened; a row shows the cards already known for it (`bw-ccm.7`).
- A conversation read back from its record never draws an indented subagent row:
  the parent a command was run under reaches the screen on the live event stream
  and is not in what the sidecar restores. So the rule that a subagent's commands
  go with the row that sent them off is exercised by the unit suite only, and the
  browser check has no conversation on this machine that can exercise it
  (`bw-qdim.12`).
- The filter's edit to the chat screen was kept to a button and one call because
  another job is rewriting that same row loop (`bw-uiyz.5`); the two meet there.
