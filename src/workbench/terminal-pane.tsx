/**
 * One live shell, drawn: a grid of characters and the socket that fills it.
 *
 * This is the inside of a terminal and nothing around it. It is handed the id
 * of a shell that already exists — opened over HTTP by whoever owns the tabs —
 * and its whole job is to attach to that shell, draw everything it prints, and
 * send back everything the person does. It draws no chrome, keeps no list, and
 * decides nothing about when a shell should exist: `server/src/terminal/routes.rs`
 * says why those are a different lifetime from this one, and the floating window
 * in `terminal-window.tsx` is what a pane like this gets put inside.
 *
 * ## Built fresh, torn down whole
 *
 * Everything the pane owns — the terminal, its addon, the socket, the observer —
 * is made inside one effect and destroyed in that effect's cleanup. Nothing is
 * created once and reused, and nothing outlives the mount that made it.
 *
 * That is not tidiness, it is the only shape that survives React. In development
 * React mounts a component, unmounts it and mounts it again straight away, so a
 * terminal built outside the effect (or built inside it and not disposed) leaves
 * a dead grid in the page under the live one and a second socket on the shell,
 * and what the person then types goes to a terminal nobody can see. It is the
 * single most common way a terminal in React goes wrong (xtermjs/xterm.js#4978).
 * The test beside this file renders the pane under `StrictMode` for that reason
 * and counts what is left: one grid, one socket.
 *
 * ## Bytes, never text
 *
 * Every frame that arrives is handed to the terminal exactly as it came, as
 * bytes. Nothing here decodes anything, and that is load-bearing rather than
 * lazy. A character outside ASCII is several bytes, an escape sequence is a run
 * of them, and the server makes no promise about where one frame ends — it hands
 * on whatever it read from the pseudo-terminal (`server/src/terminal/stream.rs`).
 * Decode each frame on its own and a character split across two of them becomes
 * two replacement characters, and a colour or cursor sequence split across two
 * becomes a screen that is wrong from that point on. The terminal's own parser
 * holds the half it has and finishes it when the rest arrives, so the only
 * correct thing to do with a frame is to pass it along untouched.
 *
 * The same split decides which way each kind of message travels. Upwards,
 * keystrokes are binary because they are not text: an arrow key is `\x1b[A` and
 * a paste can carry any byte at all, and a text frame must be valid UTF-8 or the
 * connection is at fault. Text frames are therefore free for the small JSON
 * messages that are ours — currently only the shape of the grid.
 *
 * A text frame arriving the other way is a message from a server that knows
 * something this pane does not. It is ignored, and deliberately: the protocol's
 * stance is that a browser and a server one version apart should lose the
 * feature they disagree about, not the terminal.
 *
 * ## Measured only when there is something to measure
 *
 * How many characters fit is worked out from the size of this pane's own box,
 * and only when that box has one. A pane inside a closed tab, a hidden window or
 * a panel that has not been laid out yet is zero by zero, and asking the fit
 * addon to divide that by the width of a character gives a shape that is not
 * wrong so much as meaningless — which is then sent to the shell, and every
 * program in it draws itself for a window that does not exist. So the observer
 * that watches the box does nothing at all until the box has real size.
 */
'use client';

import { useEffect, useRef } from 'react';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

import { apiUrl } from '@/lib/api-base';
import { cn } from '@/lib/utils';

import '@xterm/xterm/css/xterm.css';

/** How big the grid is, in characters — which is the only unit a shell knows. */
type Shape = { cols: number; rows: number };

/**
 * The face the grid is drawn in: the stack Tailwind's `font-mono` resolves to,
 * so a terminal is the same monospace as every other piece of it in the app.
 */
const GRID_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

/**
 * Where the socket for one shell is.
 *
 * Built the way the app's other socket is built (`live-wire.ts`): the path
 * through `apiUrl` so a browser pointed at a backend elsewhere reaches it,
 * resolved against the page it is on, and then the scheme swapped. Which of
 * `ws` and `wss` that gives falls out of whether the page itself is secure,
 * which is the only answer that can be right — a page on `https` may not open
 * a plain socket at all.
 */
