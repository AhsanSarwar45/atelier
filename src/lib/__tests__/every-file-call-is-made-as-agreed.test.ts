/**
 * The file browser's reads, against the route contract they were agreed on
 * (bw-g3o3.2).
 *
 * The server half of these was written against the card and nothing else, and
 * a field name that drifts by one letter is a tree that draws nothing with
 * neither side saying why. So the URL of each call and every field of each
 * answer are pinned here, in the words the card uses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch globally before importing the module
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import after mocking fetch — must come after vi.stubGlobal
import * as api from '../api'; // eslint-disable-line import/first

function mockResponse(data: unknown, status = 200, statusText?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusText ?? (status === 200 ? 'OK' : 'Error'),
    headers: new Headers(),
    json: () => Promise.resolve(data),
  } as Response;
}

/** The one call that was made: where it went and how. */
function theCall(): { url: string; method: string } {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [url, options] = mockFetch.mock.calls[0];
  return { url: String(url), method: options?.method ?? 'GET' };
}

// A space in a project's path is ordinary and would otherwise cut the query
// string in half.
const DIR = '/home/somebody/dev/a project';

/** Whether aborting `stop` aborts the signal the one call was made with. */
function cancelReaches(stop: AbortController): boolean {
  const carried = mockFetch.mock.calls[0][1].signal as AbortSignal;
  if (carried.aborted) return false;
  stop.abort();
  return carried.aborted;
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('one level of a directory', () => {
  it('asks at the agreed path, with the directory escaped', async () => {
    mockFetch.mockResolvedValue(mockResponse({ dir: DIR, entries: [] }));

    await api.fs.tree(DIR);

    const call = theCall();
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`/api/fs/tree?dir=${encodeURIComponent(DIR)}`);
  });

  it('reads back every field of an entry', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        dir: DIR,
        entries: [
          {
            name: 'src',
            path: `${DIR}/src`,
            kind: 'dir',
            size: 4096,
            mtime: 1757260800000,
            ignored: false,
            hidden: false,
          },
          {
            name: 'node_modules',
            path: `${DIR}/node_modules`,
            kind: 'dir',
            size: 4096,
            mtime: 1757260800000,
            ignored: true,
            hidden: false,
          },
          {
            name: '.env',
            path: `${DIR}/.env`,
            kind: 'file',
            size: 12,
            mtime: 1757260800000,
            ignored: false,
            hidden: true,
          },
          {
            name: 'latest',
            path: `${DIR}/latest`,
            kind: 'link',
            size: 9,
            mtime: 1757260800000,
            ignored: false,
            hidden: false,
          },
        ],
      }),
    );

    const listed = await api.fs.tree(DIR);

    expect(listed.dir).toBe(DIR);
    // Ignored entries come back listed and flagged. A tree that was simply
    // not told about them could not offer to show them.
    expect(listed.entries[1].ignored).toBe(true);
    // `hidden` says only that the name starts with a dot — it is not the same
    // thing as ignored, and the two are read separately.
    expect(listed.entries[2].hidden).toBe(true);
    expect(listed.entries[2].ignored).toBe(false);
    // The three kinds the tree draws different icons for.
    expect(listed.entries.map((e) => e.kind)).toEqual(['dir', 'dir', 'file', 'link']);
    expect(listed.entries[3].size).toBe(9);
    expect(listed.entries[3].mtime).toBe(1757260800000);
  });

  it('carries a cancel when it is given one', async () => {
    mockFetch.mockResolvedValue(mockResponse({ dir: DIR, entries: [] }));
    const stop = new AbortController();

    await api.fs.tree(DIR, stop.signal);

    // The signal fetch is handed is the caller's own joined to the deadline,
    // so what is pinned is that the caller's cancel still reaches it.
    expect(cancelReaches(stop)).toBe(true);
  });
});

describe('reading a file', () => {
  const FILE = `${DIR}/src/main.ts`;

  it('asks at the agreed path, with the file escaped', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ kind: 'text', text: '', truncated: false, size: 0, sha256: '', mtime: 0 }),
    );

    await api.fs.read(FILE);

    const call = theCall();
    expect(call.method).toBe('GET');
    expect(call.url).toBe(`/api/fs/read?path=${encodeURIComponent(FILE)}`);
  });

  it('reads back the text, the cut and the digest of what was read', async () => {
    const sha = 'a'.repeat(64);
    mockFetch.mockResolvedValue(
      mockResponse({
        kind: 'text',
        text: 'export const x = 1;\n',
        truncated: false,
        size: 20,
        sha256: sha,
        mtime: 1757260800000,
      }),
    );

    const read = await api.fs.read(FILE);

    expect(read.kind).toBe('text');
    expect(read.text).toBe('export const x = 1;\n');
    expect(read.truncated).toBe(false);
    expect(read.size).toBe(20);
    // The digest is of the bytes that came back, which is what a later write
    // has to name to prove it is replacing the text it was shown.
    expect(read.sha256).toBe(sha);
    expect(read.mtime).toBe(1757260800000);
  });

  it('is told when the text was cut short', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        kind: 'text',
        text: 'x'.repeat(8),
        truncated: true,
        size: 3 * 1024 * 1024,
        sha256: 'b'.repeat(64),
        mtime: 1757260800000,
      }),
    );

    const read = await api.fs.read(`${DIR}/huge.txt`);

    expect(read.truncated).toBe(true);
    // The size is the file's, not the part that was sent.
    expect(read.size).toBe(3 * 1024 * 1024);
  });

  /**
   * A file the viewer cannot show is still an answer: 200 with `binary` on
   * it, so the viewer says what it is and how big rather than showing the
   * failure of a read that did not fail.
   */
  it('takes a binary file as an answer and not as a refusal', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ kind: 'binary', size: 40960, mtime: 1757260800000 }),
    );

    const read = await api.fs.read(`${DIR}/logo.png`);

    expect(read.kind).toBe('binary');
    expect(read.size).toBe(40960);
    expect(read.text).toBeUndefined();
    expect(read.sha256).toBeUndefined();
  });

  it('carries a cancel when it is given one', async () => {
    mockFetch.mockResolvedValue(mockResponse({ kind: 'binary', size: 1, mtime: 0 }));
    const stop = new AbortController();

    await api.fs.read(FILE, stop.signal);

    expect(cancelReaches(stop)).toBe(true);
  });
});

describe('what the server said when it refused', () => {
  it('reaches the caller in the server own words', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({ error: 'Access denied: path must be within home directory' }, 403),
    );

    await expect(api.fs.tree('/etc')).rejects.toThrow(/within home directory/);
  });
});
