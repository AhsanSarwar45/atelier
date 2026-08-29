# The terminal

A real login shell, in the app, from any device in the house. Card: `bw-8jzg`.

## 1. What the feature is

A terminal inside the workbench: the person's own default login shell, opened
from the app, drawn in a window that floats over whatever they were already
doing, with tabs when they want more than one. It is reachable from anything on
the local network — the manager opens `nobara.local:3008` on his phone and
expects a shell, and gets one.

One sentence decides most of the shape below: **a shell existing and a shell
being watched are two different lifetimes.** Everything that opens, lists and
closes a shell is ordinary HTTP; the socket only carries what the shell prints
and what is typed at it. Mixing the two — opening a shell by connecting to it,
closing it by disconnecting — is what makes a terminal that loses your build
when the wifi drops.

The server half lives in `server/src/terminal/`: `shell` is one shell on a
pseudo-terminal and the order its pieces have to be let go in, `pump` is the one
thread that drains it, `register` is every shell this process has open, `routes`
is the three HTTP calls, `stream` is the socket. `server/src/local_host.rs`
decides who is allowed to ask at all. The browser half is `terminal-pane.tsx`
(one shell, drawn) and `terminal-window.tsx` (the chrome it floats in), which
know nothing about each other beyond the pane being what goes inside.

Everything below is in the tree. The sections that follow are landed
behaviour, and §11 is the case that drives the whole run of it in a real
browser.

## 2. A shell belongs to the process, not to a socket

Constraint: someone reloads the browser, or shuts the laptop and comes back in
the morning, and the build they left running is still running. So shells cannot
hang off a socket, a tab or a request. They hang off the process, in
`register.rs`, and a socket attaches to one that is already there.

Three calls under `/api/terminal`: `POST` opens, `GET` lists, `DELETE /:id`
closes. The socket is a fourth route, `GET /:id/stream`, and it comes and goes
with a tab, a reload and a laptop lid; the shell behind it notices none of that.

**The shell sits behind a lock of its own** because a pty master is `Send` and
not `Sync` — it may be moved between threads, but two may not hold it at once —
and a register every request handler shares needs exactly what it lacks. There
is no way past this short of `unsafe` and nothing here wants one: the lock is
held for the length of a write or a question to the kernel about a child, never
across an await. Where both locks are taken, the register's is the outer one —
sweeping asks each session whether its shell has ended, which reaches for the
shell's lock while holding the register's. Nothing goes the other way and
nothing should start.

**The pump starts with the shell, not with the first watcher.** A shell nobody
is draining fills the kernel's tty buffer and then blocks on its own output, so
someone who opened a tab and went to make tea would come back to a build that
stopped ten seconds in.

**An ended shell is kept five minutes.** Someone types `exit` and the shell is
gone, but the session is not finished being useful: the browser watching it
still has the last of what it printed to draw, and a page reloaded a second
later wants the tab back so it can show that and close it. So an exited shell is
still listed, and says it has exited.

**The sweep runs on access; there is no timer and no background task.** The
register can only grow through the same three calls that sweep it — nothing
opens a shell without asking this type to, and it answers nothing without first
dropping the long dead — so a register nobody is touching cannot be a register
that is filling up. The price is that the last few ended shells of a sitting are
held until something asks again: one file descriptor and up to a quarter of a
megabyte of remembered output each. A thread waking every minute to find nothing
to do would cost more than that and buy a bound that is already there. The grace
period is a field rather than a constant, so the forgetting is provable in a
test instead of waited out.

**The starting folder is the browser's to name.** It sends the folder it is
showing; nothing on the server looks a project up, because the app already knows
which one is on screen and the server would only be guessing at the same answer
from further away. With none named the shell starts in the home directory, which
is where a shell opened from anywhere else on this machine would start. A path
that is not there, or is there and is not a folder, is refused with 400 before a
spawn is attempted — the alternative reaches the person as a sentence about an
error number from inside the pty crate. Nothing narrower is checked, because a
shell can `cd` anywhere its owner can the moment it opens: confining where it
begins would keep out nobody who got this far, and what decides who gets this
far is §3.