function streamUrl(shellId: string): string {
  const path = apiUrl(`/api/terminal/${encodeURIComponent(shellId)}/stream`);
  const absolute = /^https?:/i.test(path) ? path : new URL(path, window.location.href).toString();
  return absolute.replace(/^http/i, 'ws');
}

export function TerminalPane({
  shellId,
  className,
}: {
  /**
   * The shell to attach to, as `POST /api/terminal` named it. Changing it is
   * the same as unmounting and mounting again: the old terminal and its socket
   * go, and a new pair is built for the new shell.
   */
  shellId: string;
  /** Whatever the caller needs on the box; it fills whatever it is put in. */
  className?: string;
}) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const box = host.current;
    // No box means no mount, and no `WebSocket` means this is not a browser —
    // a server render or a test bench. Either way there is nothing to attach.
    if (!box || typeof WebSocket === 'undefined') return;

    // No theme is given, so the grid keeps xterm's own colours rather than the
    // app's. The sixteen ANSI colours are what the programs inside it draw
    // with, and a grid repainted in a light theme makes half of them
    // unreadable. The app's scale dresses the box around it instead.
    const term = new Terminal({ cursorBlink: true, fontFamily: GRID_FONT });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box);

    const socket = new WebSocket(streamUrl(shellId));
    // Set before anything can arrive. Without it a browser hands over each
    // frame as a `Blob`, which can only be read back asynchronously — and
    // frames read back out of order are a screen drawn in the wrong order.
    socket.binaryType = 'arraybuffer';
    const keystrokes = new TextEncoder();

    /**
     * The last shape honestly measured, and the last one this socket was told.
     * Two rather than one, so that a shape measured while the socket was still
     * connecting is still sent the moment it opens, and a shape the shell
     * already has is not sent twice.
     */
    let measured: Shape | null = null;
    let told: Shape | null = null;

    const tellShape = (): void => {
      if (!measured || socket.readyState !== WebSocket.OPEN) return;
      if (told && told.cols === measured.cols && told.rows === measured.rows) return;
      told = measured;
      socket.send(JSON.stringify({ type: 'resize', cols: measured.cols, rows: measured.rows }));
    };

    /**
     * What the pane is worth in characters, asked of the box it is in.
     *
     * The guard is the point of the whole function: a box with no size is not a
     * small terminal, it is a terminal that has not been shown yet, and the two
     * have to be told apart here because nothing downstream can.
     */
    const measure = (): void => {
      const { width, height } = box.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      fit.fit();
      measured = { cols: term.cols, rows: term.rows };
      tellShape();
    };

    term.onData((typed) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(keystrokes.encode(typed));
    });

    // Whatever else moved the grid — the fit above, or a font that finished
    // loading under it — the shell is told the shape the grid actually took.
    term.onResize(({ cols, rows }) => {
      measured = { cols, rows };
      tellShape();
    });

    socket.onopen = () => tellShape();
    socket.onmessage = (frame) => {
      // Bytes are the shell talking; anything else is a message from a server
      // that knows something this pane does not, and is not a reason to stop
      // drawing the shell.
      if (!(frame.data instanceof ArrayBuffer)) return;
      term.write(new Uint8Array(frame.data));
    };

    const watcher = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    watcher?.observe(box);
    // Asked once directly as well, because a pane that is already laid out when
    // it mounts should not wait for an observer to come round to saying so.
    measure();

    return () => {
      watcher?.disconnect();
      // Unhooked before the close, so a frame already on its way in cannot be
      // written to a terminal that is about to be disposed.
      socket.onopen = null;
      socket.onmessage = null;
      socket.close();
      // Takes the grid out of the box with it, along with every listener above.
      term.dispose();
    };
  }, [shellId]);

  return (
    <div
      ref={host}
      data-testid="terminal-pane"
      className={cn('h-full w-full overflow-hidden bg-surface-base', className)}
    />
  );
}
