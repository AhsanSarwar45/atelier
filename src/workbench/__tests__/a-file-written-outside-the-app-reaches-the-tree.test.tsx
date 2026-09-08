/**
 * A file written from a shell shows up in an open tree, without anybody asking
 * (bw-g3o3.3).
 *
 * The tab reads a directory once and draws it. Everything else that writes into
 * a checkout — a terminal, an agent, a build, a branch switch — used to leave
 * that drawing describing a folder that no longer existed. What closes the gap
 * is a folder watch on the server, carried on the window's one connection under
 * the tag `fs`, and `useFolderReads` on this side.
 *
 * The connection here is the fake one the wire's own cases use: a `WebSocket`
 * the test speaks for. So what is proved is the whole of this side of the wire —
 * the folder asked for in the connection's address, the frame the real server
 * sends being understood, the named directories being the only ones read again,
 * and the watch being let go when the tree goes. The server's half is proved
 * against a real filesystem in `server/src/routes/fs_watch.rs`, and the two
 * halves meeting in a browser is bw-g3o3.11's.
 */
import { useCallback, useEffect, useState } from 'react';

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** One connection, as the browser would make it. */
class Stream {
  static open: Stream[] = [];

  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    Stream.open.push(this);
  }

  close(): void {
    Stream.open = Stream.open.filter((s) => s !== this);
    this.onclose?.();
  }

  /** The connection goes away under the window, rather than being hung up. */
  breaks(): void {
    Stream.open = Stream.open.filter((s) => s !== this);
    this.onerror?.();
    this.onclose?.();
  }

  /** The server says something on this connection, on the feed named. */
  says(tag: string, data: string): void {
    this.onmessage?.(tagged(tag, data));
  }

  static forget(): void {
    Stream.open = [];
  }
}

vi.stubGlobal('WebSocket', Stream);

// eslint-disable-next-line import/first
import { forgetEverything, streamsOpen } from '@/workbench/live-wire';
// eslint-disable-next-line import/first
import { FOLDER_MS, useFolderReads } from '@/workbench/use-folder-reads';

// eslint-disable-next-line import/first
import { tagged } from './tagged';


const ROOT = '/work/atelier';

/** What is on disk, which a case writes to the way a shell would. */
const disk = new Map<string, string[]>();

/** Every set of directories the tree has read, in the order it read them. */
let readDirectories: string[][] = [];

