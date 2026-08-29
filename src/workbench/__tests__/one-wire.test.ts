/**
 * However much of the app is on screen, the window holds one connection.
 *
 * A browser allows six connections to one address across every window it has,
 * and an event stream never gives its slot back. The app used to open one per
 * feed, so two or three windows spent the whole budget and every ordinary read
 * queued behind streams that would never end — a screen stuck on loading until
 * it was reloaded (bw-zkh4). These are what stop that coming back: the count
 * itself, and the source rule that keeps the next connection from being opened
 * somewhere else.
 *
 * The connection is a socket, which a browser does not count against those six
 * at all — so windows no longer compete for the reads (bw-zkh4.10). That is
 * why nothing here may open an event stream either.
 */
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** One connection, as the browser would make it. */
class Stream {
  static open: Stream[] = [];
  static made = 0;

  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    Stream.made += 1;
    Stream.open.push(this);
  }

  close(): void {
    Stream.open = Stream.open.filter((s) => s !== this);
    this.onclose?.();
  }

  /** The server says something on this connection, on the feed named. */
  says(tag: string, data: string, scope?: string): void {
    this.onmessage?.(tagged(tag, data, scope));
  }

  /** The connection goes away under the window, rather than being hung up. */
  breaks(): void {
    Stream.open = Stream.open.filter((s) => s !== this);
    this.onerror?.();
    this.onclose?.();
  }

  static forget(): void {
    Stream.open = [];
    Stream.made = 0;
  }
}

vi.stubGlobal('WebSocket', Stream);

// eslint-disable-next-line import/first
import { forgetEverything, onBoard, onChat, onWorkbench, streamsOpen, watching } from '../live-wire';
// eslint-disable-next-line import/first
import { tagged } from './tagged';

/** Lets the wire finish reshaping, which it does once per paint rather than
 * once per hook. */
async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const SRC = join(__dirname, '..', '..');
/**
 * The files allowed to open a connection.
 *
 * The rule this list is the exception to is about the app's own news — the
 * board, the helper, the open chat — and about event streams, which are what
 * spent the budget of six. Everything that reads news reads it off the one
 * wire, and nothing else may open a second.
 *
 * A shell is the one thing that cannot be carried on it. Its socket belongs to
 * one shell rather than to the window, it comes and goes with the pane drawing
 * it rather than with what is on screen, and what it carries is raw bytes both
 * ways rather than tagged text — so multiplexing it onto the wire would mean
 * the wire carrying frames it must not decode, for a lifetime that is not its
 * own. It costs the reads nothing to open it separately, for the reason the
 * file comment above gives: a browser does not count sockets against the six.
 *
 * That is the whole of the exception. A second EventSource is still forbidden
 * everywhere, and so is a socket opened for anything the wire already carries.
 */
const MAY_OPEN_ONE = ['workbench/live-wire.ts', 'workbench/terminal-pane.tsx'];

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      sourceFiles(here, found);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(here);
    }
  }
  return found;
}

