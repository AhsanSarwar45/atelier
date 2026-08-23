/**
 * However much of the app is on screen, the window holds one connection.
 *
 * A browser allows six connections to one address across every window it has,
 * and an event stream never gives its slot back. The app used to open one per
 * feed, so two or three windows spent the whole budget and every ordinary read
 * queued behind streams that would never end — a screen stuck on loading until
 * it was reloaded (bw-zkh4). These are what stop that coming back: the count
 * itself, and the source rule that keeps the next stream from being opened
 * somewhere else.
 */
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** One connection, as the browser would make it. */
class Stream {
  static open: Stream[] = [];
  static made = 0;

  readonly heard = new Map<string, ((e: MessageEvent) => void)[]>();
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    Stream.made += 1;
    Stream.open.push(this);
  }

  addEventListener(name: string, fn: (e: MessageEvent) => void): void {
    this.heard.set(name, [...(this.heard.get(name) ?? []), fn]);
  }

  close(): void {
    Stream.open = Stream.open.filter((s) => s !== this);
  }

  /** The server says something on this connection. */
  says(name: string, data: string): void {
    (this.heard.get(name) ?? []).forEach((fn) => fn({ data } as MessageEvent));
  }

  /** The connection goes away. */
  breaks(): void {
    this.close();
    this.onerror?.();
  }

  static forget(): void {
    Stream.open = [];
    Stream.made = 0;
  }
}

vi.stubGlobal('EventSource', Stream);

// eslint-disable-next-line import/first
import { forgetEverything, onBoard, onChat, onWorkbench, streamsOpen, watching } from '../live-wire';

/** Lets the wire finish reshaping, which it does once per paint rather than
 * once per hook. */
async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const SRC = join(__dirname, '..', '..');
/** The one file allowed to open a connection. */
const THE_WIRE = 'workbench/live-wire.ts';

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
      if (where === THE_WIRE) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/new\s+EventSource\s*\(/.test(line)) opening.push(`${where}:${i + 1}`);
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
    wire.says('chat', '{"type":"text"}');
    wire.says('chat.snapshot', '{"lastSeq":3}');

    expect(boardSaw).toEqual(['/work/atelier/.beads/issues.jsonl']);
    expect(helperSaw).toEqual(['{"kind":"snapshot"}']);
    expect(chatSaw).toEqual(['{"type":"text"}']);
    expect(drawnFromScratch).toEqual(['{"lastSeq":3}']);
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