/** Lets the wire finish reshaping, which it does once per paint. */
async function settled(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The directory a path is in — all a tree needs from a name that moved. */
function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

/**
 * A file tree, cut down to the part this card is about: it draws what a read
 * of a directory says, and it re-reads only the directories it is told moved.
 */
function Tree({ root }: { root: string }) {
  const [rows, setRows] = useState<string[]>([]);

  const draw = useCallback(
    async (moved: string[]) => {
      // Nothing named means "look again at what you draw" — the slow look, or
      // the window being come back to.
      const asked = moved.length === 0 ? [root] : Array.from(new Set(moved.map(directoryOf)));
      readDirectories.push(asked);
      const found = asked.flatMap((dir) => disk.get(dir) ?? []);
      setRows((had) => Array.from(new Set([...had, ...found])));
    },
    [root],
  );

  const readAgain = useFolderReads(root, draw);
  useEffect(() => {
    void readAgain();
  }, [readAgain]);

  return (
    <ul>
      {rows.map((row) => (
        <li key={row} data-testid="row">
          {row}
        </li>
      ))}
    </ul>
  );
}

/** Whatever the tab is currently pretending to be. */
function pretendTab(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

beforeEach(() => {
  forgetEverything();
  Stream.forget();
  disk.clear();
  disk.set(`${ROOT}/src`, []);
  readDirectories = [];
  pretendTab('visible');
});

afterEach(() => {
  forgetEverything();
  vi.useRealTimers();
  pretendTab('visible');
});

describe('a tree drawn from a folder follows that folder', () => {
  it('asks the window to watch the folder it is drawn from, and lets go with the tree', async () => {
    const drawn = render(<Tree root={ROOT} />);
    await settled();

    expect(streamsOpen(), 'the tree did not put a folder watch on the wire').toBe(1);
    expect(decodeURIComponent(Stream.open[0].url)).toContain(`fs=${ROOT}`);

    // The watcher dies with the socket, and the socket with the last thing
    // watching: nothing on screen, nothing held open on the server.
    drawn.unmount();
    await settled();

    expect(streamsOpen(), 'a folder watch was left running behind').toBe(0);
    expect(Stream.open).toHaveLength(0);
  });

  it('shows a file written from a shell, without the slow look coming round', async () => {
    render(<Tree root={ROOT} />);
    await settled();
    await waitFor(() => expect(readDirectories.length).toBeGreaterThan(0));
    expect(screen.queryAllByTestId('row')).toHaveLength(0);

    // Somebody runs `touch src/new.ts` in a terminal. The server's watcher
    // debounces the burst and names what moved, on the `fs` feed.
    disk.set(`${ROOT}/src`, [`${ROOT}/src/new.ts`]);
    readDirectories = [];
    await act(async () => {
      Stream.open[0].says('fs', JSON.stringify({ kind: 'changed', paths: [`${ROOT}/src/new.ts`] }));
    });

    await waitFor(() => expect(screen.getAllByTestId('row')).toHaveLength(1));
    expect(screen.getByTestId('row')).toHaveTextContent(`${ROOT}/src/new.ts`);

    // And only the one directory was read again — not the whole tree, which is
    // the entire reason the frame carries names at all.
    expect(readDirectories).toEqual([[`${ROOT}/src`]]);
  });

  it('watches the folder again when the connection dies, and reads what it missed', async () => {
    // The connection carrying the watch is the one thing between the tree and
    // the truth, and it dies: an overloaded machine, a laptop lid, a server
    // restarting after an update. Coming back is half of it — a watch that is
    // armed again while the drawing behind it still describes the moment the
    // connection died is a tree that has quietly stopped telling the truth,
    // and nothing on screen says so (bw-d35r.1).
    render(<Tree root={ROOT} />);
    await settled();
    await waitFor(() => expect(readDirectories.length).toBeGreaterThan(0));
    expect(decodeURIComponent(Stream.open[0].url)).toContain(`fs=${ROOT}`);

    // The short wait before the wire tries again, taken here rather than sat
    // through: only the clock is pretended, everything else is the real thing.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    // The connection goes away, and a file is written while it is gone. Nobody
    // is listening, so nothing is said about it.
    await act(async () => {
      Stream.open[0].breaks();
    });
    disk.set(ROOT, [`${ROOT}/written-in-the-dark.ts`]);
    readDirectories = [];
    expect(screen.queryAllByTestId('row')).toHaveLength(0);

    // The wire waits its short wait and opens another, asking for the same
    // folder rather than coming back watching nothing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(Stream.open, 'the connection never came back').toHaveLength(1);
    expect(decodeURIComponent(Stream.open[0].url), 'the folder watch was left off it').toContain(
      `fs=${ROOT}`,
    );

    // And the server says the watch is armed, which after an outage means
    // "look again at what you draw" — so the file written in the dark appears.
    await act(async () => {
      Stream.open[0].says('fs', '{"kind":"watching"}');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(readDirectories, 'the tree was never asked to look again').toEqual([[ROOT]]);
    expect(screen.getAllByTestId('row')).toHaveLength(1);
    expect(screen.getByTestId('row')).toHaveTextContent(`${ROOT}/written-in-the-dark.ts`);
  });

  it('does nothing for a frame that names nothing, and survives a garbled one', async () => {
    render(<Tree root={ROOT} />);
    await settled();
    await waitFor(() => expect(readDirectories.length).toBeGreaterThan(0));
    readDirectories = [];

    await act(async () => {
      // `watching` says only that the watcher is really behind the tab.
      Stream.open[0].says('fs', '{"kind":"watching"}');
      Stream.open[0].says('fs', '{"kind":"changed","paths":[]}');
      Stream.open[0].says('fs', 'not json at all');
    });

    expect(readDirectories, 'a frame with nothing in it made the tree read').toEqual([]);
    expect(streamsOpen(), 'one unreadable frame took the whole connection down').toBe(1);
  });
});

describe('the rule for keeping a drawing of a folder current', () => {
  it('asks for nothing without a folder to read', async () => {
    renderHook(() => useFolderReads(null, vi.fn().mockResolvedValue(undefined)));
    await settled();
    expect(streamsOpen()).toBe(0);
  });

  it('queues one more read for a burst, and hands it every name the burst carried', async () => {
    let answer: () => void = () => {};
    const seen: string[][] = [];
    const read = vi.fn().mockImplementation((moved: string[]) => {
      seen.push(moved);
      return new Promise<void>((settle) => (answer = () => settle()));
    });
    const drawn = renderHook(() => useFolderReads(ROOT, read));
    const readAgain = drawn.result.current;

    void readAgain([`${ROOT}/src/one.ts`]);
    expect(read).toHaveBeenCalledTimes(1);

    // A branch switch writes a burst; each frame asks, and none of them starts
    // a second run over the first.
    void readAgain([`${ROOT}/src/two.ts`]);
    void readAgain([`${ROOT}/docs/three.md`]);
    expect(read).toHaveBeenCalledTimes(1);

    read.mockImplementation(async (moved: string[]) => {
      seen.push(moved);
    });
    await act(async () => {
      answer();
    });

    // One more read for the whole burst, not two — carrying both names, so
    // nothing a burst said is quietly dropped.
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(seen).toEqual([[`${ROOT}/src/one.ts`], [`${ROOT}/src/two.ts`, `${ROOT}/docs/three.md`]]);
  });

  it('looks slowly for whatever the watcher could not see', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useFolderReads(ROOT, read));

    await vi.advanceTimersByTimeAsync(FOLDER_MS);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith([]);
  });

  it('reads nothing while the tab is hidden, and once the moment it is looked at again', async () => {
    vi.useFakeTimers();
    pretendTab('hidden');
    const read = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useFolderReads(ROOT, read));

    await vi.advanceTimersByTimeAsync(FOLDER_MS * 3);
    expect(read, 'a tab nobody is looking at was reading the disk anyway').not.toHaveBeenCalled();

    pretendTab('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('looks again when the window is come back to', async () => {
    const read = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useFolderReads(ROOT, read));

    await act(async () => {
      fireEvent.focus(window);
    });

    expect(read).toHaveBeenCalledTimes(1);
  });
});