## 3. Who is allowed to open one

External reality, and a decision rather than an accident: this server binds
every interface by default (`main.rs`, `ATELIER_HOST`) and has no password on
anything, and the terminal hands out a real login shell over that. The manager
wants it that way. So the question the guard asks is not "is this loopback" but
"is the caller talking to *this machine*, by one of the names this machine
actually answers to".

Constraint: that Host allowlist in `local_host.rs` is the only defence there is.
Anyone already on the network can open a shell. That is the accepted posture,
not an oversight, and nothing below narrows it — what the guard stops is a web
page in a browser reaching in from outside, which is a different attack from a
person on the LAN.

The guard is bolted to the router in `routes.rs` rather than beside the `nest`
in `main.rs`, so there is no way to mount these routes without it: whoever wires
them up gets the refusal whether they were thinking about it or not. Left in
`main.rs`, removing the layer would have failed nothing.

### 3.1 Why `Host` and not `Origin`

A WebSocket handshake is not governed by the same-origin policy. RFC 6455 leaves
the decision entirely to the server — the browser sends `Origin` as information
and the server *may* use it. If we answer `101`, the socket opens, no matter
which page opened it. The permissive CORS layer this server already installs is
not the control surface here; it never sees the handshake at all.

The obvious guard — check that `Origin` matches `Host` — is what ttyd
(`check_host_origin()`) and code-server (`authenticateOrigin()`) both do, and
DNS rebinding walks straight through it. The attacker serves the page from the
very name he is about to rebind, so when the rebind lands on this box the
browser sends `Origin: http://rebind.evil.com` *and*
`Host: rebind.evil.com:3008`. They agree perfectly, and neither header carries
any sign that the connection arrived here. What he cannot do is make the
victim's browser claim to be visiting a name *we* answer to. So the rule is an
allowlist of what this machine is — what Vite shipped as `server.allowedHosts`
after its own rebinding advisory (GHSA-vg6x-rcgg-rjx6). `Origin` is never
consulted.

The allowlist is `localhost` and anything under it, anything ending `.local`
(reserved to multicast DNS by RFC 6762 and answered by the responder on this
box), this machine's own hostname read once at startup, and loopback, private
and link-local addresses.

### 3.2 Why the address is parsed and never string-matched

`127.0.0.1` can be spelled `2130706433`, `0x7f000001`, `017700000001` or
`::ffff:127.0.0.1`, and a guard that compares text misses all four. Two
behaviours in the standard library do the work instead: `parse::<IpAddr>()` has
rejected octal and hexadecimal forms outright since Rust 1.58, so an obfuscated
literal simply is not an address and falls through to the name branch where it
matches nothing; and `to_canonical()` folds a four-part address written inside a
six-part one back down before the predicates run.

## 4. The pty, and the order the pieces are let go in

`shell.rs` has a deadlock in it if its pieces are dropped in the wrong order, so
the order is the point of the module.

**The slave end is dropped the instant the child exists.** A pseudo-terminal has
two ends; the child gets the slave, we keep the master. The kernel only reports
the end of the output when *every* handle on the slave side is closed — and the
moment `spawn_command` returns, the child has its own copy, so ours is pure
ballast. Keep it and the reader blocks forever on a shell that exited minutes
ago. `open` is written so there is no path where the slave is stored.

That claim needed a test with teeth, and the obvious one has none: a test
written against `Shell` can only watch the output end, and it passes just as
happily with the drop removed, because the slave goes out of scope either way.
So the test keeps a slave handle deliberately — the output does not end for a
full two seconds after the shell has exited and been waited for, and ends the
moment the handle is let go. Parking the slave in a field for later would now
fail loudly.

**The master goes the other way**: held until the child has been waited for. The
crate's own example warns that some platforms are unhappy if it goes sooner, so
`Drop` takes the child down first and lets the master go after.

**The writer is a third trap.** It has to be taken off the master even by a
caller with nothing to type, because the writer is what can produce an end of
input at all — the crate's example says so in as many words. It lives for the
shell's whole life for that reason.

