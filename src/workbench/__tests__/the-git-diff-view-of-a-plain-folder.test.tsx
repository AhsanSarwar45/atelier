/**
 * The diff pane of a chat whose folder has no repository.
 *
 * git's answer there is its whole usage text, and drawing it as an error is a
 * wall of red that says nothing a reader can act on. The server marks the
 * answer instead, and the pane says the one thing that is true.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { GitDiffView } from '@/workbench/git-diff-view';
import { PathsOpenProvider } from '@/workbench/open-path';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('id=p1&tab=chat'),
}));

const calls = vi.hoisted(() => ({
  diff: vi.fn(),
  watch: vi.fn(),
  trees: vi.fn(),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const FOLDER = '/tmp/a-plain-folder';

describe('the diff of a folder with no repository', () => {
  it('says there is no repository instead of printing git', async () => {
    calls.watch.mockReturnValue(() => {});
    calls.trees.mockResolvedValue({ trees: [], place: FOLDER });
    calls.diff.mockRejectedValue(
      new ApiError('warning: Not a git repository. Use --no-index\nusage: git diff --no-index', 422, {
        error: 'warning: Not a git repository. Use --no-index\nusage: git diff --no-index',
        notARepository: true,
      }),
    );

    render(
      <PathsOpenProvider projectPath={FOLDER}>
        <GitDiffView path={FOLDER} />
      </PathsOpenProvider>,
    );

    expect(await screen.findByTestId('git-diff-no-repository')).toHaveTextContent('Not a git repository');
    expect(screen.queryByTestId('git-diff-error')).toBeNull();
    expect(screen.queryByText(/usage: git diff/)).toBeNull();
  });
});
