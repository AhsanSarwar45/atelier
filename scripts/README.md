# Checks against the running screen

Two of the ways this screen has failed could not be seen by any test that stops
at the code: the screen looked calm and simply showed the wrong thing. Both are
now checked by driving a real browser at the running server and reading back
what actually reached the page.

Both need a screen already serving (`beads-web`, 127.0.0.1:3008 by default), a
`google-chrome` on the path, and `websocket-client` in the Python running them.
Both exit non-zero when they fail, and print what they measured either way.

## `board-columns-agree.py <project-path>`

Asks `bd` where every card belongs, opens the project screen, reads back which
card each column drew, and names any card in the wrong place.

The rule it encodes, which is the screen's and not `bd`'s: **a job is one card,
in the column of the live work on it.** A step is not a card of its own — the
goal it belongs to stands in for it and lists it inside — and a goal whose steps
are being worked belongs in In Progress however open its own record still says
it is, at any depth, because work hangs under steps rather than under goals. The
card's own status is live work of the same kind and ranks with what is below it,
so being worked beats waiting to land wherever either is found.

Several sessions work one board at once, so the board is read either side of the
screen and only the cards that sat still across both are compared; it says how
many it left out.

## `panel-drawers-agree.py <project-path>`

Opens each side panel and samples it 120 ms later, while it should still be
moving. Two rules:

- **every drawer slides** — one already in place at that moment never animated,
  and one still fully off-screen never started
- **no drawer takes more than half the screen** — what is behind it is what the
  reader came back to

Their widths need not match: a drawer holding a document is not the same thing
as a drawer holding a card's details.

## Adding to these

A new rule gets a fault injected against it before it is trusted — switch the
fix off, watch the check name that panel or that card, switch it back on. A
check that has never been red is not known to work.
