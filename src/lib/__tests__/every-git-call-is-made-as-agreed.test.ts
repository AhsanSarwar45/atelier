/**
 * The Git panel's calls, against the route contract they were agreed on
 * (bw-8dp8.5).
 *
 * The server side of this was written at the same time as the panel and by
 * somebody else, against the list of routes on the card and nothing else. That
 * only works if both halves keep to it exactly, and a path or a field name that
 * drifted by one letter is a panel that is simply empty at runtime with nothing
 * on either side saying why. So the URL, the verb and the body of every one of
 * the ten calls are pinned here, in the words the card uses.
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

/** The one call that was made: where it went, how, and carrying what. */
function theCall(): { url: string; method: string; body: unknown } {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [url, options] = mockFetch.mock.calls[0];
  return {
    url: String(url),
    method: options.method ?? 'GET',
    body: options.body === undefined ? undefined : JSON.parse(options.body),
  };
}

const REPO = '/home/somebody/dev/a project';

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the reads', () => {
  it('asks for status at the agreed path, with the directory escaped', async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        branch: 'main',
        upstream: 'origin/main',
        ahead: 1,
        behind: 2,
        detached: false,
        staged: [{ path: 'a.ts', status: 'modified', origPath: null }],
        unstaged: [],
        untracked: [{ path: 'b.ts' }],
        conflicted: [],
      }),
    );

    const status = await api.git.status(REPO);

    const call = theCall();
    expect(call.method).toBe('GET');
    // A space in a project's path is ordinary and would otherwise cut the
    // query string in half.
    expect(call.url).toBe(`/api/git/status?path=${encodeURIComponent(REPO)}`);
    expect(status.branch).toBe('main');
    expect(status.untracked[0].path).toBe('b.ts');
  });

  it('asks for the log with a limit, and fifty of them unless told otherwise', async () => {
    mockFetch.mockResolvedValue(mockResponse({ commits: [] }));

    await api.git.log(REPO);

    expect(theCall().url).toBe(`/api/git/log?path=${encodeURIComponent(REPO)}&limit=50`);
  });

  it('carries the limit it was given', async () => {
    mockFetch.mockResolvedValue(mockResponse({ commits: [] }));

    await api.git.log(REPO, 20);

    expect(theCall().url).toContain('&limit=20');
  });

  it('asks for the branches at the agreed path', async () => {
    mockFetch.mockResolvedValue(mockResponse({ current: 'main', branches: [] }));

    await api.git.branches(REPO);

    expect(theCall().url).toBe(`/api/git/branches?path=${encodeURIComponent(REPO)}`);
  });
});

describe('the writes', () => {
  it('stages whole files by name', async () => {
    mockFetch.mockResolvedValue(mockResponse({ ok: true }));

    await api.git.stage(REPO, ['a.ts', 'src/b.ts']);

    expect(theCall()).toEqual({
      url: '/api/git/stage',
      method: 'POST',
      body: { path: REPO, files: ['a.ts', 'src/b.ts'] },
    });
  });

  it('unstages the same way', async () => {
    mockFetch.mockResolvedValue(mockResponse({ ok: true }));

    await api.git.unstage(REPO, ['a.ts']);

    expect(theCall()).toEqual({
      url: '/api/git/unstage',
      method: 'POST',
      body: { path: REPO, files: ['a.ts'] },
    });
  });

  it('commits under a message, and says nothing about amending unless asked', async () => {
    mockFetch.mockResolvedValue(mockResponse({ sha: 'deadbeef' }));

    const made = await api.git.commit(REPO, 'a message');

    expect(theCall()).toEqual({
      url: '/api/git/commit',
      method: 'POST',
      body: { path: REPO, message: 'a message' },
    });
    expect(made.sha).toBe('deadbeef');
  });

  it('asks to amend when it is asked to', async () => {
    mockFetch.mockResolvedValue(mockResponse({ sha: 'deadbeef' }));

    await api.git.commit(REPO, 'a message', true);

    expect(theCall().body).toEqual({ path: REPO, message: 'a message', amend: true });
  });

  it('checks out, and only says create when it means it', async () => {
    mockFetch.mockResolvedValue(mockResponse({ ok: true }));

    await api.git.checkout(REPO, 'a-branch', true);

    expect(theCall()).toEqual({
      url: '/api/git/checkout',
      method: 'POST',
      body: { path: REPO, branch: 'a-branch', create: true },
    });
  });
});

describe('the calls that reach the shared copy', () => {
  it('fetches, and gets back where the branch now stands', async () => {
    mockFetch.mockResolvedValue(mockResponse({ ahead: 3, behind: 0 }));

    const where = await api.git.fetch(REPO);

    expect(theCall()).toEqual({ url: '/api/git/fetch', method: 'POST', body: { path: REPO } });
    expect(where).toEqual({ ahead: 3, behind: 0 });
  });

  it('pulls', async () => {
    mockFetch.mockResolvedValue(mockResponse({ ok: true, output: 'Already up to date.' }));

    const said = await api.git.pull(REPO);

    expect(theCall()).toEqual({ url: '/api/git/pull', method: 'POST', body: { path: REPO } });
    expect(said.output).toBe('Already up to date.');
  });

  it('pushes, and can ask for an upstream for a branch that has none', async () => {
    mockFetch.mockResolvedValue(mockResponse({ ok: true, output: '' }));

    await api.git.push(REPO, true);

    expect(theCall()).toEqual({
      url: '/api/git/push',
      method: 'POST',
      body: { path: REPO, setUpstream: true },
    });
  });
});

describe('what git said when it refused', () => {
  it("reaches the caller in git's own words", async () => {
    const stderr =
      'To github.com:org/repo.git\n ! [rejected]        main -> main (non-fast-forward)\n' +
      "error: failed to push some refs to 'github.com:org/repo.git'";
    mockFetch.mockResolvedValue(mockResponse({ error: stderr }, 500));

    await expect(api.git.push(REPO)).rejects.toThrow(/non-fast-forward/);
  });
});

describe('what was said when the request never reached git', () => {
  /**
   * A request the server turns away before a handler runs — a half-sent body,
   * a body with no `path` in it, the wrong content type — used to arrive as the
   * framework's plain text, so the caller fell back to the status line and the
   * reader was shown "Unprocessable Entity" and nothing about why. The server
   * now answers those in the same `{ error }` shape as everything else
   * (bw-8dp8.8); this is the caller's half of that, and it must read the reason
   * out rather than the status line.
   */
  it('surfaces the reason, not the bare status line', async () => {
    const reason =
      'Failed to deserialize the JSON body into the target type: missing field `path` at line 1 column 2';
    mockFetch.mockResolvedValue(mockResponse({ error: reason }, 422, 'Unprocessable Entity'));

    const refused = await api.git.commit(REPO, 'a message').catch((e: Error) => e);

    expect(String(refused)).toContain('missing field `path`');
    expect(String(refused)).not.toContain('Unprocessable Entity');
  });

  it('surfaces a body the server could not read at all', async () => {
    const reason = 'Failed to parse the request body as JSON: EOF while parsing an object';
    mockFetch.mockResolvedValue(mockResponse({ error: reason }, 400, 'Bad Request'));

    const refused = await api.git.stage(REPO, ['a.ts']).catch((e: Error) => e);

    expect(String(refused)).toContain('Failed to parse the request body as JSON');
    expect(String(refused)).not.toContain('Bad Request');
  });
});
