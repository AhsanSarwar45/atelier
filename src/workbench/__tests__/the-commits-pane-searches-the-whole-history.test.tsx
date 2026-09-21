/**
 * The commits pane: searched, paged, and pressed (bw-g6zy.4, bw-g6zy.5).
 *
 * Every filter is answered by git rather than by sieving the commits already
 * in hand, so what matters here is what is asked for — and that a search which
 * matches nothing says so instead of looking like an empty repository.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitCommit } from '@/lib/api';
import { CommitLog, PAGE } from '@/workbench/commit-log';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const calls = vi.hoisted(() => ({
  log: vi.fn(),
  watch: vi.fn(() => () => {}),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const REPO = '/tmp/a-project';

function madeUp(at: number, over: Partial<GitCommit> = {}): GitCommit {
  return {
    sha: String(at).padStart(40, '0'),
    shortSha: String(at).padStart(7, '0'),
    author: 'Somebody',
    email: 'somebody@example.test',
    date: '2026-09-20T10:00:00.000Z',
    subject: `change number ${at}`,
    parents: ['f'.repeat(40)],
    refs: [],
    ...over,
  };
}

/** The query the last `git.log` was made with. */
function lastAsk() {
  return calls.log.mock.calls.at(-1)?.[1] ?? {};
}

describe('the commits pane', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.log.mockResolvedValue({ commits: [madeUp(1), madeUp(2)] });
  });

  it('draws the history, and what points at each commit', async () => {
    calls.log.mockResolvedValue({
      commits: [madeUp(1, { refs: ['HEAD -> main', 'tag: v1'] }), madeUp(2)],
    });
    render(<CommitLog path={REPO} />);

    await waitFor(() => expect(screen.getAllByTestId('git-log-row')).toHaveLength(2));
    const newest = screen.getAllByTestId('git-log-row')[0];
    expect(within(newest).getByText('change number 1')).toBeInTheDocument();
    expect(
      within(newest)
        .getAllByTestId('git-log-ref')
        .map((badge) => badge.textContent),
    ).toEqual(['main', 'v1']);
  });

  it('asks git for the words typed, once the typing has settled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<CommitLog path={REPO} />);
      await waitFor(() => expect(calls.log).toHaveBeenCalled());
      calls.log.mockClear();

      const box = screen.getByTestId('commit-search-box');
      fireEvent.change(box, { target: { value: 't' } });
      fireEvent.change(box, { target: { value: 'to' } });
      fireEvent.change(box, { target: { value: 'toast' } });

      // Nothing is asked while the word is still being typed.
      expect(calls.log).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(400);
      await waitFor(() => expect(calls.log).toHaveBeenCalledTimes(1));
      expect(lastAsk().grep).toBe('toast');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends every qualifier as its own filter, and draws a chip for each', async () => {
    render(<CommitLog path={REPO} />);
    await waitFor(() => expect(calls.log).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId('commit-search-box'), {
      target: { value: 'toast author:ahsan path:src since:"2 weeks ago"' },
    });

    await waitFor(() => expect(lastAsk().author).toBe('ahsan'));
    expect(lastAsk()).toMatchObject({
      grep: 'toast',
      author: 'ahsan',
      file: 'src',
      since: '2 weeks ago',
    });

    expect(screen.getByTestId('commit-chip-author')).toHaveTextContent('Author: ahsan');
    expect(screen.getByTestId('commit-chip-path')).toHaveTextContent('Path: src');
  });

  it('takes a filter off again when its chip is pressed, leaving the words alone', async () => {
    render(<CommitLog path={REPO} />);
    await waitFor(() => expect(calls.log).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId('commit-search-box'), {
      target: { value: 'toast author:ahsan' },
    });
    await waitFor(() => expect(screen.getByTestId('commit-chip-author')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('commit-chip-author'));

    expect(screen.getByTestId('commit-search-box')).toHaveValue('toast');
    await waitFor(() =>
      expect(lastAsk()).toMatchObject({ grep: 'toast', author: undefined }),
    );
  });

  it('writes what the filter popover was told into the same line', async () => {
    render(<CommitLog path={REPO} />);
    await waitFor(() => expect(calls.log).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('commit-filter-open'));
    fireEvent.change(await screen.findByTestId('commit-filter-author'), {
      target: { value: 'ahsan' },
    });

    // One source of truth: the popover has no state of its own to fall out of
    // step with the box.
    expect(screen.getByTestId('commit-search-box')).toHaveValue('author:ahsan');
  });

  it('says a search matched nothing, rather than looking like an empty project', async () => {
    render(<CommitLog path={REPO} />);
    await waitFor(() => expect(screen.getAllByTestId('git-log-row')).toHaveLength(2));

    calls.log.mockResolvedValue({ commits: [] });
    fireEvent.change(screen.getByTestId('commit-search-box'), {
      target: { value: 'nothing says this' },
    });

    await waitFor(() =>
      expect(screen.getByTestId('git-log-empty')).toHaveTextContent('No commit matches.'),
    );
  });

  it('asks for more of the history when there is more to be had', async () => {
    calls.log.mockResolvedValue({
      commits: Array.from({ length: PAGE }, (_, at) => madeUp(at)),
    });
    render(<CommitLog path={REPO} />);
    await waitFor(() => expect(screen.getAllByTestId('git-log-row')).toHaveLength(PAGE));

    fireEvent.click(screen.getByTestId('git-log-more'));

    await waitFor(() => expect(lastAsk().limit).toBe(PAGE * 2));
  });

  it('offers nothing more once the history has run out', async () => {
    render(<CommitLog path={REPO} />);
    await waitFor(() => expect(screen.getAllByTestId('git-log-row')).toHaveLength(2));

    // Two answered where thirty were asked for: there is no more.
    expect(screen.queryByTestId('git-log-more')).toBeNull();
  });
});

describe('pressing a commit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.log.mockResolvedValue({ commits: [madeUp(1), madeUp(2), madeUp(3)] });
  });

  it('hands back the commit that was pressed', async () => {
    const opened = vi.fn();
    render(<CommitLog path={REPO} onOpen={opened} />);
    await waitFor(() => expect(screen.getAllByTestId('git-log-row')).toHaveLength(3));

    fireEvent.click(screen.getAllByTestId('git-log-row')[1]);

    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ subject: 'change number 2' }));
  });

  it('marks the one the diff pane is showing', async () => {
    render(<CommitLog path={REPO} openSha={madeUp(2).sha} />);
    await waitFor(() => expect(screen.getAllByTestId('git-log-row')).toHaveLength(3));

    const rows = screen.getAllByTestId('git-log-row');
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
    expect(rows[0]).not.toHaveAttribute('aria-current');
    // And it is the one the keyboard lands on first.
    expect(rows[1]).toHaveAttribute('tabindex', '0');
  });

  it('walks the list with the arrow keys and leaves it on Escape', async () => {
    const left = vi.fn();
    render(<CommitLog path={REPO} onLeave={left} />);
    await waitFor(() => expect(screen.getAllByTestId('git-log-row')).toHaveLength(3));

    const rows = screen.getAllByTestId('git-log-row');
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);

    fireEvent.keyDown(rows[1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[2]);

    // The end of the list is the end of the list, not the top again.
    fireEvent.keyDown(rows[2], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[2]);

    fireEvent.keyDown(rows[2], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows[1]);

    fireEvent.keyDown(rows[1], { key: 'Escape' });
    expect(left).toHaveBeenCalled();
  });
});