**Which shell to run is not ours to decide.**
`CommandBuilder::new_default_prog()` already reads `$SHELL`, checks it is a
thing that can actually be executed, and falls back to the password database
when it is not — and it starts it as a login shell the way a terminal emulator
does, by putting a dash in front of the name in the argument the shell reads its
own name from, not by passing a flag. We add only what it deliberately leaves
alone: `TERM=xterm-256color` and `COLORTERM=truecolor`.

**And take away what it should not have brought.** Everything under the
`ATELIER_` and `BEADS_` prefixes, plus `RUST_LOG` and `PORT`, is removed before
the spawn. The app's own settings do not follow a person into their shell — a
worktree's port or log level leaking into an interactive shell is the kind of
thing that is discovered a month later, in something unrelated.

## 5. The pump: three volumes on one thread

A pseudo-terminal reader blocks and there is no other kind to be had, so a shell
that is being watched costs a thread whether we like it or not. Since the thread
is being spent anyway, `pump.rs` is also where all three ways a terminal's
output can hurt the app are answered — too many messages, too much remembered,
too much in flight. All three are about volume and all three are cheapest to
answer at the point the bytes arrive.

### 5.1 Too many messages

A read off a master tops out around eight kilobytes on this box, because a pty
hands back whatever is in the tty buffer at that instant. Sending one message
per read — which is what ttyd does, with no debounce anywhere — turns a second
of `yes` into hundreds of websocket frames, each a wake-up and a repaint of a
screen nobody could read at that speed anyway.

So a message here is not a read. The first read of a burst opens a window of
twenty milliseconds and everything that turns up inside it goes out together.
Measured: 1,241,268 bytes went from 7,569 messages to 12 — a 630-fold
reduction, far more than the "few large frames" this was expected to buy.

The window is only opened when the shell is visibly ahead of us: either there is
already another read queued behind the one in hand, or that read filled the
buffer. Both mean more is coming. Neither is true of a keystroke's echo, which
is a handful of bytes arriving on its own — so the thing a person can actually
feel is never delayed by the thing they cannot.

### 5.2 Too much remembered

The last quarter of a megabyte is kept per shell and replayed to whoever comes
back. It is kept as raw bytes in the order they arrived, and it is never parsed,
re-wrapped or split into lines: colour, cursor position, character set and
screen mode are all carried by escape sequences that span runs of bytes, and a
terminal handed a tidied-up version of those draws something other than what was
there.

Which leaves the seam, and it is admitted rather than hidden. Trimming the
oldest end can cut an escape sequence in half, and a replay starting on the tail
of one begins by telling the terminal something nobody said. There is no honest
fix short of keeping everything ever printed, so what is done instead is an
approximation: once anything has been trimmed at all, the replay starts at the
first line break it can find and is prefixed with a reset. That drops a partial
line and puts the colours back to normal. It does not restore a cursor position,
an alternate screen, or a character set chosen before the trim, so a full-screen
program that was running when the page was reloaded still comes back looking
wrong. Getting that right means keeping a parsed screen rather than bytes, which
is a different piece of work. The worst case of the rule is in §13.

### 5.3 Too much in flight

Whoever streams this to a browser is slower than a shell can print, and
tokio-tungstenite's sink pushes back not at all — feed it faster than the socket
drains and its send queue grows until the process dies. So the queue that
matters is the pump's own, and it is bounded: four messages per viewer, eight
reads in hand, and no single message over a hundred and twenty-eight kilobytes.
Nothing here is ever unbounded.

What happens when a queue fills is the whole decision.

**Broadcast was rejected.** `tokio::sync::broadcast` is the obvious shape for
one writer and several readers, and it is the wrong one: a receiver that falls
behind is handed `Lagged` and the bytes it missed are gone. A terminal that
quietly loses a run of bytes is not a slow terminal, it is a broken one, because
the missing run is as likely to be half an escape sequence as it is to be text,
and the screen never recovers on its own — nothing later says what the missing
half would have said. So each viewer gets its own bounded channel and the pump
waits when one of them is full.

