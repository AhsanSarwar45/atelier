/**
 * The Git rail is two panes, and the message box does not move (bw-g6zy.3).
 *
 * The view used to be one scrolling column: the branch, every changed file,
 * the message box, the Commit button and the whole history in a single scroll.
 * A project with forty changed files pushed the button out of the rail
 * entirely, so the one action the panel exists for could not be reached
 * without scrolling past the thing you were about to describe.
 *
 * What is asserted here is the structure that fixes it — which parts scroll
 * and which are pinned — rather than pixels, because jsdom lays nothing out.
 * That the divider actually moves, and remembers where it was left, is
 * asserted against `SplitColumn` itself.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitStatus } from '@/lib/api';
import { GitView } from '@/workbench/git-view';
import { SplitColumn } from '@/workbench/split-column';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const calls = vi.hoisted(() => ({
  status: vi.fn(),
  log: vi.fn(),
  branches: vi.fn(),
  watch: vi.fn(() => () => {}),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const REPO = '/tmp/a-project';

/** Forty changed files: the shape that used to push the button off the rail. */
const CROWDED: GitStatus = {
  branch: 'a-line-of-work',
  upstream: 'origin/a-line-of-work',
  pushTo: null,
  ahead: 0,
  behind: 0,
  detached: false,
  staged: Array.from({ length: 40 }, (_, at) => ({
    path: `src/changed-${at}.ts`,
    status: 'modified' as const,
    origPath: null,
  })),
  unstaged: [],
  untracked: [],
  conflicted: [],
};

describe('the Git rail keeps its commit box on screen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    calls.status.mockResolvedValue(CROWDED);
    calls.log.mockResolvedValue({ commits: [] });
    calls.branches.mockResolvedValue({ branches: [], current: 'a-line-of-work' });
  });

  it('scrolls the changed files inside their own pane, leaving the branch and the message box put', async () => {
    render(<GitView path={REPO} shown />);
    await waitFor(() => expect(screen.getByTestId('git-staged')).toBeInTheDocument());

    const changes = screen.getByTestId('git-changes');
    // The forty files are inside the one region that scrolls.
    expect(changes).toHaveClass('overflow-y-auto');
    expect(changes).toContainElement(screen.getByTestId('git-staged'));

    // The branch and the message box are not: they are elsewhere in the tree,
    // so nothing the file list does can carry them off the rail.
    expect(changes).not.toContainElement(screen.getByTestId('git-branch'));
    expect(changes).not.toContainElement(screen.getByTestId('git-commit'));
    expect(screen.getByTestId('git-compose')).toContainElement(
      screen.getByTestId('git-commit-message'),
    );
  });

  it('puts the history in a pane of its own, below a divider', async () => {
    render(<GitView path={REPO} shown />);
    await waitFor(() => expect(screen.getByTestId('git-log')).toBeInTheDocument());

    expect(screen.getByTestId('split-top')).toContainElement(screen.getByTestId('git-changes'));
    expect(screen.getByTestId('split-bottom')).toContainElement(screen.getByTestId('git-log'));
    expect(screen.getByTestId('split-handle')).toHaveAttribute('role', 'separator');
  });
});

describe('the divider between the two panes', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  /** jsdom measures nothing, so the container is given a height to divide. */
  function measured(height: number) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      bottom: height,
      right: 320,
      width: 320,
      height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  }

  it('opens two thirds of the way down, and shares out what is left', () => {
    render(<SplitColumn top={<p>above</p>} bottom={<p>below</p>} />);

    const handle = screen.getByTestId('split-handle');
    expect(handle).toHaveAttribute('aria-valuenow', '67');
    expect(Number(screen.getByTestId('split-top').style.flexGrow)).toBeCloseTo(2 / 3, 6);
    expect(Number(screen.getByTestId('split-bottom').style.flexGrow)).toBeCloseTo(1 / 3, 6);
  });

  it('moves where it is dragged and is still there the next time the rail opens', () => {
    measured(600);
    const { unmount } = render(
      <SplitColumn top={<p>above</p>} bottom={<p>below</p>} storageKey="a-project" />,
    );

    const handle = screen.getByTestId('split-handle');
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 400 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 150 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    expect(handle).toHaveAttribute('aria-valuenow', '25');
    unmount();

    render(<SplitColumn top={<p>above</p>} bottom={<p>below</p>} storageKey="a-project" />);
    expect(screen.getByTestId('split-handle')).toHaveAttribute('aria-valuenow', '25');
  });

  it('cannot be dragged far enough to swallow either pane', () => {
    measured(600);
    render(<SplitColumn top={<p>above</p>} bottom={<p>below</p>} />);

    const handle = screen.getByTestId('split-handle');
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 400 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: -500 });
    fireEvent.pointerUp(handle, { pointerId: 1 });

    // Eighty-eight pixels of six hundred: the floor, not nothing at all.
    expect(handle).toHaveAttribute('aria-valuenow', '15');

    fireEvent.pointerDown(handle, { pointerId: 2, clientY: 90 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientY: 5000 });
    fireEvent.pointerUp(handle, { pointerId: 2 });
    expect(handle).toHaveAttribute('aria-valuenow', '85');
  });

  it('answers the arrow keys, so it can be moved without a pointer', () => {
    measured(600);
    render(<SplitColumn top={<p>above</p>} bottom={<p>below</p>} />);

    const handle = screen.getByTestId('split-handle');
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(handle).toHaveAttribute('aria-valuenow', '65');
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    expect(handle).toHaveAttribute('aria-valuenow', '67');
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle).toHaveAttribute('aria-valuenow', '15');
    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle).toHaveAttribute('aria-valuenow', '85');
  });
});
