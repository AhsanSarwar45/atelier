/**
 * What the tabs promise: each holds its own shell, a tab that is not showing is
 * still running, and a reload comes back attached to the shells that are still
 * there.
 *
 * The terminals here are the real ones, for the same reason the pane's own
 * cases use them: what a hidden tab keeps is the state of a real xterm — its
 * buffer and where in that buffer it is scrolled to — and a stand-in that kept
 * nothing would prove nothing. Two things are stood in for, both because jsdom
 * does not have them: the socket, and the server behind `fetch`. Layout is the
 * third thing jsdom does not have, which is why nothing here asks how big
 * anything is; a hidden tab is hidden by an attribute the page understands, not
 * by a class no stylesheet in this bench has read.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useShowingFolder, useTerminalShells } from '@/workbench/terminal-shells';
import { Terminals } from '@/workbench/terminal-tabs';

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

  opens(): void {
    this.readyState = Socket.OPEN;
    this.onopen?.();
  }

  /**
   * The shell prints something: one binary frame, exactly as it came.
   *
   * Copied into this file's own `Uint8Array` before it is handed over, because
   * the `TextEncoder` jsdom gives out is Node's and what it makes belongs to
   * another realm — where the pane asks whether a frame `instanceof ArrayBuffer`,
   * a buffer from over there answers no however plainly it is one. A browser has
   * one realm and would not know the difference.
   */
  prints(text: string): void {
    this.onmessage?.({ data: new Uint8Array(new TextEncoder().encode(text)).buffer });
  }

  static forget(): void {
    Socket.made = [];
  }
}

/** One call the app made, in the terms it made it in. */
type Call = { url: string; method: string; body?: Record<string, unknown> };

/** Every terminal built, in the order the panes built them. */
const built: Terminal[] = [];
const disposed: Terminal[] = [];
const reallyOpen = Terminal.prototype.open;
const reallyDispose = Terminal.prototype.dispose;

/** What the app asked the server for, and what the server had. */
let calls: Call[] = [];
let running: { id: string; cwd: string; started: string; exited: boolean }[] = [];
let opened = 0;

/** The shape of an answer, with only the parts anything here reads. */
const answers = (body: unknown, ok = true) =>
  ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as unknown as Response;

/** One shell as the server lists it. */
const shell = (id: string, cwd: string, exited = false) => ({
  id,
  cwd,
  started: '2026-08-29T10:00:00Z',
  exited,
});

beforeEach(() => {
  Socket.forget();
  built.length = 0;
  disposed.length = 0;
  calls = [];
  running = [];
  opened = 0;

  vi.stubGlobal('WebSocket', Socket);
  // The renderer asks for this the moment a terminal opens, and the window asks
  // it which kind of screen this is. jsdom answers no media queries at all.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({
      url,
      method,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
    });
    if (method === 'POST') return answers({ id: `opened-${(opened += 1)}` });
    if (method === 'DELETE') return answers('');
    return answers(running);
  });

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
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * The button on the bar, standing in for it.
 *
 * The bar's own is in `src/components/shell.tsx` and has its own case; what it
 * does is this, and saying which folder the screen is showing is what the
 * project screen does with the same hook.
 */
function Bar({ folder = null }: { folder?: string | null }) {
  const { show, hide } = useTerminalShells();
  useShowingFolder(folder);
  return (
    <>
      <button type="button" onClick={show}>
        open the terminal
      </button>
      <button type="button" onClick={hide}>
        close it from somewhere else
      </button>
    </>
  );
}

/** The app, with the window opened and everything it opened settled. */
async function open(folder: string | null = null) {
  const drawn = render(
    <Terminals>
      <Bar folder={folder} />
    </Terminals>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'open the terminal' }));
  await screen.findByTestId('terminal-window');
  await waitFor(() => expect(screen.getAllByTestId('terminal-tab').length).toBeGreaterThan(0));
  return drawn;
}

/** The tabs on the strip, in the order they are drawn. */
const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent);

/** Which tab is in front. */
const showing = () => screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true');

/** The body of one shell's tab, whether or not it is the one showing. */
const bodyOf = (id: string) =>
  screen.getAllByTestId('terminal-tab-body').find((body) => body.dataset.shell === id);

