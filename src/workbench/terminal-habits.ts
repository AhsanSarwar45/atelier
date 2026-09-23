/**
 * What a person's hands already know about a terminal, taught to this one.
 *
 * Every terminal on a Linux desktop agrees on a handful of things, and nobody
 * thinks of them as features until one is missing: Ctrl+Shift+C copies,
 * Ctrl+Shift+V pastes, Ctrl+Insert and Shift+Insert do the same, and a link
 * the shell printed opens with Ctrl held down. xterm draws a grid and parses a
 * shell; it leaves every one of those to whoever puts it on a page. Left
 * alone, Ctrl+Shift+C opens the browser's element inspector and Ctrl+Shift+V
 * sends the shell a literal ^V.
 *
 * ## The browser does the copying and pasting
 *
 * Neither chord reads or writes the clipboard itself. A paste chord is left to
 * the browser, whose own default for it is a paste into the focused element —
 * xterm's hidden textarea, which already turns a paste event into a bracketed
 * paste for the shell. A copy chord asks the browser to copy, and xterm's own
 * copy listener puts the selection on the clipboard.
 *
 * That route is chosen over `navigator.clipboard` because the clipboard API
 * exists only on a secure page, and this terminal is opened across a house
 * network over plain `http`. A copy and a paste that worked only on
 * `localhost` would be the same missing feature one machine over.
 */

import type { IClipboardProvider } from '@xterm/addon-clipboard';
import type { Terminal } from '@xterm/xterm';

/** What a key press means to the terminal around the grid, if anything. */
export type Chord = 'copy' | 'paste' | null;

/**
 * Which of the clipboard chords a key press is.
 *
 * Read from `code`, the key's place on the board, and not from `key`: with
 * Shift held `key` is a capital letter, and on a layout other than QWERTY it is
 * another letter altogether, while every terminal binds the key where C and V
 * sit.
 */
export function chord(event: KeyboardEvent): Chord {
  const { ctrlKey, shiftKey, altKey, metaKey, code } = event;
  if (altKey || metaKey) return null;
  if (ctrlKey && shiftKey && code === 'KeyC') return 'copy';
  if (ctrlKey && shiftKey && code === 'KeyV') return 'paste';
  if (ctrlKey && !shiftKey && code === 'Insert') return 'copy';
  if (shiftKey && !ctrlKey && code === 'Insert') return 'paste';
  return null;
}

/**
 * The handler xterm asks before it turns a key press into bytes for the shell.
 *
 * `false` means xterm leaves the press alone, which is what lets the browser's
 * own paste happen. A copy chord's default is something else in most browsers —
 * Chrome's is the inspector — so that one is cancelled and the copy asked for
 * by name. With nothing selected a desktop terminal does nothing at all, and
 * so does this one: the press does not become a ^C for the shell.
 */
export function clipboardKeys(hasSelection: () => boolean) {
  return (event: KeyboardEvent): boolean => {
    const meant = chord(event);
    if (!meant) return true;
    if (meant === 'copy') {
      event.preventDefault();
      if (event.type === 'keydown' && hasSelection()) document.execCommand('copy');
    }
    return false;
  };
}

/**
 * Whether a press on a link should open it.
 *
 * Ctrl, as every Linux terminal has it, or Cmd on a Mac. A tap is let through
 * without either, because a phone has no Ctrl to hold and a link that could
 * never be opened there is not a link.
 */
export function meansToOpen(event: MouseEvent, lastPointer: string): boolean {
  return event.ctrlKey || event.metaKey || lastPointer === 'touch';
}

/**
 * A finger dragged on the grid, scrolling the terminal and not the page.
 *
 * xterm 6.0 scrolls on the wheel and on nothing else (touch came back only in
 * 6.1: xtermjs/xterm.js#5489, #5685), so on a phone a drag fell through to the
 * page: the page scrolled, or the browser read it as a pull to refresh and
 * reloaded the whole app. The pane's CSS stops the browser taking the drag
 * (`touch-action: none`), and this does what a desktop wheel would in its
 * place, one whole line at a time:
 *
 * - With scrollback on screen it moves the view back through it.
 * - In a full-screen program (less, vim) there is no scrollback, and a program
 *   that asked for the mouse (tmux, htop) wants the wheel itself. Both get a
 *   line-sized wheel event on the grid, which xterm turns into arrow keys or a
 *   wheel report exactly as it does for a real one.
 *
 * A finger pushes content the way paper moves under it: dragging up shows what
 * is further down, which is a wheel turned down. Hence the sign.
 *
 * Remove this on moving to xterm 6.1, which scrolls on touch itself and would
 * then scroll twice.
 */
