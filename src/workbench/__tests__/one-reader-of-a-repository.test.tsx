/**
 * The tree and the rail beside it share one `git status` (bw-o5i3.4).
 *
 * Both are drawn from the same answer, and both keep themselves current by the
 * same rule — the watch on the git directory, plus the slow look every five
 * seconds for an edit no watcher can see. Each used to ask git for itself, so
 * the Files tab ran two `git status` over one repository, a few milliseconds
 * apart, twice every five seconds, for as long as it was open.
 *
 * What makes that worth fixing is not the git run, which is quick, but what it
 * answers with: `--untracked-files=all` names every untracked path one by one,
 * and on a checkout whose `.gitignore` does not cover its virtualenv and its
 * build output that is thousands of paths of JSON, parsed and turned into a
 * map, twice over.
 *
 * So the count asserted here is the count of calls, and the other half of the
 * rule is asserted too: a read a person asked for still runs git, because the
 * whole point of reading again after a commit is to see the commit.
 */
import { act, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/** Every `git status` that actually reached git, in order. */
const ran: string[] = [];

vi.mock('@/lib/api', async (real) => {
  const actual = await real<typeof import('@/lib/api')>();
  return {
    ...actual,
    fs: { ...actual.fs, tree: async (dir: string) => ({ dir, entries: [] }), watch: () => () => {} },
    git: {
      ...actual.git,
      status: async (path: string) => {
        ran.push(path);
        return blank();
      },
      log: async () => ({ commits: [] }),
      branches: async () => ({ branches: [] }),
      watch: () => () => {},
    },
  };
});

// eslint-disable-next-line import/first
import type { GitStatus } from '@/lib/api';
// eslint-disable-next-line import/first
import FileTree from '@/workbench/file-tree';
// eslint-disable-next-line import/first
import { GitView } from '@/workbench/git-view';
// eslint-disable-next-line import/first
import { forgetRepositoryStatus, readRepositoryStatus } from '@/workbench/repository-status';
// eslint-disable-next-line import/first
import { WORKING_TREE_MS } from '@/workbench/use-repository-reads';

const REPO = '/work/a-project';

function blank(): GitStatus {
  return {
    branch: 'main',
    upstream: null,
    pushTo: null,
    ahead: 0,
    behind: 0,
    detached: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
}

/** The virtualisers below want a viewport; jsdom has no layout to give them. */
beforeAll(() => {
  for (const [side, size] of [['offsetHeight', 600], ['clientHeight', 600], ['offsetWidth', 320], ['clientWidth', 320]] as const) {
    Object.defineProperty(HTMLElement.prototype, side, { configurable: true, get: () => size });
  }
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 320, height: 600, top: 0, left: 0, right: 320, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  HTMLElement.prototype.scrollTo = () => {};
});

beforeEach(() => {
  ran.length = 0;
  forgetRepositoryStatus();
});

afterEach(() => {
  vi.useRealTimers();
});

async function settled(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('one reader of a repository', () => {
  it('runs git once for a slow look the tree and the rail both take', async () => {
    // The clock is taken over before either of them is drawn, so that the two
    // five-second intervals this puts on it are intervals this test can wind
    // on. Vitest's fake clock moves `Date.now` with the timers, which is what
    // the held answer is dated by.
    vi.useFakeTimers();
    render(
      <>
        <FileTree root={REPO} selected={null} onOpen={() => {}} />
        <GitView path={REPO} />
      </>,
    );
    await settled();
    expect(ran.length).toBeGreaterThan(0);
    ran.length = 0;

    // The slow look, which both of them take: each asks, one of them runs git,
    // and the other is given that answer.
    await act(async () => {
      vi.advanceTimersByTime(WORKING_TREE_MS);
    });
    await settled();

    expect(ran).toEqual([REPO]);
  }, 30_000);

  it('still runs git for a read somebody asked for', async () => {
    await readRepositoryStatus(REPO);
    ran.length = 0;

    await readRepositoryStatus(REPO); // Quiet, and moments later: held.
    expect(ran).toEqual([]);

    await readRepositoryStatus(REPO, { fresh: true }); // A refresh, a commit.
    expect(ran).toEqual([REPO]);
  });

  it('keeps one repository out of the answer to another', async () => {
    await readRepositoryStatus('/work/one');
    await readRepositoryStatus('/work/two');
    expect(ran).toEqual(['/work/one', '/work/two']);
  });
});
