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

Constraint: on the project screen, no file may spell a chip or a panel out of
utility classes. `src/lib/__tests__/one-set-of-parts.test.ts` reads those files
and fails on one, because drift is invisible one class at a time.

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

The chat list draws every row it is given. Measured on the project with the most
of them — Corsetta, 319 chats, dev build at 1440x900: the first row is on screen
1.7 s after the address is entered, all 319 are there 12 ms later, and pulling
the list end to end in 30 steps costs 474 ms, about 16 ms a step.

So it is not windowed. A list that draws in one paint and scrolls at frame rate
has nothing to gain from it, and windowing costs the sticky day headings and the
browser's own find-on-page. If a project ever arrives where those numbers turn,
that is when it earns the machinery.

## 4. Not built yet

- One chip, one toolbar, one panel and one pill, used by every screen and not
  only the project page (`bw-l3s`).
