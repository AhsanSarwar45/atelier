/**
 * The diff that stands in for the transcript, drawing a worktree's changes
 * (bw-rx1y.5).
 *
 * The rail says WHICH files changed; this says what changed in them. What is
 * asserted here is the shape a reader meets: one collapsible section per file
 * with its status and its counts on the heading line, the lines behind that
 * line's click, the file's name as the same badge a file named in a message
 * gets — and the two ways a working tree can be too big to draw whole, which
 * are answered by starting shut rather than by drawing nothing.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitDiffFile } from '@/lib/api';
import { GitDiffView } from '@/workbench/git-diff-view';

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

const opened = vi.hoisted(() => ({ where: vi.fn() }));

vi.mock('@/workbench/open-local-path', () => ({
  openLocalPath: opened.where,
}));

const REPO = '/tmp/a-worktree';

/** A file with `count` changed lines in one hunk, all of them additions. */
function changed(path: string, count: number, over: Partial<GitDiffFile> = {}): GitDiffFile {
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
    ...over,
  };
}

function draw(files: GitDiffFile[]) {
  calls.diff.mockResolvedValue({ files });
  return render(<GitDiffView path={REPO} />);
}

/** The section drawn for `path`. */
function section(path: string) {
  const found = screen
    .getAllByTestId('git-diff-file')
    .find((one) => one.getAttribute('data-path') === path);
  if (!found) throw new Error(`no section drawn for ${path}`);
  return found;
}

