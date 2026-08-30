# One library

Every control on every screen comes from `src/components/ui`. Card: `bw-dks8`.

## 1. The rule

A screen chooses **which** component it needs. It never chooses what that
component looks like. Buttons, pickers, panels, card faces, rows and dimmed
backdrops are the library's; a screen that paints its own is a second library
with one user.

This was already the house rule and was already broken. The board grew up in
another repository and painted most of its own: its card panel hand-built an
overlay, a slide, an Escape key and three plain dropdowns while the create-card
dialog two files away used the library's for the same fields; the work card and
the epic card painted their own surface in three layouts each; the filter row
hand-coded selected and unselected boxed buttons the library's tab strip
already draws. The settings screen had four hand-rolled boxes of the same kind.
Nothing about any of it failed: it rendered, it clicked, it just looked wrong
beside the rest of the app — which is exactly why it needed a check rather than
a rule.

## 2. What the library owns

- **`Button`** — anything the reader presses that is shaped like a lozenge.
  Variants say what it means (primary, destructive, ghost, dashed…), never how
  it looks; `mode="icon"` and `radius="full"` cover the round ones.
- **`Row`** — a line in a list that can be clicked: a search hit, a chat in a
  tray, a command in a menu. A `Button` centres its label and refuses to wrap
  it, so five screens had each grown their own full-width, left-aligned,
  hover-lit row and no two agreed on the padding or the colour they lit up.
  `ruled` draws the hairline between rows; `selected` marks the row the
  keyboard is on, which is a different thing from the one the mouse is over.
- **`Panel`** — a boxed piece of content: card, tray, inline panel. `tone` is
  what the box means. `frame` is a border and nothing else, for a box whose
  contents paint themselves — a fill behind a table of coloured rows flattens
  the difference between them.
- **`Dialog`** — every window that sits above the page, `shape="box"` or
  `shape="screen"`.
- **`Overlay`** — the shell a full-page panel wears: where it sits, and the dim
  behind it. Built on `Dialog`, so the dim, the way out on Escape, the held
  page underneath and the trapped focus are the same machinery as every other
  window. It used to be a workbench file that painted its own `bg-black/50` and
  listened for Escape itself.
- **`Input`**, **`Select`**, **`Badge`** — the picker, the field, the chip.

### 2.1 `asChild`, and why a panel needs it

A clickable card is one box. A `<button>` wrapped in a painted `<div>` is two,
with the paint on the outer one and the click on the inner — so the focus ring
lands on a shape the reader cannot see. `Panel` and `Row` both take `asChild`
and hand their paint to whatever they are given, which is also what keeps a row
that is a link a link: middle-click and open-in-a-new-tab still work.

## 3. The check

`scripts/one-library.py [path…]` reads the screens' own markup and names every
raw element carrying paint of its own, with screen and line, then exits
non-zero. It reads markup, not intent, and four things are deliberately not
offences:

1. A raw `<button>` with no paint at all — a click target, not a control.
2. A circle. The library's cards and panels are rounded rectangles; a ring is a
   drawing.
3. A box whose only edge runs down one side — a speaker's rail down a message,
   not a card face. The check asks for a perimeter border before it calls
   something a face.
4. A picker the reader can never see (`hidden`, `sr-only`, `type="hidden"`).
   There is nothing about it to look wrong.

Everything under `src/components/ui` is exempt, because that is where paint is
supposed to live. Any other exemption goes in `EXEMPT` with its reason and is
printed in the summary, so a skipped screen is never a silent one. `EXEMPT` is
empty, which is the honest state.

## 4. The gate

The check is a case in the project's own checks: `scripts/__tests__/
one-library.test.ts` runs it over the whole of `src` and the listing it prints
is the failure message. A screen that starts painting its own control again
turns `npm test` red on the spot, rather than waiting for somebody to remember
a script. The other cases in that file plant one screen per rule in a throwaway
folder, so the check itself is proved on markup nobody is about to edit.

The gate also rejects visible raw form controls even when they paint nothing.
Responsive hit targets, focus behavior, and semantics belong to the component
library just as much as borders and colours do. Invisible mechanisms such as a
file input behind an attachment button remain permitted because they are not a
second control presented to the reader.

The current-tree check reports **0 hand-painted or raw visible controls**.

## 5. Debt

- **`tool-toggle` in the transcript is a bare `<button>`**, twenty of them on a
  long conversation. It carries no paint, so the check leaves it alone by rule
  1 and it looks like nothing rather than looking wrong. It is still a control
  the library does not own — a disclosure line — and the day one of them wants
  a hover state, it should become a `Row` rather than grow a class list.
- **The check reads markup, not the rendered page.** A screen that pulls its
  paint out into a `const` in another file, or into a Tailwind `@apply`, is
  invisible to it. Nothing does that today.
- **`overlayPanel` is a class string, not a component.** Four panels spread it
  onto their own sheet. It belongs to the library and lives there, but a string
  is a weaker contract than a component: a caller can drop it and nothing says
  so.
