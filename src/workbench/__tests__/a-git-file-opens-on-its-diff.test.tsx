/**
 * A file's name in the Git panel opens the diff on that file (bw-pstm.1).
 *
 * Two halves. The panel's half: a plain click on the name asks for the file's
 * diff and not for the Files tab, while Alt-click still reaches the file. The
 * diff's half: a file asked for is opened, even one that started shut, and
 * scrolled to.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitDiffFile, GitStatus } from '@/lib/api';
import { GitDiffView } from '@/workbench/git-diff-view';
import { GitView } from '@/workbench/git-view';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const calls = vi.hoisted(() => ({
  status: vi.fn(),
  log: vi.fn(),
  branches: vi.fn(),
  watch: vi.fn(),
  diff: vi.fn(),
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

function standing(): GitStatus {
  return {
    branch: 'main',
    upstream: null,
    pushTo: null,
    ahead: 0,
    behind: 0,
    detached: false,
    staged: [],
    unstaged: [{ path: 'src/edited.ts', status: 'modified', origPath: null }],
    untracked: [{ path: 'notes.md' }],
    conflicted: [],
  };
}

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

function nameOf(path: string) {
  const row = screen.getAllByTestId('git-file').find((one) => one.getAttribute('data-path') === path);
  if (!row) throw new Error(`no row for ${path}`);
  return row.querySelector('[data-testid="git-file-name"]') as HTMLElement;
}

describe('a Git panel file opens on its diff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.status.mockResolvedValue(standing());
    calls.log.mockResolvedValue({ commits: [] });
    calls.branches.mockResolvedValue({ branches: [] });
    calls.watch.mockReturnValue(() => {});
  });

  it('asks for the diff of a changed or untracked file on a plain click', async () => {
    const onShowFile = vi.fn();
    render(<GitView path={REPO} onShowFile={onShowFile} />);
    await waitFor(() => expect(screen.getAllByTestId('git-file')).toHaveLength(2));

    fireEvent.click(nameOf('src/edited.ts'));
    fireEvent.click(nameOf('notes.md'));

    expect(onShowFile.mock.calls).toEqual([['src/edited.ts'], ['notes.md']]);
  });

  it('leaves Alt-click to the file itself', async () => {
    const onShowFile = vi.fn();
    render(<GitView path={REPO} onShowFile={onShowFile} />);
    await waitFor(() => expect(screen.getAllByTestId('git-file')).toHaveLength(2));

    fireEvent.click(nameOf('src/edited.ts'), { altKey: true });

    expect(onShowFile).not.toHaveBeenCalled();
  });

  it('opens and scrolls to the file asked for, even one that started shut', async () => {
    const scrolled: string[] = [];
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.dataset.path ?? '');
    };
    // Long enough to start shut.
    calls.diff.mockResolvedValue({ files: [changed('a.ts', 1), changed('long.ts', 3_000)] });

    const { rerender } = render(<GitDiffView path={REPO} focus={null} />);
    await waitFor(() => expect(screen.getAllByTestId('git-diff-file')).toHaveLength(2));
    const long = () => screen.getAllByTestId('git-diff-file')[1];
    expect(long()).toHaveAttribute('data-open', 'false');

    rerender(<GitDiffView path={REPO} focus={{ path: 'long.ts', asked: 1 }} />);

    await waitFor(() => expect(long()).toHaveAttribute('data-open', 'true'));
    expect(scrolled).toEqual(['long.ts']);
  });
});