**Waiting is the right answer rather than a compromise.** Stop reading the
master and the kernel's tty buffer fills; once it is full the shell's own write
blocks. That is precisely what happens to any program printing into a terminal
that is not keeping up, so the shell is being told the truth about how fast it
is being read. The backpressure chain runs the whole way down: a browser that
stops reading stops the socket, which stops the pump, which stops the master,
which stops the shell.

The cost is written down here and paid in §6: one wedged viewer holds up all the
others, which means whatever streams this has to let go of its receiver the
moment its socket dies rather than leaving it lying about.

## 6. The wire

One socket per shell, at `/api/terminal/:id/stream`.

### 6.1 Binary is bytes, text is control

Downwards, a binary frame is exactly what came off the pseudo-terminal. Nothing
re-flows it, splits it on lines, or touches its line endings, for the reason in
§5.2. Where one frame stops and the next begins says nothing at all, though: a
browser hands the bytes to its terminal in the order they arrived, and two
frames there are the same as one.

Upwards, binary is keystrokes and text is a control message, and the split is
the protocol's rather than ours. RFC 6455 requires a text frame to be valid
UTF-8, and keystrokes are not text: an arrow key is `\x1b[A`, an interrupt is
`\x03`, and a paste can carry any byte at all, including ones no decoder will
accept. Sent as text they would arrive mangled into replacement characters,
which is not a slow keystroke but a wrong one. So keystrokes must be binary,
which leaves text free for the handful of small messages that are ours to shape
and are already JSON — currently only `{"type":"resize","cols":N,"rows":N}`.
Nothing needs an envelope, a length prefix, or a first byte reserved as a tag.

Downwards the same split is ours rather than the protocol's, and it is safe to
have taken for the reason the protocol took it: output is bytes and can never be
sent as text, so a text frame going down can only ever be something the server
said.

Unrecognised control messages are ignored rather than refused, both ways. A
browser and a server one version apart should lose the feature they disagree
about, not the terminal.

### 6.2 The past and the future are taken in one call

Asking for what was missed and *then* subscribing to what comes next leaves a
gap, and whatever prints inside that gap is either lost or shown twice. The gap
is microseconds wide, which is exactly why it needed a test rather than an
argument: the case that proves it hands over a hundred kilobytes and has the
viewer read nothing for a quarter of a second, turning the seam from an instant
into a window the shell prints into. Before that widening, the same case passed
with the bug in place — worth knowing about any test of a race.

### 6.3 Replay comes in pieces, and its end is said rather than counted

Everything the viewer missed comes first, in as many frames as it takes, in
pieces of thirty-two kilobytes. After the last of them comes one text frame,
`{"type":"replayed"}`, and always exactly one of those even when nothing was
missed and no frame came before it. So the browser learns the boundary in one
place, settles its scroll once rather than after every frame, and tells that
frame from output by the frame's type alone without looking inside it.

### 6.4 A viewer that stops reading is cut, on a bound around one send

`WEDGED_AFTER` is five seconds. §5.3 deliberately drops nothing for a viewer
that falls behind — it waits — which means a viewer that never reads again would
hold up the pump, and a held-up pump eventually blocks the shell's own writes. A
half-open socket, a phone that went into a tunnel, a tab closed with no close
frame: none of those may cost the other people watching that shell, or the
shell. So the waiting is bounded here rather than there. A send that has not
moved at all for `WEDGED_AFTER` is taken as a viewer that is gone and the socket
is dropped, which drops the receiver, which fails the pump's pending send
immediately and lets every other viewer carry on.

That the cut is cheap is what makes it the right answer: a viewer let go of
reconnects and is handed a replay, so the cost of being wrong about a slow link
is a reload, while the cost of being wrong the other way is everybody else's
terminal freezing.

### 6.5 The history, because it is the reason for the shape

