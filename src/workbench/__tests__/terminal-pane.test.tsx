/**
 * What the pane that draws a live shell promises: it survives being mounted
 * twice, it only measures a box that has a size, and what the shell printed
 * reaches the screen as bytes rather than as text.
 *
 * The terminal here is the real one. xterm runs under jsdom given one thing it
 * is missing — `matchMedia`, which the renderer asks for the moment it opens —
 * so what parses the shell's output in these cases is the same parser that
 * parses it in a browser, and the character split across two frames is drawn
 * whole by the code that has to do it for real.
 *
 * Two things are stood in for, and both are things jsdom does not have rather
 * than things this file did not want:
 *
 * - The socket, because jsdom has no `WebSocket` at all. The stand-in is the
 *   browser's shape of one — a `binaryType`, a `readyState`, a `send` — with
 *   the server's end exposed so a case can make frames arrive.
 * - Layout. jsdom lays nothing out, so every box in it is zero by zero, which
 *   is exactly the state the pane refuses to measure. Each case says how big
 *   the pane's own box is; every other element keeps the zero jsdom gives it.
 *
 * The second of those has a consequence worth stating plainly: with no layout,
 * xterm can measure no character, so the fit addon proposes nothing and the
 * grid keeps the eighty by twenty-four it starts at. So what these cases prove
 * about size is WHEN a shape is measured and sent and when it is not — which is
 * the promise the card makes — and not that the arithmetic turning pixels into
 * columns is right. That needs a browser.
 */
import { StrictMode } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalPane } from '@/workbench/terminal-pane';

/** One socket, as a browser would make it, with the server's end left open. */
class Socket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every socket ever made, in order, so a case can see the ones let go of. */
  static made: Socket[] = [];

  binaryType = 'blob';
  readyState: number = Socket.CONNECTING;
  /** Everything the pane has sent up, in the form it sent it. */
  sent: unknown[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((frame: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    Socket.made.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = Socket.CLOSED;
  }

  /** The handshake finishes. */
  opens(): void {
    this.readyState = Socket.OPEN;
    this.onopen?.();
  }

  /** The shell prints something: one binary frame, exactly as it came. */
  prints(...bytes: number[]): void {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer });
  }

  /** The server says something in words rather than bytes. */
  says(text: string): void {
    this.onmessage?.({ data: text });
  }

  /** The sockets this pane has not let go of. */
  static attached(): Socket[] {
    return Socket.made.filter((socket) => socket.readyState !== Socket.CLOSED);
  }

  static forget(): void {
    Socket.made = [];
  }
}

/** A `ResizeObserver` a case can decide the timing of. */
class Watcher {
  static live: Watcher[] = [];

  constructor(readonly tell: () => void) {
    Watcher.live.push(this);
  }

  observe(): void {}
  unobserve(): void {}

  disconnect(): void {
    Watcher.live = Watcher.live.filter((watcher) => watcher !== this);
  }

  /** The box changed size, as far as everything still watching knows. */
  static noticed(): void {
    Watcher.live.forEach((watcher) => watcher.tell());
  }

  static forget(): void {
    Watcher.live = [];
  }
}

/** How big the pane's own box is. Nothing else in the page has a size. */
let paneBox = { width: 0, height: 0 };

