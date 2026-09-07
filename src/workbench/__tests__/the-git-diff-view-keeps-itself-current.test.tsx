/**
 * A drawing of a repository that stays true to it (bw-rx1y.5).
 *
 * The rail worked this out first and the diff needs the same thing, so the rule
 * lives in `useRepositoryReads` and neither of them owns it. Two things are
 * asserted here: the rule itself, on its own, away from anything it draws — one
 * read at a time, a hidden tab reading nothing, and letting go on the way out —
 * and then the diff obeying it, which is the part a reader would notice, since
 * a re-read that threw away the sections they had shut would be worse than no
 * re-read at all.
 */
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitDiffFile } from '@/lib/api';
import { GitDiffView } from '@/workbench/git-diff-view';
import { useRepositoryReads, WORKING_TREE_MS } from '@/workbench/use-repository-reads';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const calls = vi.hoisted(() => ({
  diff: vi.fn(),
  watch: vi.fn(),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const REPO = '/tmp/a-worktree';

/** Whoever the caller gave the server's watcher to watch on its behalf. */
let told: (() => void) | null = null;
/** Whether the caller let that watch go. */
let stopped = false;

function changed(path: string, count: number): GitDiffFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    additions: count,
    deletions: 0,
    binary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: count,
        lines: Array.from({ length: count }, (_, at) => ({ kind: 'added' as const, text: `line ${at + 1}` })),
      },
    ],
  };
}

function section(path: string) {
  const found = screen
    .getAllByTestId('git-diff-file')
    .find((one) => one.getAttribute('data-path') === path);
  if (!found) throw new Error(`no section drawn for ${path}`);
  return found;
}

/** Whatever the tab is currently pretending to be. */
function pretendTab(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

beforeEach(() => {
  vi.clearAllMocks();
  told = null;
  stopped = false;
  pretendTab('visible');
  calls.watch.mockImplementation((_path: string, onChange: () => void) => {
    told = onChange;
    return () => {
      stopped = true;
    };
  });
});

afterEach(() => {
  vi.useRealTimers();
  pretendTab('visible');
});

describe('the rule for keeping a drawing of a repository current', () => {
  it('asks to be told about the repository it was pointed at, and lets go on the way out', () => {
    const read = vi.fn().mockResolvedValue(undefined);
    const drawn = renderHook(() => useRepositoryReads(REPO, read));

    expect(calls.watch).toHaveBeenCalledWith(REPO, expect.any(Function));
    expect(stopped).toBe(false);

    drawn.unmount();

    expect(stopped, 'a watch was left running behind').toBe(true);
  });

  it('asks for nothing without a repository to read', () => {
    renderHook(() => useRepositoryReads(null, vi.fn().mockResolvedValue(undefined)));
    expect(calls.watch).not.toHaveBeenCalled();
  });

  it('queues exactly one more read when one is already in flight', async () => {
    let answer: () => void = () => {};
    const read = vi.fn().mockImplementation(() => new Promise<void>((settle) => (answer = () => settle())));
    const drawn = renderHook(() => useRepositoryReads(REPO, read));
    const readAgain = drawn.result.current;

    void readAgain();
    expect(read).toHaveBeenCalledTimes(1);

    // A push writes a burst of refs; each one asks, and none of them starts a
    // second run over the first.
    void readAgain();
    void readAgain();
    void readAgain();
    expect(read).toHaveBeenCalledTimes(1);

    read.mockResolvedValue(undefined);
    await act(async () => {
      answer();
    });

    // One more read for the whole burst, not three.
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads again when the git directory moves', async () => {
    const read = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useRepositoryReads(REPO, read));
    expect(read).not.toHaveBeenCalled();

    await act(async () => {
      told?.();
    });

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('looks slowly for a working-tree edit the watcher cannot see', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useRepositoryReads(REPO, read));

    await vi.advanceTimersByTimeAsync(WORKING_TREE_MS);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads nothing at all while the tab is hidden, and once the moment it is looked at again', async () => {
    vi.useFakeTimers();
    pretendTab('hidden');
    const read = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useRepositoryReads(REPO, read));

    await vi.advanceTimersByTimeAsync(WORKING_TREE_MS * 3);
    expect(read, 'a tab nobody is looking at was running git anyway').not.toHaveBeenCalled();

    pretendTab('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(read).toHaveBeenCalledTimes(1);
  });

  it('looks again when the window is come back to', async () => {
    const read = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useRepositoryReads(REPO, read));

    await act(async () => {
      fireEvent.focus(window);
    });

    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('the diff redraws itself without losing what the reader said', () => {
  it('takes the new lines on being told, and keeps a section the reader shut still shut', async () => {
    calls.diff.mockResolvedValue({ files: [changed('src/one.ts', 2), changed('src/two.ts', 2)] });
    render(<GitDiffView path={REPO} />);
    await waitFor(() => expect(screen.getAllByTestId('git-diff-file')).toHaveLength(2));

    // The reader shuts the file they have finished with.
    fireEvent.click(within(section('src/one.ts')).getByTestId('git-diff-file-toggle'));
    expect(section('src/one.ts')).toHaveAttribute('data-open', 'false');

    // The agent writes another file and touches the second one again.
    calls.diff.mockResolvedValue({
      files: [changed('src/one.ts', 2), changed('src/three.ts', 9), changed('src/two.ts', 7)],
    });
    await act(async () => {
      told?.();
    });

    await waitFor(() => expect(screen.getAllByTestId('git-diff-file')).toHaveLength(3));
    expect(within(section('src/two.ts')).getByTestId('git-diff-counts')).toHaveTextContent('+7');
    // The new file is drawn open, by the same rule any first file is.
    expect(section('src/three.ts')).toHaveAttribute('data-open', 'true');
    expect(
      section('src/one.ts'),
      'a read nobody asked for reopened a file the reader had shut',
    ).toHaveAttribute('data-open', 'false');
  });

  it('forgets what was said about the old worktree when it is pointed at a new one', async () => {
    calls.diff.mockResolvedValue({ files: [changed('src/one.ts', 2)] });
    const drawn = render(<GitDiffView path={REPO} />);
    await waitFor(() => expect(screen.getAllByTestId('git-diff-file')).toHaveLength(1));

    fireEvent.click(within(section('src/one.ts')).getByTestId('git-diff-file-toggle'));
    expect(section('src/one.ts')).toHaveAttribute('data-open', 'false');

    drawn.rerender(<GitDiffView path="/tmp/another-worktree" />);

    await waitFor(() => expect(calls.diff).toHaveBeenCalledWith('/tmp/another-worktree', expect.any(AbortSignal)));
    await waitFor(() => expect(screen.getAllByTestId('git-diff-file')).toHaveLength(1));
    expect(
      section('src/one.ts'),
      'a file in a different worktree inherited a shrug from the last one',
    ).toHaveAttribute('data-open', 'true');
  });
});