The first design (`bw-8jzg.6`) sent the replay as a single frame and put the
five-second limit around the whole of one send. That made the limit a budget for
the transfer wearing the words of a watchdog: how much there was to replay
decided who was treated as gone. A viewer reading steadily at twenty kilobytes a
second was cut partway through being shown what it missed, shown nothing, handed
the same quarter megabyte on reconnecting, and cut again. Being slow was enough;
being gone was not required. It was carried knowingly and filed as its own item
rather than papered over.

The fix (`bw-8jzg.15`) is the piece size, and the arithmetic is why it is
thirty-two kilobytes and not the pump's larger gathering bound: one send of a
hundred and twenty-eight kilobytes under a five-second limit still demands
twenty-six kilobytes a second, so the very viewer from the bug report would
still have been cut. At thirty-two, a link managing seven kilobytes a second
finishes every piece. The live half is not sliced — the pump gathers on purpose,
and slicing what it gathered would undo §5.1.

### 6.6 The bill for that, written out

Bounding one send rather than a lack of progress has a price and it is stated
rather than discovered. A viewer that takes one piece and then stops, over and
over, is given the window afresh each time, so it can hold a shell up for
`WEDGED_AFTER` *a piece* rather than `WEDGED_AFTER` in all. It is bounded by how
many pieces a replay comes in, and it is what asking about progress costs when
the only thing that can actually be measured is whether a send finished.

And what a reconnecting viewer gets back is the last quarter megabyte, so a
shell that printed a great deal during the stall has lost the middle of it for
that viewer. Nothing bounded can promise otherwise.

### 6.7 Writes go off the runtime

Writing to a pseudo-terminal blocks until the program on the far end reads, and
a program ignoring its input while somebody pastes into it can hold that write
as long as it likes. So keystrokes go to the shell off the async runtime.
Reshaping goes the same way even though the call itself returns at once, because
waiting for the shell's lock is the same block once removed.

## 7. The pane

`terminal-pane.tsx` is the inside of a terminal and nothing around it: handed
the id of a shell that already exists, it attaches, draws everything the shell
prints, and sends back everything the person does. It draws no chrome, keeps no
list, and decides nothing about when a shell should exist.

**Built fresh, torn down whole.** Everything the pane owns — the terminal, its
fit addon, the socket, the size observer — is made inside one effect and
destroyed in that effect's cleanup. Nothing is created once and reused, and
nothing outlives the mount that made it. That is not tidiness, it is the only
shape that survives React: in development React mounts a component, unmounts it
and mounts it again straight away, so a terminal built outside the effect, or
built inside it and not disposed, leaves a dead grid in the page under the live
one and a second socket on the shell — and what the person then types goes to a
terminal nobody can see. It is the single most common way a terminal in React
goes wrong (`xtermjs/xterm.js#4978`). The test renders the pane under
`StrictMode` and counts what is left: one grid, one socket. With the disposal
removed, two grids appear and the case fails.

**Bytes are never decoded in JavaScript.** Every frame is handed to the terminal
exactly as it came. A character outside ASCII is several bytes, an escape
sequence is a run of them, and the server makes no promise about where one frame
ends. Decode each frame on its own and a character split across two of them
becomes two replacement marks where one character belongs; a colour or cursor
sequence split across two becomes a screen that is wrong from that point on. The
terminal's own parser holds the half it has and finishes it when the rest
arrives, so the only correct thing to do with a frame is pass it along
untouched. The two split-character cases run against the real parser, not a
stand-in.

**Measured only when there is something to measure.** How many characters fit is
worked out from the pane's own box, and only when that box has one. A pane in a
closed tab, a hidden window or a panel not yet laid out is zero by zero, and
asking the fit addon to divide that by the width of a character gives a shape
that is not so much wrong as meaningless — which is then sent to the shell, and
every program in it draws itself for a window that does not exist. So the
observer does nothing at all until the box has real size.

And a shape is sent whenever measuring *succeeds*, not only when the grid
changes: a pane reattaching to a shell whose grid happens to match fires no
change and would leave the shell holding a stale shape forever. A guard keeps a
shape the shell already has from being sent twice.

**Unknown words are tolerated both ways.** A text frame arriving from a server
one version ahead is dropped rather than drawn, so the person loses a feature
and not their terminal.