describe('one wire', () => {
  beforeEach(() => {
    forgetEverything();
    Stream.forget();
  });

  afterEach(() => {
    forgetEverything();
    vi.useRealTimers();
  });

  it('is the only place in the app that opens a connection', () => {
    const opening: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const where = relative(SRC, file).split('\\').join('/');
      if (MAY_OPEN_ONE.includes(where)) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/new\s+(EventSource|WebSocket)\s*\(/.test(line)) opening.push(`${where}:${i + 1}`);
        });
    }
    expect(opening).toEqual([]);
  });

  it('opens exactly one stream however many feeds are read', async () => {
    onBoard('/work/atelier', () => {});
    onWorkbench({ frame: () => {}, dropped: () => {} });
    onChat('abc', { snapshot: () => {}, event: () => {}, since: () => 0 });
    await settled();

    // One held, whatever the count of feeds — which is the whole point: what
    // the browser rations is connections open at once.
    expect(Stream.open).toHaveLength(1);
    expect(streamsOpen()).toBe(1);

    const asked = Stream.open[0].url;
    expect(asked).toContain('board=');
    expect(asked).toContain('workbench=1');
    expect(asked).toContain('chat=abc');
  });

  it('asks for nothing at all until something is watched', async () => {
    await settled();
    expect(streamsOpen()).toBe(0);
  });

  it('hands each feed to whoever asked for it, by tag', async () => {
    const boardSaw: string[] = [];
    const helperSaw: string[] = [];
    const chatSaw: string[] = [];
    const drawnFromScratch: string[] = [];

    onBoard('/work/atelier', (e) => boardSaw.push(e.path));
    onWorkbench({ frame: (d) => helperSaw.push(d), dropped: () => {} });
    onChat('abc', {
      snapshot: (d) => drawnFromScratch.push(d),
      event: (d) => chatSaw.push(d),
      since: () => 0,
    });
    await settled();

    const wire = Stream.open[0];
    wire.says('board', JSON.stringify({ path: '/work/atelier/.beads/issues.jsonl', type: 'modify' }));
    wire.says('workbench', '{"kind":"snapshot"}');
    wire.says('chat', '{"type":"text"}', 'abc');
    wire.says('chat.snapshot', '{"lastSeq":3}', 'abc');

    expect(boardSaw).toEqual(['/work/atelier/.beads/issues.jsonl']);
    expect(helperSaw).toEqual(['{"kind":"snapshot"}']);
    expect(chatSaw).toEqual(['{"type":"text"}']);
    expect(drawnFromScratch).toEqual(['{"lastSeq":3}']);
  });

  it('drops the previous chat’s last frame while the wire switches chats', async () => {
    const firstSaw: string[] = [];
    const secondSaw: string[] = [];
    const leaveFirst = onChat('first', {
      snapshot: () => {},
      event: (data) => firstSaw.push(data),
      since: () => 0,
    });
    await settled();
    const firstWire = Stream.open[0]!;

    // React removes one chat listener and adds the next in the same paint. The
    // reconnect is queued until that paint ends, so this is the exact interval
    // in which a final frame from `first` used to be handed to `second`.
    leaveFirst();
    onChat('second', {
      snapshot: () => {},
      event: (data) => secondSaw.push(data),
      since: () => 0,
    });
    firstWire.says('chat', 'belongs only to first', 'first');

    expect(firstSaw).toEqual([]);
    expect(secondSaw).toEqual([]);
    await settled();
    Stream.open[0]!.says('chat', 'belongs only to second', 'second');
    expect(secondSaw).toEqual(['belongs only to second']);
  });

  it('never hands a frame with another chat’s identity to the open chat', async () => {
    const saw: string[] = [];
    const snapshots: string[] = [];
    onChat('selected', {
      snapshot: (data) => snapshots.push(data),
      event: (data) => saw.push(data),
      since: () => 0,
    });
    await settled();

    Stream.open[0]!.says('chat', 'foreign sequence', 'some-other-chat');
    Stream.open[0]!.says('chat.snapshot', 'foreign snapshot', 'some-other-chat');
    Stream.open[0]!.says('chat', 'selected sequence', 'selected');
    Stream.open[0]!.says('chat.snapshot', 'selected snapshot', 'selected');

    expect(saw).toEqual(['selected sequence']);
    expect(snapshots).toEqual(['selected snapshot']);
  });

  it('drops an unowned chat frame instead of guessing from the active chat', async () => {
    const saw: string[] = [];
    onChat('selected', { snapshot: () => {}, event: (data) => saw.push(data), since: () => 0 });
    await settled();

    Stream.open[0]!.says('chat', 'has no owner');

    expect(saw).toEqual([]);
  });

  it('keeps one project’s board out of another’s', async () => {
    const mine: string[] = [];
    const theirs: string[] = [];
    onBoard('/work/atelier', (e) => mine.push(e.path));
    onBoard('/work/other', (e) => theirs.push(e.path));
    await settled();

    // One connection still, and both boards asked for on it.
    expect(streamsOpen()).toBe(1);
    expect(decodeURIComponent(Stream.open[0].url)).toContain('/work/atelier\n/work/other');

    Stream.open[0].says('board', JSON.stringify({ path: '/work/other/.beads/issues.jsonl', type: 'modify' }));
    expect(mine).toEqual([]);
    expect(theirs).toEqual(['/work/other/.beads/issues.jsonl']);
  });

  it('routes a board change written the Windows way to the project it belongs to', async () => {
    // The server builds the path it reports by joining onto the project path
    // this window sent it, so a Windows project reports back
    // `C:\work\atelier\.beads\issues.jsonl`. Looking only for a forward slash
    // after the project's name matched none of those, so the change was
    // dropped and the board went on not moving until the page was reloaded —
    // this job's own fault, left standing on one platform (bw-zkh4.13).
    const mine: string[] = [];
    const theirs: string[] = [];
    onBoard('C:\\work\\atelier', (e) => mine.push(e.path));
    onBoard('C:\\work\\atelier-two', (e) => theirs.push(e.path));
    await settled();

    Stream.open[0].says(
      'board',
      JSON.stringify({ path: 'C:\\work\\atelier\\.beads\\issues.jsonl', type: 'modify' }),
    );

    expect(mine, 'a Windows board change reached nobody').toEqual([
      'C:\\work\\atelier\\.beads\\issues.jsonl',
    ]);
    expect(theirs, 'a project whose name merely starts the same was told').toEqual([]);
  });

  it('never leaves two open while what is watched changes', async () => {
    const letGo = onBoard('/work/atelier', () => {});
    await settled();
    expect(Stream.open).toHaveLength(1);

    onChat('abc', { snapshot: () => {}, event: () => {}, since: () => 0 });
    await settled();
    expect(Stream.open).toHaveLength(1);
    expect(Stream.made).toBe(2);

    letGo();
    await settled();
    expect(Stream.open).toHaveLength(1);
    expect(watching()).toBe('chat=abc&since=0');
  });

  it('carries the number of the last thing the chat drew when it asks again', async () => {
    let drawn = 0;
    onChat('abc', { snapshot: () => {}, event: () => {}, since: () => drawn });
    await settled();
    expect(watching()).toContain('since=0');

    // The chat has drawn seven events; something else on screen then changes
    // what the window watches, so the connection is asked again.
    drawn = 7;
    onWorkbench({ frame: () => {}, dropped: () => {} });
    await settled();
    expect(watching()).toContain('since=7');
  });

  it('closes the connection when nothing on screen is watching', async () => {
    const letGo = onWorkbench({ frame: () => {}, dropped: () => {} });
    await settled();
    expect(streamsOpen()).toBe(1);

    letGo();
    await settled();
    expect(streamsOpen()).toBe(0);
    expect(Stream.open).toHaveLength(0);
  });

  it('tells its readers when the connection drops, and opens it again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let drops = 0;
    onWorkbench({ frame: () => {}, dropped: () => (drops += 1) });
    await settled();

    Stream.open[0].breaks();
    expect(drops).toBe(1);
    expect(streamsOpen()).toBe(0);

    vi.advanceTimersByTime(2_000);
    expect(streamsOpen()).toBe(1);
    expect(Stream.made).toBe(2);
  });
});