/**
 * The terminal and the socket one shell's pane built.
 *
 * The pane opens its terminal and then its socket, so the two are made in step
 * and the socket is the only one of the pair that says which shell it is for.
 * Asking this way is also how a case notices a pane that was rebuilt: a rebuild
 * makes a second pair, and the pair this returns is the last one made.
 */
function paneFor(id: string) {
  const at = Socket.made.map((s, i) => ({ s, i })).filter(({ s }) => s.url.includes(id)).pop();
  if (!at) throw new Error(`no pane ever attached to ${id}`);
  return { socket: at.s, term: built[at.i], builds: Socket.made.filter((s) => s.url.includes(id)).length };
}

/**
 * The box the terminal is scrolled inside of — xterm's own, and the element a
 * browser puts the scroll position on.
 */
function scrollbox(id: string): HTMLElement {
  const box = bodyOf(id)?.querySelector('.xterm-viewport');
  if (!box) throw new Error(`the pane for ${id} drew nothing to scroll`);
  return box as HTMLElement;
}

/**
 * Waits for everything written so far to have been applied. xterm applies what
 * it is given on its own schedule and calls back in order, so a callback on an
 * empty write is a callback after everything written before it.
 */
const written = (term: Terminal) => new Promise<void>((done) => term.write('', () => done()));

/** Everything the app has said to the server about shells. */
const asked = (method: string) => calls.filter((call) => call.method === method);

