/**
 * Every read goes through the app's one reader, and that reader has a deadline.
 *
 * A read written straight against the browser carries no deadline, and a read
 * with no deadline can simply never settle — queued behind a stream that never
 * ends, or sitting on a socket whose peer had quietly gone. The screen waiting
 * on it drew a spinner until the page was reloaded (bw-zkh4). The source test
 * below is what stops the next one being written that way.
 */
import { readFileSync, readdirSync } from 'fs';
import { join, relative } from 'path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { request, reachable, DEADLINE_MS } from '../api'; // eslint-disable-line import/first

const SRC = join(__dirname, '..', '..');

/** The reader itself is the one place allowed to ask the browser directly. */
const THE_READER = 'lib/api.ts';

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

describe('one reader', () => {
  it('is the only place in the app that asks the browser for anything', () => {
    const asking: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const where = relative(SRC, file).split('\\').join('/');
      if (where === THE_READER) continue;
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/(^|[^.\w])fetch\s*\(/.test(line)) asking.push(`${where}:${i + 1}`);
      });
    }
    expect(asking).toEqual([]);
  });
});

describe('every read carries a deadline', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('waits ten seconds unless the caller says otherwise', () => {
    expect(DEADLINE_MS).toBe(10_000);
  });

  it('gives up on a read that is never answered, rather than hanging', async () => {
    mockFetch.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_answered, gaveUp) => {
        init.signal?.addEventListener('abort', () => gaveUp(init.signal?.reason));
      }),
    );

    await expect(request('/api/anything', { deadlineMs: 20 })).rejects.toThrow(
      /no answer from the app/,
    );
  });

  it('says why in words a screen can draw, not as an abort nobody prints', async () => {
    mockFetch.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_answered, gaveUp) => {
        init.signal?.addEventListener('abort', () => gaveUp(init.signal?.reason));
      }),
    );

    const why = await request('/api/anything', { deadlineMs: 20 }).catch((e: unknown) =>
      e instanceof Error ? e.message : String(e),
    );
    expect(why).toContain('it may be stopped, or busy');
  });

  it('leaves a caller that cancels its own read its own words', async () => {
    const mine = new AbortController();
    mockFetch.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_answered, gaveUp) => {
        init.signal?.addEventListener('abort', () => gaveUp(new Error('the caller let it go')));
      }),
    );

    const journey = request('/api/anything', { deadlineMs: 5_000, signal: mine.signal });
    mine.abort();
    await expect(journey).rejects.toThrow('the caller let it go');
  });

  it('does not disturb a read that answers in time', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response);
    const res = await request('/api/anything');
    expect(res.ok).toBe(true);
  });

  it('reports a server that never answers as simply not there', async () => {
    mockFetch.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_answered, gaveUp) => {
        init.signal?.addEventListener('abort', () => gaveUp(init.signal?.reason));
      }),
    );
    expect(await reachable('/api/health', 20)).toBe(false);
  });

  it('reports a server that refuses as there all the same', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 } as Response);
    expect(await reachable('/api/health', 5_000)).toBe(true);
  });
});