describe('the diff draws every file the worktree has changed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.watch.mockReturnValue(() => {});
  });

  it('gives each file a section of its own, with its counts and what happened to it', async () => {
    draw([
      changed('src/one.ts', 3),
      { ...changed('src/two.ts', 1), status: 'added', additions: 4, deletions: 2 },
    ]);

    await waitFor(() => expect(screen.getAllByTestId('git-diff-file')).toHaveLength(2));
    expect(calls.diff).toHaveBeenCalledWith(REPO, expect.any(AbortSignal));

    const two = section('src/two.ts');
    expect(within(two).getByTestId('git-diff-counts')).toHaveTextContent('+4');
    expect(within(two).getByTestId('git-diff-counts')).toHaveTextContent('−2');
    // The rail's own chip, so a status means the same thing wherever it is read.
    expect(two).toHaveTextContent('A');
    expect(section('src/one.ts')).toHaveTextContent('M');
  });

  it('says the two words a diff can say that a status cannot', async () => {
    draw([
      { ...changed('src/new.ts', 1), status: 'untracked' },
      { ...changed('src/clash.ts', 1), status: 'conflicted' },
    ]);

    await waitFor(() => expect(screen.getAllByTestId('git-diff-file')).toHaveLength(2));
    expect(section('src/new.ts')).toHaveTextContent('?');
    expect(section('src/clash.ts')).toHaveTextContent('U');
  });

  it('opens a file with its lines drawn, and shuts it again on a second click', async () => {
    draw([changed('src/one.ts', 3)]);
    await waitFor(() => expect(screen.getByTestId('diff-table')).toBeInTheDocument());
    expect(section('src/one.ts')).toHaveAttribute('data-open', 'true');

    fireEvent.click(screen.getByTestId('git-diff-file-toggle'));
    expect(section('src/one.ts')).toHaveAttribute('data-open', 'false');
    expect(screen.queryByTestId('diff-table')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('git-diff-file-toggle'));
    expect(section('src/one.ts')).toHaveAttribute('data-open', 'true');
    expect(screen.getByTestId('diff-table')).toBeInTheDocument();
  });

  it('carries the whole path on the badge, and opens the editor without shutting the file', async () => {
    draw([changed('src/one.ts', 3)]);
    await waitFor(() => expect(screen.getByTestId('path-chip')).toBeInTheDocument());

    const chip = screen.getByTestId('path-chip');
    expect(chip).toHaveAttribute('data-path-target', 'editor');
    expect(chip).toHaveAttribute('data-path-mention', `${REPO}/src/one.ts`);
    expect(chip).toHaveTextContent('src/one.ts');

    fireEvent.click(chip);

    expect(opened.where).toHaveBeenCalledWith(`${REPO}/src/one.ts`, 'vscode', 1);
    // The click that opened the editor was not also a click on the disclosure.
    expect(
      section('src/one.ts'),
      'clicking the file badge shut the file it was meant to open',
    ).toHaveAttribute('data-open', 'true');
  });

  it('says so rather than drawing nothing for a binary file', async () => {
    draw([{ ...changed('logo.png', 0), binary: true, hunks: [], additions: 0, deletions: 0 }]);
    await waitFor(() => expect(screen.getByTestId('git-diff-binary')).toBeInTheDocument());
    expect(screen.queryByTestId('diff-table')).not.toBeInTheDocument();
  });

  it('says so rather than drawing nothing for a file that only moved', async () => {
    draw([
      {
        ...changed('src/after.ts', 0),
        status: 'renamed',
        oldPath: 'src/before.ts',
        hunks: [],
        additions: 0,
        deletions: 0,
      },
    ]);
    await waitFor(() => expect(screen.getByTestId('git-diff-unchanged')).toBeInTheDocument());
    expect(section('src/after.ts')).toHaveTextContent('src/before.ts');
    expect(section('src/after.ts')).toHaveTextContent('R');
  });

  it('says the working tree is clean rather than leaving a blank column', async () => {
    draw([]);
    await waitFor(() => expect(screen.getByTestId('git-diff-empty')).toBeInTheDocument());
    expect(screen.queryAllByTestId('git-diff-file')).toHaveLength(0);
  });

  it('reports what git said when the read fails', async () => {
    calls.diff.mockRejectedValue(new Error('not a git repository'));
    render(<GitDiffView path={REPO} />);

    await waitFor(() => expect(screen.getByTestId('git-diff-error')).toBeInTheDocument());
    expect(screen.getByTestId('git-diff-error')).toHaveTextContent('not a git repository');
    expect(screen.queryByTestId('git-diff-empty')).not.toBeInTheDocument();
  });

  it('opens the first twenty of twenty-five files and leaves the rest for a click', async () => {
    draw(Array.from({ length: 25 }, (_, at) => changed(`src/f${String(at).padStart(2, '0')}.ts`, 2)));
    await waitFor(() => expect(screen.getAllByTestId('git-diff-file')).toHaveLength(25));

    const open = screen
      .getAllByTestId('git-diff-file')
      .filter((one) => one.getAttribute('data-open') === 'true');
    expect(open).toHaveLength(20);
    expect(section('src/f00.ts')).toHaveAttribute('data-open', 'true');
    expect(section('src/f19.ts')).toHaveAttribute('data-open', 'true');
    expect(section('src/f20.ts')).toHaveAttribute('data-open', 'false');
    expect(section('src/f24.ts')).toHaveAttribute('data-open', 'false');
  });

  it('leaves a very long file shut, and says why', async () => {
    draw([changed('src/short.ts', 3), changed('src/enormous.ts', 2_500)]);
    await waitFor(() => expect(screen.getAllByTestId('git-diff-file')).toHaveLength(2));

    expect(section('src/short.ts')).toHaveAttribute('data-open', 'true');
    expect(section('src/enormous.ts')).toHaveAttribute('data-open', 'false');
    expect(within(section('src/enormous.ts')).getByTestId('git-diff-long')).toHaveTextContent(
      'long, click to read',
    );

    // And it opens on being asked, which is the whole point of not drawing it.
    fireEvent.click(within(section('src/enormous.ts')).getByTestId('git-diff-file-toggle'));
    expect(section('src/enormous.ts')).toHaveAttribute('data-open', 'true');
  });

  it('draws nothing at all without a repository to read', () => {
    render(<GitDiffView path={null} />);
    expect(calls.diff).not.toHaveBeenCalled();
    expect(screen.queryByTestId('git-diff-empty')).not.toBeInTheDocument();
  });
});