describe('the terminal window’s tabs', () => {
  it('comes back with a tab for every shell still running, and none for one that has ended', async () => {
    running = [
      shell('live-1', '/home/ahsan/dev/corsetta'),
      shell('gone-1', '/home/ahsan/dev/atelier', true),
      shell('live-2', '/home/ahsan/dev/beads-web'),
    ];

    await open();

    expect(tabNames(), 'the shells the server still has, and only those').toEqual(['corsetta', 'beads-web']);
    expect(showing()?.textContent, 'the last one started is the one to come back to').toBe('beads-web');
    expect(
      asked('POST'),
      'the server already had shells, so there was nothing to start',
    ).toHaveLength(0);
    expect(bodyOf('gone-1'), 'a tab for a shell that has ended is a tab nobody can type into').toBeUndefined();
  });

  it('keeps a hidden tab’s terminal, its socket and where it was scrolled to', async () => {
    running = [shell('live-1', '/home/ahsan/dev/corsetta'), shell('live-2', '/home/ahsan/dev/beads-web')];
    await open();

    fireEvent.click(screen.getByRole('tab', { name: 'corsetta' }));
    const first = paneFor('live-1');
    first.socket.opens();

    // More than a screenful, so there is a scrollback to be somewhere in.
    first.socket.prints(Array.from({ length: 100 }, (_, n) => `line ${n}\r\n`).join(''));
    await written(first.term);
    expect(first.term.buffer.active.baseY, 'the shell printed more than fits').toBeGreaterThan(0);

    // Scrolled by putting the box where a wheel would put it. jsdom lays
    // nothing out, so the wheel itself cannot be turned and the buffer's view
    // does not follow — but the position lives on this element either way, and
    // this element is what a rebuilt pane would replace with a fresh one.
    const box = scrollbox('live-1');
    box.scrollTop = 240;

    fireEvent.click(screen.getByRole('tab', { name: 'beads-web' }));

    expect(bodyOf('live-1'), 'a tab that is not showing is still drawn, only hidden').toBeInTheDocument();
    expect(bodyOf('live-1')?.hidden, 'and it is hidden by the page’s own rule').toBe(true);
    expect(bodyOf('live-2')?.hidden, 'while the one in front is not').toBe(false);
    expect(
      first.socket.readyState,
      'a hidden tab that let go of its socket is a shell nobody is listening to',
    ).not.toBe(Socket.CLOSED);
    expect(disposed, 'and nothing was torn down to hide it').toEqual([]);

    fireEvent.click(screen.getByRole('tab', { name: 'corsetta' }));
    const again = paneFor('live-1');

    expect(again.builds, 'coming back to a tab must not build it a second time').toBe(1);
    expect(again.term, 'it is the same terminal, not one that looks like it').toBe(first.term);
    expect(scrollbox('live-1'), 'and the same box, not a fresh one at the bottom').toBe(box);
    expect(scrollbox('live-1').scrollTop, 'still scrolled where it was left').toBe(240);
    expect(
      again.term.buffer.active.getLine(0)?.translateToString(true),
      'with everything the shell had printed still in it',
    ).toBe('line 0');
  });

  it('starts a new shell in the folder the screen is showing', async () => {
    await open('/home/ahsan/dev/corsetta');

    const [posted] = asked('POST');
    expect(posted.url, 'a shell is opened over HTTP, not by connecting to one').toContain('/api/terminal');
    expect(posted.body, 'the browser sends the folder it is showing, and the shape to start at').toEqual({
      cwd: '/home/ahsan/dev/corsetta',
      cols: 80,
      rows: 24,
    });
    expect(tabNames(), 'and the tab is called after the folder it is in').toEqual(['corsetta']);
  });

  it('names no folder at all when there is no project on screen', async () => {
    await open(null);

    const [posted] = asked('POST');
    expect(
      Object.keys(posted.body ?? {}),
      'an empty folder is a folder the server has to interpret; leaving it out is what asks for home',
    ).not.toContain('cwd');
    expect(posted.body, 'nothing but the shape it starts at').toEqual({ cols: 80, rows: 24 });
    expect(tabNames(), 'a shell at home is called what home is called').toEqual(['~']);
  });

  it('closes the one shell whose tab was closed, and no other', async () => {
    running = [shell('live-1', '/home/ahsan/dev/corsetta'), shell('live-2', '/home/ahsan/dev/beads-web')];
    await open();
    const second = paneFor('live-2');

    fireEvent.click(
      within(screen.getAllByTestId('terminal-tab')[0]).getByRole('button', {
        name: 'Close the shell in /home/ahsan/dev/corsetta',
      }),
    );

    await waitFor(() => expect(asked('DELETE')).toHaveLength(1));
    expect(asked('DELETE')[0].url, 'the shell that was asked for, and only it').toContain('live-1');
    expect(asked('DELETE')[0].url, 'never the one beside it').not.toContain('live-2');
    expect(tabNames(), 'the tab goes with it').toEqual(['beads-web']);
    expect(bodyOf('live-1'), 'and so does its pane').toBeUndefined();
    expect(second.socket.readyState, 'the other shell is untouched').not.toBe(Socket.CLOSED);
  });

  it('closes no shell at all when the window itself is closed', async () => {
    running = [shell('live-1', '/home/ahsan/dev/corsetta'), shell('live-2', '/home/ahsan/dev/beads-web')];
    await open();
    const first = paneFor('live-1');
    const second = paneFor('live-2');

    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal' }));

    expect(
      asked('DELETE'),
      'shutting a window is not finishing with what is running in it: the shells outlive it',
    ).toEqual([]);
    expect(first.socket.readyState, 'and nothing let go of its socket either').not.toBe(Socket.CLOSED);
    expect(second.socket.readyState, 'nor the second').not.toBe(Socket.CLOSED);
    expect(screen.getByTestId('terminal-window').className, 'the window is out of sight').toContain('hidden');

    fireEvent.click(screen.getByRole('button', { name: 'open the terminal' }));

    expect(paneFor('live-1').term, 'and opening it again finds the same terminals').toBe(first.term);
    expect(asked('GET'), 'with nothing asked of the server, because nothing was lost').toHaveLength(1);
    expect(asked('POST'), 'and no new shell started beside the ones already there').toEqual([]);
  });

  it('closes the window when the last tab is closed, and starts fresh when it is opened again', async () => {
    running = [shell('live-1', '/home/ahsan/dev/corsetta')];
    await open('/home/ahsan/dev/corsetta');

    fireEvent.click(
      screen.getByRole('button', { name: 'Close the shell in /home/ahsan/dev/corsetta' }),
    );

    await waitFor(() => expect(screen.queryByTestId('terminal-window')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'open the terminal' }));
    await waitFor(() => expect(asked('POST')).toHaveLength(1));
    expect(tabNames(), 'a window opened with nothing in it opens a shell').toEqual(['corsetta']);
    expect(asked('GET'), 'and the server is not asked twice what it has').toHaveLength(1);
  });
});