The socket's address is built the way the app's other socket is built
(`live-wire.ts`): the path through `apiUrl` so a browser pointed at a backend
elsewhere still reaches it, resolved against the page it is on, then the scheme
swapped. Which of `ws` and `wss` that gives falls out of whether the page itself
is secure, which is the only answer that can be right — a page on `https` may
not open a plain socket at all.

## 8. The window

`terminal-window.tsx` is chrome and nothing else: it takes a name and whatever
should be inside it, and knows nothing about what that is. Drag by the bar, pull
by any of eight edges and corners, fill the screen and come back.

The bar is the only thing you can drag by, and that follows from what goes
inside: the body is a grid of characters that wants every press and every drag
for itself, and a window that moved when you selected a line of output would be
a window you could not read from.

**It portals itself into the body.** The shell is exactly the height of the
screen and clips, and half the app is wrapped in things that animate — a
transform anywhere above this silently becomes the containing block for anything
`fixed` inside it, so a window written where it is opened from would be cropped
by one and moved by the other. Where in the tree it is written is therefore the
caller's business and nothing else's. It sits on layer 40: above the two bars,
which claim no layer at all, and below the 50 every dialog and menu here uses,
so a menu opened out of the window still comes out over it.

**Coming back means the shape it left**, not a fresh default. The remembered
shape is also the only record that the window is filled — one piece of state
rather than two, so the two can never disagree about which is true.

**The clamp keeps the bar, not the window.** All of the bar's height and enough
of its width to grab is what is held on screen, because shoving a window mostly
out of the way is a thing people do on purpose, while losing the only handle it
has is not. It is re-clamped whenever the browser changes size, so a window
parked at the right edge of a wide screen is pulled back into a narrow one.

**Escape does nothing at rest, deliberately.** The body is a terminal and Escape
belongs to whatever is running in it; closing on Escape would shut the window
every time somebody left insert mode. While a pointer is down it abandons the
drag and puts the window back where the gesture started, which is the only place
a gesture can mean nothing else.

**Nothing is remembered across a reload.** Where a window was is worth less than
it costs: a saved shape has to be re-checked against a screen that may be a
different one before it can be trusted, and a remembered shape that is wrong
puts the window somewhere the reader did not put it and cannot explain. A
terminal that comes back where it opens surprises nobody. If a later card does
ask for it, it belongs in local storage beside the chat's panel widths, and it
comes back through the same clamp as everything else here.

**Phone is the exact complement of the `sm:` prefix**, and it is asked as a
question about the screen's width rather than measured, so the same evaluator
answers it as the one behind the styling. Below it the window is the screen,
with no bar to drag and no edges to pull, because a full-screen window has
nowhere to be dragged to.

## 9. The tabs, and the button that opens them

The shells belong to the app rather than to any one screen. The button that
opens them is on the first bar of every screen that has one, and pressing it on
the board and again in the chat has to find the same shells with the same things
still running in them. So the list lives in a context mounted around the whole
app (`terminal-shells.tsx`, mounted once in `src/app/layout.tsx`), and the window
with its tabs (`terminal-tabs.tsx`) is a view of it.

**Nothing in that context draws anything**, and that is deliberate rather than
tidy: the app shell draws the button, and the window's chrome reaches back into
the app shell for `ToolButton`. A context that imported either of them would
close the circle.

**A hidden tab is hidden, never unmounted.** Every tab's pane stays mounted for
as long as its tab exists, and switching tabs only changes which one is
displayed. §7 is the reason: the pane builds its terminal and its socket in an
effect and destroys both in that effect's cleanup, so unmounting a pane to hide
it would drop the socket, throw away everything the shell had printed, and put
the reader back at the bottom of a screen they had scrolled up from. Hiding
costs a box with no size, which is a state the pane is built to sit in quietly
— it measures nothing until it has a size again.

