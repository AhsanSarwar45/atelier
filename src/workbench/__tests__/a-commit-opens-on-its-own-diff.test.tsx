/**
 * Pressing a commit draws that commit (bw-g6zy.5).
 *
 * The diff pane is the same pane either way — the same sections, the same
 * colouring, the same virtualiser — because a commit's patch and a working
 * tree's are the same shape. What is asserted here is the part that differs:
 * which call is made, what the header says, and that a commit does not sit
 * there being re-read as though it could change.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitCommitDetail, GitDiffFile } from '@/lib/api';
import { CommitDetails } from '@/workbench/commit-details';
import { GitDiffView } from '@/workbench/git-diff-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const calls = vi.hoisted(() => ({
  diff: vi.fn(),
  show: vi.fn(),
  watch: vi.fn(() => () => {}),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const REPO = '/tmp/a-project';
const SHA = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
const PARENT = 'b'.repeat(40);

const CHANGED: GitDiffFile[] = [
  {
    path: 'src/one.ts',
    oldPath: null,
    status: 'modified',
    additions: 3,
    deletions: 1,
    binary: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 3,
        lines: [
          { kind: 'removed', text: 'was' },
          { kind: 'added', text: 'is' },
        ],
      },
    ],
  },
];

function aCommit(over: Partial<GitCommitDetail> = {}): GitCommitDetail {
  return {
    sha: SHA,
    shortSha: 'a1b2c3d',
    author: 'Somebody',
    email: 'somebody@example.test',
    date: '2026-09-20T10:00:00.000Z',
    committer: 'Somebody',
    committerEmail: 'somebody@example.test',
    committerDate: '2026-09-20T10:00:00.000Z',
    subject: 'What it does',
    body: 'What it does\n\nWhy it does it, at some length.',
    parents: [PARENT],
    refs: [],
    merge: false,
    comparedWith: PARENT,
    ...over,
  };
}

describe('the diff pane, showing one commit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.diff.mockResolvedValue({ files: [] });
    calls.show.mockResolvedValue({ commit: aCommit(), files: CHANGED });
  });

  it('asks for the commit it was given, and not for the working tree', async () => {
    render(<GitDiffView path={REPO} commit={SHA} />);

    await waitFor(() => expect(calls.show).toHaveBeenCalledWith(REPO, SHA, expect.anything()));
    expect(calls.diff).not.toHaveBeenCalled();
  });

  it('draws the commit above its patch', async () => {
    render(<GitDiffView path={REPO} commit={SHA} />);

    await waitFor(() => expect(screen.getByTestId('commit-details')).toBeInTheDocument());
    expect(screen.getByTestId('commit-subject')).toHaveTextContent('What it does');
    expect(screen.getByTestId('commit-counts')).toHaveTextContent('1 file changed');
    expect(screen.getByTestId('git-diff-file')).toHaveAttribute('data-path', 'src/one.ts');
  });

  it('goes back to the working tree, and asks for it', async () => {
    const back = vi.fn();
    const { rerender } = render(
      <GitDiffView path={REPO} commit={SHA} onShowWorkingTree={back} />,
    );
    await waitFor(() => expect(screen.getByTestId('commit-details')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('commit-leave'));
    expect(back).toHaveBeenCalled();

    rerender(<GitDiffView path={REPO} commit={null} onShowWorkingTree={back} />);
    await waitFor(() => expect(calls.diff).toHaveBeenCalled());
    expect(screen.queryByTestId('commit-details')).toBeNull();
  });

  it('does not watch a commit for changes, because a commit cannot change', async () => {
    render(<GitDiffView path={REPO} commit={SHA} />);
    await waitFor(() => expect(calls.show).toHaveBeenCalled());

    // The working tree is watched; a commit is read once and left alone.
    expect(calls.watch).not.toHaveBeenCalled();
  });

  it('watches the working tree as it always did', async () => {
    render(<GitDiffView path={REPO} />);
    await waitFor(() => expect(calls.diff).toHaveBeenCalled());

    expect(calls.watch).toHaveBeenCalled();
  });

  it('says a commit changed nothing in that commit’s own words', async () => {
    calls.show.mockResolvedValue({ commit: aCommit(), files: [] });
    render(<GitDiffView path={REPO} commit={SHA} />);

    await waitFor(() =>
      expect(screen.getByTestId('git-diff-empty')).toHaveTextContent(
        'This commit changed nothing',
      ),
    );
  });
});

describe('what the commit header says', () => {
  it('names the author, the time, the short name and what it touched', () => {
    render(<CommitDetails commit={aCommit()} files={CHANGED} />);

    expect(screen.getByText('Somebody')).toBeInTheDocument();
    expect(screen.getByTestId('commit-sha')).toHaveTextContent('a1b2c3d');
    expect(screen.getByTestId('commit-counts')).toHaveTextContent('1 file changed');
    expect(screen.getByText('+3')).toBeInTheDocument();
    expect(screen.getByText('−1')).toBeInTheDocument();
  });

  it('keeps the message’s own paragraphs, without repeating the subject', () => {
    render(<CommitDetails commit={aCommit()} files={CHANGED} />);

    const body = screen.getByTestId('commit-body');
    expect(body).toHaveTextContent('Why it does it, at some length.');
    expect(body).not.toHaveTextContent('What it does');
  });

  it('says nothing about the committer when it is the author', () => {
    render(<CommitDetails commit={aCommit()} files={CHANGED} />);

    expect(screen.queryByTestId('commit-committer')).toBeNull();
  });

  it('names the committer when the change was carried here from elsewhere', () => {
    render(
      <CommitDetails
        commit={aCommit({ committer: 'Someone Else', committerEmail: 'else@example.test' })}
        files={CHANGED}
      />,
    );

    expect(screen.getByTestId('commit-committer')).toHaveTextContent('Someone Else');
  });

  it('marks a merge, and offers both of the commits it joined', () => {
    const opened = vi.fn();
    render(
      <CommitDetails
        commit={aCommit({ merge: true, parents: [PARENT, 'c'.repeat(40)] })}
        files={CHANGED}
        onOpen={opened}
      />,
    );

    expect(screen.getByTestId('commit-merge')).toBeInTheDocument();
    const parents = screen.getAllByTestId('commit-parent');
    expect(parents).toHaveLength(2);

    fireEvent.click(parents[1]);
    expect(opened).toHaveBeenCalledWith('c'.repeat(40));
  });

  it('draws the branches and tags standing on the commit', () => {
    render(
      <CommitDetails commit={aCommit({ refs: ['HEAD -> main', 'tag: v1'] })} files={CHANGED} />,
    );

    expect(screen.getAllByTestId('commit-ref').map((one) => one.textContent)).toEqual([
      'main',
      'v1',
    ]);
  });

  it('copies the whole name, not the short one, when the name is pressed', async () => {
    const written = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: written } });
    render(<CommitDetails commit={aCommit()} files={CHANGED} />);

    fireEvent.click(screen.getByTestId('commit-sha'));

    await waitFor(() => expect(written).toHaveBeenCalledWith(SHA));
  });

  it('holds a long message back behind a word, and lets it out again', () => {
    const many = ['What it does', '', 'one', 'two', 'three', 'four', 'five'].join('\n');
    render(<CommitDetails commit={aCommit({ body: many })} files={CHANGED} />);

    expect(screen.getByTestId('commit-body')).toHaveClass('line-clamp-3');
    fireEvent.click(screen.getByTestId('commit-body-more'));
    expect(screen.getByTestId('commit-body')).not.toHaveClass('line-clamp-3');
  });

  it('says nothing about a parent for the first commit of all', () => {
    render(
      <CommitDetails commit={aCommit({ parents: [], comparedWith: null })} files={CHANGED} />,
    );

    expect(screen.queryByTestId('commit-parent')).toBeNull();
  });
});

describe('the Git panel and the diff pane together', () => {
  it('marks the open commit in the header it came from', async () => {
    calls.show.mockResolvedValue({ commit: aCommit(), files: CHANGED });
    render(<GitDiffView path={REPO} commit={SHA} />);

    const details = await screen.findByTestId('commit-details');
    expect(details).toHaveAttribute('data-sha', SHA);
    expect(within(details).getByTestId('commit-sha')).toBeInTheDocument();
  });
});