function rect(width: number, height: number): DOMRect {
  return {
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Every terminal built, and every one disposed, in the order it happened. */
const built: Terminal[] = [];
const disposed: Terminal[] = [];

const laidOut = Element.prototype.getBoundingClientRect;

const reallyOpen = Terminal.prototype.open;
const reallyDispose = Terminal.prototype.dispose;

beforeEach(() => {
  Socket.forget();
  Watcher.forget();
  built.length = 0;
  disposed.length = 0;
  paneBox = { width: 0, height: 0 };

  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('ResizeObserver', Watcher);
  // The renderer asks for this the moment a terminal opens, and jsdom answers
  // no media queries at all. Nothing in the pane reads the answer.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  // Recorded rather than replaced: the real terminal still opens and still
  // disposes, and these are the only way a case can name the one that did.
  vi.spyOn(Terminal.prototype, 'open').mockImplementation(function opened(
    this: Terminal,
    parent: HTMLElement,
  ) {
    built.push(this);
    reallyOpen.call(this, parent);
  });
  vi.spyOn(Terminal.prototype, 'dispose').mockImplementation(function gone(this: Terminal) {
    disposed.push(this);
    reallyDispose.call(this);
  });

  Element.prototype.getBoundingClientRect = function measured(this: Element): DOMRect {
    if (this instanceof HTMLElement && this.dataset.testid === 'terminal-pane') {
      return rect(paneBox.width, paneBox.height);
    }
    return laidOut.call(this);
  };

});

afterEach(() => {
  Element.prototype.getBoundingClientRect = laidOut;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The pane, drawn, with the socket it opened and the terminal it built. */
function draw(shellId = 'shell-1') {
  const { unmount } = render(<TerminalPane shellId={shellId} />);
  return { socket: Socket.made[Socket.made.length - 1], term: built[built.length - 1], unmount };
}

/**
 * What the terminal has drawn on one of its lines.
 *
 * Read out of the terminal's own buffer rather than out of the page, because
 * with no layout xterm's renderer paints no rows at all. The buffer is what the
 * renderer paints FROM, so this is the same answer one step earlier, and it is
 * the real terminal's answer and not a stand-in's. The empty write is how the
 * answer is waited for: xterm applies what it is given on its own schedule and
 * calls back in the order it was given, so a callback on an empty write is a
 * callback after everything written before it.
 */
async function drawn(term: Terminal, row = 0): Promise<string> {
  await new Promise<void>((done) => term.write('', () => done()));
  return term.buffer.active.getLine(row)?.translateToString(true) ?? '';
}

/** The place a browser sends keystrokes from, which is where xterm listens. */
function keyboard(): HTMLTextAreaElement {
  const area = screen.getByTestId('terminal-pane').querySelector('textarea');
  if (!area) throw new Error('the terminal drew no way to type into it');
  return area as HTMLTextAreaElement;
}

/**
 * Only the frames that went up as bytes, as ordinary numbers.
 *
 * Asked with `ArrayBuffer.isView` rather than `instanceof Uint8Array`, because
 * the `TextEncoder` jsdom hands over is Node's own: what it makes is a byte
 * array from another realm, and `instanceof` says no to it however plainly it
 * is one. A browser has one realm and would answer either question the same.
 */
function typedUp(socket: Socket): number[][] {
  return socket.sent.filter(ArrayBuffer.isView).map((frame) => [...(frame as Uint8Array)]);
}

/** Only the frames that went up as words. */
function saidUp(socket: Socket): string[] {
  return socket.sent.filter((frame): frame is string => typeof frame === 'string');
}

describe('the pane that draws a live shell', () => {
  it('attaches to the shell it was named, on the socket beside the page', () => {
    const { socket } = draw('a1b2c3');

    expect(socket.url).toBe('ws://localhost:3000/api/terminal/a1b2c3/stream');
    expect(socket.binaryType).toBe('arraybuffer');
  });

  it('draws a character whole when its bytes arrive in two frames', async () => {
    const { socket, term } = draw();
    socket.opens();

    // "é" is two bytes and the server promises nothing about where a frame
    // ends, so here it ends between them. A pane that decoded each frame on its
    // own would draw two replacement characters and never the letter.
    socket.prints(0xc3);
    socket.prints(0xa9, 0x21);

    expect(await drawn(term)).toBe('é!');
  });

  it('draws a character whole when its four bytes arrive in four frames', async () => {
    const { socket, term } = draw();
    socket.opens();

    // The same again with the longest an ordinary character gets, one byte at a
    // time, so that nothing about it can be an accident of how the halves fell.
    for (const byte of [0xf0, 0x9f, 0x92, 0xa1]) socket.prints(byte);

    expect(await drawn(term)).toBe('💡');
  });

  it('does not measure a box that has no size, and tells the shell nothing', () => {
    const fit = vi.spyOn(FitAddon.prototype, 'fit');
    paneBox = { width: 0, height: 0 };

    const { socket } = draw();
    socket.opens();
    Watcher.noticed();

    expect(fit).not.toHaveBeenCalled();
    expect(saidUp(socket)).toEqual([]);
    expect(socket.sent).toEqual([]);
  });

  it('measures the box once it has a size, and tells the shell the shape', () => {
    const fit = vi.spyOn(FitAddon.prototype, 'fit');
    paneBox = { width: 0, height: 0 };

    const { socket } = draw();
    socket.opens();
    expect(fit).not.toHaveBeenCalled();

    // The window opens, the tab is shown, the panel is laid out: same pane.
    paneBox = { width: 800, height: 340 };
    Watcher.noticed();

    expect(fit).toHaveBeenCalled();
    expect(saidUp(socket)).toEqual([JSON.stringify({ type: 'resize', cols: 80, rows: 24 })]);
  });

  it('tells a shell a shape it already has only once', () => {
    paneBox = { width: 800, height: 340 };

    const { socket } = draw();
    socket.opens();
    Watcher.noticed();
    Watcher.noticed();

    expect(saidUp(socket)).toHaveLength(1);
  });

  it('sends what is typed as bytes and not as words', () => {
    paneBox = { width: 800, height: 340 };
    const { socket } = draw();
    socket.opens();

    const area = keyboard();
    fireEvent.keyDown(area, { key: 'a', keyCode: 65, code: 'KeyA' });
    fireEvent.keyDown(area, { key: 'Enter', keyCode: 13, code: 'Enter' });
    // An arrow key is an escape sequence, and an interrupt is a byte no
    // decoder will take. Neither is text, which is why none of this may be.
    fireEvent.keyDown(area, { key: 'ArrowUp', keyCode: 38, code: 'ArrowUp' });
    fireEvent.keyDown(area, { key: 'c', keyCode: 67, code: 'KeyC', ctrlKey: true });

    expect(typedUp(socket)).toEqual([[0x61], [0x0d], [0x1b, 0x5b, 0x41], [0x03]]);
    // The shape went up as words; nothing else did.
    expect(saidUp(socket)).toEqual([JSON.stringify({ type: 'resize', cols: 80, rows: 24 })]);
  });

  it('ignores a frame in words that it does not know, and keeps drawing', async () => {
    const { socket, term } = draw();
    socket.opens();

    // What the replay is about to end with, and what a server further ahead
    // might say next. Neither is a reason to lose the terminal.
    socket.prints(0x68, 0x69);
    socket.says(JSON.stringify({ type: 'replayed' }));
    socket.says('not JSON at all');
    socket.prints(0x21);

    expect(await drawn(term)).toBe('hi!');
    expect(screen.getByTestId('terminal-pane')).toBeInTheDocument();
    expect(Socket.attached()).toHaveLength(1);
  });

  it('leaves one terminal and one socket when React mounts it twice', () => {
    render(
      <StrictMode>
        <TerminalPane shellId="shell-1" />
      </StrictMode>,
    );

    // Two of everything were built, which is the whole point of the double
    // mount: what matters is that only the second of each is still alive.
    expect(built).toHaveLength(2);
    expect(Socket.made).toHaveLength(2);

    expect(disposed).toEqual([built[0]]);
    expect(Socket.made[0].readyState).toBe(Socket.CLOSED);

    expect(Socket.attached()).toEqual([Socket.made[1]]);
    expect(screen.getByTestId('terminal-pane').querySelectorAll('.xterm')).toHaveLength(1);
  });

  it('lets go of the terminal, the socket and the observer when it leaves', () => {
    const { term, socket, unmount } = draw();
    socket.opens();
    expect(Watcher.live).toHaveLength(1);

    unmount();

    expect(disposed).toEqual([term]);
    expect(socket.readyState).toBe(Socket.CLOSED);
    expect(Watcher.live).toEqual([]);
    expect(screen.queryByTestId('terminal-pane')).not.toBeInTheDocument();
  });
});