**Closing the window flips a boolean and nothing else.** The only DELETE is the
cross on a tab, which is the only way a person can say they are finished with a
shell. That is §2 restated one layer up: a shell outlives every socket that ever
watched it, so a build running in a window somebody shut is still running when
they open it again, and a window that killed what was inside it on the way out
would make the persistence underneath it pointless. The window is hidden rather
than taken down for the same reason, and goes only when the last tab is closed
and there is nothing left to keep.

**The server's list is what a reload rebuilds from.** Nothing about the tabs is
written down in the browser. The first time the window is shown in a page's life
it asks `GET /api/terminal` and believes the answer: one tab for each shell that
has not ended, in the order the server gives them, which is the order they were
started in. Ids remembered in local storage would mean a tab drawn for a shell
that died while the page was closed, attached to a socket that will never open,
with nothing to tell that apart from a slow one. A shell the server lists as
ended is not restored — it still holds the last of what it printed, which is
worth something, but not enough to hand somebody a tab they cannot type into and
cannot tell from the live ones beside it.

**A new tab starts in the folder the screen is showing**, remembered per tab.
With no project on screen the key is left out of the request altogether and the
server starts the shell at home (§2). The folder is kept in a ref rather than in
state because nothing draws it: it is read once, at the moment a shell is
opened, and a project appearing on screen has no business re-rendering every
terminal in the app.

**The list is kept in a ref as well as in state.** Opening, closing and
restoring are all asynchronous, and each has to act on the list as it is when
its answer arrives rather than as it was when it was called. One helper writes
both, so the two cannot drift.

**The button is a `ToolButton` on the project bar**, drawn by the app shell
beside the settings button inside one `ml-auto` wrapper. There are still exactly
two `data-shell-bar` elements, so the app shell's rule that a third bar can only
appear by declaring itself is untouched.

Radix's tab primitive was considered and rejected: `TabsContent` under
`forceMount` draws every panel visible, so we would have supplied our own hiding
anyway, and it bought nothing over a `tablist` of our own.

## 10. The one-wire exception

The standing rule (`bw-zkh4`) is that however much of the app is on screen, the
window holds one connection. The board, the helper and the open chat read from
it by tag, and no other file may open a second — a browser allows six
connections to one address across every window it has and an event stream never
gives its slot back, which is what left screens stuck on loading until they were
reloaded.

The shell's socket is the one exception, and it is argued in the file that
enforces the rule (`src/workbench/__tests__/one-wire.test.ts`, in
`MAY_OPEN_ONE`). Its socket belongs to one shell rather than to the window; it
comes and goes with the pane drawing it rather than with what is on screen; and
what it carries is raw bytes both ways rather than tagged text — so multiplexing
it onto the wire would mean the wire carrying frames it must not decode, for a
lifetime that is not its own. It costs the reads nothing, because a browser does
not count sockets against the six it allows per address at all.

That is the whole of the exception, and it is now the rule. A second EventSource
is still forbidden everywhere, and so is a socket opened for anything the wire
already carries. Adding a third name to `MAY_OPEN_ONE` needs an argument of the
same kind, written where the list is.

## 11. Proved in a real browser

Every other proof of this feature stops short of a real shell: the Rust cases
put bytes on a socket, and the browser unit cases hand the pane a `WebSocket`
that is not one. `tests/e2e/terminal.spec.ts` is the one that presses the button
in a browser, types into the grid, and reads the answer the shell printed — so
the whole run is under test at once, from the click through the pseudo-terminal
and back to the pixels. It needs an instance built from the worktree it runs in,
because the shells live in the server.

Five cases: the top-bar button opens a window with a live shell; two tabs are
two shells and neither answers the other's canary; a window dragged narrower is
measured by the app and confirmed by the shell's own `stty size`; a job left
running is still running after a page reload, its tab restored from the shell
list; and at phone size the terminal takes the screen and answers what is typed.

Three things the file had to get right, and writes down rather than leaving to
be rediscovered.

**A canary is split when typed and whole when asserted.** A terminal echoes what
is typed at it, so `echo HELLO` puts the word on the screen before the shell has
done anything at all, and a case that looked for it would pass against a shell
that never ran. Written as two strings on the line the shell echoes and one word
in the line the shell prints, finding it is finding output and nothing else.

