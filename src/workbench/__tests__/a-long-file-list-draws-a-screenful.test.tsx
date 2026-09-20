/**
 * A section of thousands of files draws a screenful of them (bw-o5i3.1).
 *
 * `git status --untracked-files=all` names every untracked path one by one, so
 * a checkout whose `.gitignore` does not cover its virtualenv, its caches and
 * its build output answers with thousands. The rail used to draw a row for
 * each: 5,099 untracked paths on one real project left 81,661 nodes in the
 * document and took 6,245 ms, against 141 nodes and 68 ms for a checkout with
 * four. It happened with the rail SHUT, in the Files tab and the Chat tab
 * alike, and again every five seconds for as long as either was open — which
 * is why both tabs of that one project were unusable.
 *
 * What is asserted here is the count in the document, not the clock: a row
 * count is the same number on every machine, and it is the thing the clock was
 * a symptom of. The clock is checked too, well above where a fast machine
 * lands and far below where the fault was, so a regression that puts the rows
 * back is caught by both.
 */
import { render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { GitStatus } from '@/lib/api';
import { GitView } from '@/workbench/git-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const calls = vi.hoisted(() => ({
  status: vi.fn(),
  log: vi.fn(),
  branches: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
  commit: vi.fn(),
  fetch: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
  checkout: vi.fn(),
  watch: vi.fn(() => () => {}),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const REPO = '/tmp/a-project';

/**
 * jsdom has no layout, so every box is nought high — and a virtualiser told its
 * viewport is nought high draws no rows at all. Lending the bench a viewport is
 * what makes the panel under test the panel a browser would draw. The same 600
 * the file tree's bench lends next door.
 */
beforeAll(() => {
  for (const [side, size] of [['offsetHeight', 600], ['clientHeight', 600], ['offsetWidth', 320], ['clientWidth', 320]] as const) {
    Object.defineProperty(HTMLElement.prototype, side, { configurable: true, get: () => size });
  }
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 320, height: 600, top: 0, left: 0, right: 320, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  HTMLElement.prototype.scrollTo = () => {};
});

/** The shape `--untracked-files=all` answers with, at whatever length. */
function untrackedStatus(howMany: number): GitStatus {
  return {
    branch: 'main',
    upstream: 'origin/main',
    pushTo: null,
    ahead: 0,
    behind: 0,
    detached: false,
    staged: [],
    unstaged: [],
    conflicted: [],
    untracked: Array.from({ length: howMany }, (_, at) => ({
      path: `assets/source/thing-${at}/file-${at}.blend`,
    })),
  } as unknown as GitStatus;
}

/** The panel, drawn against a status of the given length, and how long it took. */
async function drawn(howMany: number) {
  calls.status.mockResolvedValue(untrackedStatus(howMany));
  calls.log.mockResolvedValue({ commits: [] });
  calls.branches.mockResolvedValue({ branches: [] });
  const began = performance.now();
  render(<GitView path={REPO} />);
  const section = await screen.findByTestId('git-untracked-rows', undefined, { timeout: 30_000 });
  return { section, took: performance.now() - began };
}

describe('a file section of thousands', () => {
  it('draws a screenful, not a row for every path', async () => {
    const { section, took } = await drawn(5_099);

    expect(section.dataset.drawn).toBe('window');
    // A viewport's worth and its overscan either side, never thousands.
    expect(within(section).getAllByTestId('git-file').length).toBeLessThan(60);
    // The heading still says how many there really are.
    expect(screen.getByTestId('git-untracked').dataset.count).toBe('5099');
    expect(document.querySelectorAll('*').length).toBeLessThan(2_000);
    expect(took).toBeLessThan(1_000);
  }, 60_000);

  it('leaves an ordinary checkout drawn whole', async () => {
    const { section } = await drawn(4);

    expect(section.dataset.drawn).toBe('all');
    expect(within(section).getAllByTestId('git-file').length).toBe(4);
  }, 60_000);
});
