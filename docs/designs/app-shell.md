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

`tab` is which half is mounted, `chat` is the conversation drawn in it, `card` is
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