**`stty size`, and not `tput cols`.** Inside a command substitution `tput` can
answer out of the terminal description rather than out of the window, and its
answer for `xterm-256color` is eighty either way — which is also the width the
shell is opened at, so it would have agreed with a resize that never happened.
The negative control is what proves the case can fail: asserting the width from
before the drag fails against the width actually observed after it.

**A pull settles in more than one step, honestly.** The grid is measured, the
lines in it reflow into the new width, that gives the viewport a scrollbar it
did not have, and the narrower box is measured again. Both shapes are sent and
the shell ends up with the second, so asking it about the first is asking about
a shape that was true for one frame. The wait is on how many shapes have been
sent rather than on a sleep: when no new one has arrived between two looks, the
pane is done.

The cases run one at a time. A shell one case leaves behind is a tab the next
case finds already open, because the window fills itself from the shell list
before it starts anything new, so each case begins by closing every shell the
instance is holding. Run side by side they would be handing each other tabs.

## 12. Measured, so it is not guessed at

| | |
|---|---|
| One read off a pty master, this box | about 8 KB |
| 1,241,268 bytes, one message per read | 7,569 messages |
| The same bytes, gathered in a 20 ms window | 12 messages |
| The difference | 630-fold |
| Kept and replayed per shell | 256 KB |
| One replay piece | 32 KB |
| Rate a 32 KB piece needs to finish inside 5 s | about 7 KB/s |
| Rate one 128 KB send would have needed | about 26 KB/s |
| An exited shell is held | 5 minutes |

At the last terminal commit the Rust suite was 645 cases, run twenty times in a
row for twenty clean runs after §6.5 was fixed; the browser suite was 2078
across 198 files, and the browser case in §11 adds five more that need a built
instance to run at all. The pump's stall case and the seam case were both rewritten in
the same change: each had slept a fixed interval and then asserted a claim about
machine speed wearing the clothes of a claim about the pump, and each failed on
a loaded machine. They now wait for the state they were always trying to reach.

## 13. Debt, honestly

- **Replay after a trim starts at the first line break in what was kept**, so
  output carrying no line breaks at all loses nearly the whole scrollback. That
  is the rule's worst case rather than a bug, but it is a good deal worse than
  "drops a partial line" and is worth knowing before trusting the replay.
- **Replay restores no cursor position, no alternate screen, and no character
  set chosen before the trim.** A full-screen program running when the page was
  reloaded comes back looking wrong. Fixing it means keeping a parsed screen
  rather than bytes.
- **A viewer that takes one piece and stalls, repeatedly, gets the wedged window
  afresh per piece** (§6.6), so it can hold a shell up for far longer than the
  five seconds the constant suggests. Bounded by the piece count, not by the
  constant.
- **A cut viewer reconnects to the last quarter megabyte only.** A shell that
  printed a great deal during the stall has lost the middle of it for that
  viewer.
- **One wedged viewer holds the others up for the length of the bound**, because
  waiting is what a bounded queue with no drop-on-lag does. That is the accepted
  price of never losing half an escape sequence.
- **Ended shells are held until something else calls.** One file descriptor and
  up to 256 KB each, for as long as nobody touches the register. Accepted in
  exchange for having no timer.
- **The pane's measuring and the window's geometry are proved in the browser
  alone.** jsdom has no layout, no pointer capture and no answer to a question
  about screen width, so the unit suites check them as class names and §11 is
  the only thing that reads a real pixel. A change that keeps the classes and
  breaks the arithmetic turns nothing red until the browser case is run, and
  that case needs a built instance rather than `npm test`.
- **Nothing helps a phone with the keys a terminal needs.** §11 proves a phone
  can type into a shell and read what it printed, but there is no soft-keyboard
  affordance and no row for the keys a phone has no room for — Escape, Tab,
  Control, the arrows. A phone can run a command and read its output; it cannot
  comfortably drive anything interactive.
- **LAN-open with no authentication.** Anyone already on the network gets a
  shell. Deliberate (§3), and the Host allowlist does not change it.