export function touchScroll(term: Terminal, screen: HTMLElement): () => void {
  let lastY: number | null = null;
  let owed = 0;

  const start = (event: TouchEvent): void => {
    lastY = event.touches.length === 1 ? event.touches[0].clientY : null;
    owed = 0;
  };
  const move = (event: TouchEvent): void => {
    if (lastY === null || event.touches.length !== 1) return;
    event.preventDefault();
    const { clientX, clientY } = event.touches[0];
    owed += lastY - clientY;
    lastY = clientY;
    const cell = screen.clientHeight / term.rows;
    if (!(cell > 0)) return;
    const lines = Math.trunc(owed / cell);
    if (lines === 0) return;
    owed -= lines * cell;

    const tracking = term.modes.mouseTrackingMode;
    // x10 reports presses only, never the wheel.
    const wantsWheel = tracking !== 'none' && tracking !== 'x10';
    if (!wantsWheel && term.buffer.active.type === 'normal') {
      term.scrollLines(lines);
      return;
    }
    for (let i = 0; i < Math.abs(lines); i++) {
      screen.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: Math.sign(lines),
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          clientX,
          clientY,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  };
  const end = (): void => {
    lastY = null;
  };

  screen.addEventListener('touchstart', start, { passive: true });
  screen.addEventListener('touchmove', move, { passive: false });
  screen.addEventListener('touchend', end);
  screen.addEventListener('touchcancel', end);
  return () => {
    screen.removeEventListener('touchstart', start);
    screen.removeEventListener('touchmove', move);
    screen.removeEventListener('touchend', end);
    screen.removeEventListener('touchcancel', end);
  };
}

/**
 * Puts the scrollbar back where the view actually is.
 *
 * xterm 6.0 moves its scrollbar only when the buffer scrolls, resizes or swaps,
 * and gets two of those wrong. After a resize the bar takes its new length but
 * keeps its old offset (xtermjs/xterm.js#6172), and a resize while the pane is
 * hidden sizes the bar against a canvas that was not drawn (#6117). Both leave
 * the bar and the view disagreeing, and the next turn of the wheel jumps the
 * view to wherever the bar thought it was. The fit on every window resize and
 * the hidden tabs of this app hit both.
 *
 * The only way to set the bar from the view is private: forget the position
 * the viewport last asked for, and have it measure again. Guarded so that a
 * later xterm without these fields is left alone rather than broken; both
 * bugs are open in 6.1's betas, so check them again when upgrading.
 */
export function resyncScrollbar(term: Terminal): void {
  const viewport = (term as unknown as { _core?: { _viewport?: { _latestYDisp?: number; _sync?: () => void } } })
    ._core?._viewport;
  if (!viewport || typeof viewport._sync !== 'function') return;
  viewport._latestYDisp = undefined;
  viewport._sync();
}

/**
 * The clipboard as a program in the shell may use it (OSC 52): to set, never to read.
 *
 * xterm's own provider answers a read too, which hands whatever the person last
 * copied — a password, a token — to any program that asks, including one on a
 * machine at the other end of an ssh. Desktop terminals refuse that by default,
 * and so does this one. A write still needs the secure page the clipboard API
 * does; on plain `http` it quietly does nothing.
 */
export const shellClipboard: IClipboardProvider = {
  readText: () => '',
  writeText: async (_selection, text) => {
    await navigator.clipboard?.writeText(text).catch(() => undefined);
  },
};

/** Opens a link from the terminal in a tab of its own, cut off from this page. */
export function openLink(uri: string): void {
  window.open(uri, '_blank', 'noopener,noreferrer');
}
