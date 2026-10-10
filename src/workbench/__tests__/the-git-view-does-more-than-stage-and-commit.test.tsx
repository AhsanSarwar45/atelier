/**
 * What the Git panel offers beyond staging and committing (bw-7s0up).
 *
 * Each control is drawn only where it can work: nothing that talks to a remote
 * when there is none, no amend before the first commit, no stash to pop when
 * none is put away. The ones that throw work away ask first.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type GitStatus } from '@/lib/api';
import { ChatRightRail } from '@/workbench/chat-right-rail';
import { forgetRepositoryStatus } from '@/workbench/repository-status';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const calls = vi.hoisted(() => ({
  status: vi.fn(),
  log: vi.fn(),
  branches: vi.fn(),
  watch: vi.fn(() => () => {}),
  addRemote: vi.fn(),
  push: vi.fn(),
  commit: vi.fn(),
  checkout: vi.fn(),
  createBranch: vi.fn(),
  trackBranch: vi.fn(),
  stash: vi.fn(),
  popStash: vi.fn(),
  stageAll: vi.fn(),
  discardStaged: vi.fn(),
  resolve: vi.fn(),
  operation: vi.fn(),
  undoCommit: vi.fn(),
  generateMessage: vi.fn(),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const REPO = '/tmp/a-repository';

const CLEAN: GitStatus = {
  branch: 'main',
  upstream: 'origin/main',
  pushTo: null,
  ahead: 0,
  behind: 0,
  detached: false,
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  hasRemote: true,
  hasCommits: true,
  stashes: 0,
  operation: null,
};

const LAST = {
  sha: 'a'.repeat(40),
  shortSha: 'aaaaaaa',
  subject: 'Add the panel',
  author: 'A Writer',
  date: '2026-10-01T10:00:00Z',
  refs: [],
  parents: [],
};

async function panel(status: Partial<GitStatus> = {}) {
  calls.status.mockResolvedValue({ ...CLEAN, ...status });
  render(
    <ChatRightRail
      projectId="a-project"
      cards={[]}
      agents={[]}
      items={[]}
      sessionId="chat-1"
      agentControls={[]}
      onOpenAgent={() => {}}
      open
      view="git"
      projectPath={REPO}
      desktopWidth={320}
      onToggle={() => {}}
    />,
  );
  await screen.findByTestId('git-branch');
  await waitFor(() => expect(calls.status).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  forgetRepositoryStatus();
  calls.log.mockResolvedValue({ commits: [LAST], hasMore: false });
  calls.branches.mockResolvedValue({
    current: 'main',
    branches: [
      { name: 'main', upstream: 'origin/main', ahead: 0, behind: 0, isRemote: false },
      { name: 'origin/main', upstream: null, ahead: 0, behind: 0, isRemote: true },
      { name: 'origin/feature', upstream: null, ahead: 0, behind: 0, isRemote: true },
    ],
  });
  for (const call of [
    calls.addRemote,
    calls.push,
    calls.checkout,
    calls.createBranch,
    calls.trackBranch,
    calls.stash,
    calls.popStash,
    calls.stageAll,
    calls.discardStaged,
    calls.resolve,
    calls.operation,
  ]) {
    call.mockResolvedValue({ ok: true });
  }
  calls.commit.mockResolvedValue({ sha: 'b'.repeat(40) });
  calls.undoCommit.mockResolvedValue({ ok: true, message: 'Add the panel' });
  calls.generateMessage.mockResolvedValue({ message: 'Describe the staged change' });
});

describe('a repository with no remote', () => {
  it('offers Add remote and none of Fetch, Pull or Push', async () => {
    await panel({ hasRemote: false, upstream: null });

    expect(await screen.findByRole('button', { name: 'Add remote' })).toBeTruthy();
    for (const gone of ['git-fetch', 'git-pull', 'git-push', 'git-commit-push']) {
      expect(screen.queryByTestId(gone), gone).toBeNull();
    }
  });

  it('adds the remote it is given', async () => {
    await panel({ hasRemote: false, upstream: null });

    fireEvent.click(await screen.findByTestId('git-add-remote'));
    const dialog = await screen.findByTestId('git-name-dialog');
    expect(within(dialog).getByLabelText('Remote URL')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Add' })).toBeDisabled();

    fireEvent.change(screen.getByTestId('git-name-field'), {
      target: { value: ' git@example.com:me/repo.git ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(calls.addRemote).toHaveBeenCalledWith(REPO, 'git@example.com:me/repo.git'),
    );
  });
});

describe('a branch with no upstream', () => {
  it('offers Publish branch, and no Pull', async () => {
    await panel({ upstream: null });

    const publish = await screen.findByTestId('git-push');
    expect(publish).toHaveTextContent('Publish branch');
    expect(screen.queryByTestId('git-pull')).toBeNull();
    expect(screen.getByTestId('git-fetch')).toBeTruthy();

    fireEvent.click(publish);
    await waitFor(() => expect(calls.push).toHaveBeenCalledWith(REPO, true, undefined));
  });
});

describe('the counts', () => {
  it('are written on Push and Pull, and nowhere else', async () => {
    await panel({ ahead: 2, behind: 3 });

    await waitFor(() => expect(screen.getByTestId('git-push')).toHaveTextContent('Push2'));
    expect(screen.getByTestId('git-pull')).toHaveTextContent('Pull3');
  });

  it('are not drawn at zero', async () => {
    await panel();

    await waitFor(() => expect(screen.getByTestId('git-ahead')).toHaveClass('hidden'));
    expect(screen.getByTestId('git-behind')).toHaveClass('hidden');
  });
});

describe('before the first commit', () => {
  it('has no amend and no undo', async () => {
    await panel({ hasCommits: false, upstream: null });
    calls.log.mockResolvedValue({ commits: [], hasMore: false });

    await waitFor(() => expect(screen.getByTestId('git-commit')).toBeTruthy());
    expect(screen.queryByTestId('git-amend')).toBeNull();
    expect(screen.queryByTestId('git-undo-commit')).toBeNull();
  });
});

describe('the branch picker', () => {
  it('checks out a remote branch as a local one that follows it', async () => {
    await panel();
    await waitFor(() => expect(calls.branches).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('git-branch-name'));
    // The remote branch main already follows is not offered a second time.
    expect(screen.queryByRole('option', { name: /origin\/main/ })).toBeNull();
    fireEvent.click(await screen.findByRole('option', { name: /origin\/feature/ }));

    await waitFor(() => expect(calls.trackBranch).toHaveBeenCalledWith(REPO, 'origin/feature'));
    expect(calls.checkout).not.toHaveBeenCalled();
  });

  it('creates a branch from the name typed', async () => {
    await panel();
    await waitFor(() => expect(calls.branches).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('git-branch-name'));
    fireEvent.change(await screen.findByTestId('git-branch-name-search'), {
      target: { value: 'new-work' },
    });
    fireEvent.click(screen.getByTestId('git-branch-name-action'));

    const dialog = await screen.findByTestId('git-name-dialog');
    expect(within(dialog).getByText('Create branch')).toBeTruthy();
    expect(screen.getByTestId('git-name-field')).toHaveValue('new-work');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(calls.createBranch).toHaveBeenCalledWith(REPO, 'new-work'));
  });
});

describe('committing', () => {
  const STAGED: Partial<GitStatus> = {
    staged: [{ path: 'a.txt', status: 'modified', origPath: null }],
  };

  it('commits on Ctrl+Enter', async () => {
    await panel(STAGED);
    const box = await screen.findByTestId('git-commit-message');
    fireEvent.change(box, { target: { value: 'Change a' } });

    fireEvent.keyDown(box, { key: 'Enter' });
    expect(calls.commit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });

    await waitFor(() => expect(calls.commit).toHaveBeenCalledWith(REPO, 'Change a'));
  });

  it('commits and then pushes', async () => {
    await panel(STAGED);
    fireEvent.change(await screen.findByTestId('git-commit-message'), {
      target: { value: 'Change a' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Commit and push' }));

    await waitFor(() => expect(calls.push).toHaveBeenCalledWith(REPO, false, undefined));
    expect(calls.commit).toHaveBeenCalledWith(REPO, 'Change a');
  });

  it('does not push when the commit is refused', async () => {
    calls.commit.mockRejectedValue(new Error('API error: 500 nothing to commit'));
    await panel(STAGED);
    fireEvent.change(await screen.findByTestId('git-commit-message'), {
      target: { value: 'Change a' },
    });

    fireEvent.click(screen.getByTestId('git-commit-push'));

    expect(await screen.findByTestId('git-error')).toHaveTextContent('nothing to commit');
    expect(calls.push).not.toHaveBeenCalled();
  });

  it('fills the box with a generated message', async () => {
    await panel(STAGED);

    fireEvent.click(await screen.findByRole('button', { name: 'Generate message' }));

    await waitFor(() =>
      expect(screen.getByTestId('git-commit-message')).toHaveValue('Describe the staged change'),
    );
    expect(calls.generateMessage).toHaveBeenCalledWith(REPO);
    expect(calls.commit).not.toHaveBeenCalled();
  });

  it('cannot generate a message with nothing staged', async () => {
    await panel();
    expect(await screen.findByTestId('git-generate-message')).toBeDisabled();
  });

  it('undoes the last commit after asking, and puts its message back', async () => {
    await panel();

    fireEvent.click(await screen.findByRole('button', { name: 'Undo last commit' }));
    const dialog = await screen.findByTestId('git-confirm-dialog');
    // Nothing ahead of the upstream: the commit is already on the remote.
    expect(dialog).toHaveTextContent('already pushed');
    expect(calls.undoCommit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('git-confirm'));

    await waitFor(() => expect(calls.undoCommit).toHaveBeenCalledWith(REPO));
    await waitFor(() =>
      expect(screen.getByTestId('git-commit-message')).toHaveValue('Add the panel'),
    );
  });

  it('does not warn about a push for a commit that was never pushed', async () => {
    await panel({ ahead: 1 });

    fireEvent.click(await screen.findByTestId('git-undo-commit'));

    expect(await screen.findByTestId('git-confirm-dialog')).not.toHaveTextContent('pushed');
  });
});

describe('the working tree as a whole', () => {
  it('stashes changes and pops the newest stash', async () => {
    await panel({ unstaged: [{ path: 'a.txt', status: 'modified', origPath: null }], stashes: 2 });

    fireEvent.click(await screen.findByRole('button', { name: 'Stash' }));
    await waitFor(() => expect(calls.stash).toHaveBeenCalledWith(REPO));

    expect(screen.getByTestId('git-pop-stash')).toHaveTextContent('Restore stash2');
    fireEvent.click(screen.getByTestId('git-pop-stash'));
    await waitFor(() => expect(calls.popStash).toHaveBeenCalledWith(REPO));
  });

  it('offers neither on a clean tree with nothing stashed', async () => {
    await panel();

    await screen.findByTestId('git-clean');
    expect(screen.queryByTestId('git-tree-actions')).toBeNull();
  });

  it('draws one Stage all for changed and untracked files together', async () => {
    await panel({
      unstaged: [{ path: 'a.txt', status: 'modified', origPath: null }],
      untracked: [{ path: 'new.txt' }],
    });

    await screen.findByTestId('git-untracked');
    expect(screen.getAllByRole('button', { name: 'Stage all' })).toHaveLength(1);
  });

  it('folds a section to its heading and remembers it', async () => {
    await panel({ unstaged: [{ path: 'a.txt', status: 'modified', origPath: null }] });
    const section = await screen.findByTestId('git-unstaged');
    expect(within(section).getByTestId('git-file')).toBeTruthy();

    fireEvent.click(within(section).getByTestId('git-section-toggle'));

    expect(within(section).queryByTestId('git-file')).toBeNull();
    expect(within(section).getByTestId('git-section-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(window.localStorage.getItem('workbench.git-folds')).toBe('["unstaged"]');
  });

  it('folds the history away', async () => {
    await panel();
    expect(await screen.findByTestId('git-history')).toBeTruthy();

    fireEvent.click(screen.getByTestId('git-history-toggle'));

    expect(screen.queryByTestId('git-history')).toBeNull();
    expect(screen.queryByTestId('split-handle')).toBeNull();
  });
});

describe('a staged file', () => {
  it('is discarded back to the last commit, after asking', async () => {
    await panel({ staged: [{ path: 'new-name.txt', status: 'renamed', origPath: 'old-name.txt' }] });

    fireEvent.click(await screen.findByTestId('git-discard-staged'));
    expect(await screen.findByTestId('git-confirm-dialog')).toHaveTextContent('new-name.txt');
    expect(calls.discardStaged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('git-confirm'));

    // A rename is two paths, and both have to go back.
    await waitFor(() =>
      expect(calls.discardStaged).toHaveBeenCalledWith(REPO, ['new-name.txt', 'old-name.txt']),
    );
  });

  it('says a new file will be deleted', async () => {
    await panel({ staged: [{ path: 'new.txt', status: 'added', origPath: null }] });

    fireEvent.click(await screen.findByTestId('git-discard-staged'));

    expect(await screen.findByTestId('git-confirm-dialog')).toHaveTextContent(
      'The file will be deleted',
    );
  });
});

describe('a merge that stopped on a conflict', () => {
  const STOPPED: Partial<GitStatus> = {
    conflicted: [{ path: 'both.txt' }],
    operation: 'merge',
  };

  it('settles a file as ours or as theirs', async () => {
    await panel(STOPPED);

    fireEvent.click(await screen.findByRole('button', { name: 'Accept incoming change in both.txt' }));
    await waitFor(() => expect(calls.resolve).toHaveBeenCalledWith(REPO, ['both.txt'], 'theirs'));

    fireEvent.click(screen.getByRole('button', { name: 'Accept current change in both.txt' }));
    await waitFor(() => expect(calls.resolve).toHaveBeenCalledWith(REPO, ['both.txt'], 'ours'));
  });

  it('aborts the merge after asking', async () => {
    await panel(STOPPED);

    fireEvent.click(await screen.findByRole('button', { name: 'Abort merge' }));
    expect(calls.operation).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('git-confirm'));

    await waitFor(() => expect(calls.operation).toHaveBeenCalledWith(REPO, 'abort'));
    // A merge is gone on with by committing, so it has no Continue.
    expect(screen.queryByTestId('git-continue')).toBeNull();
  });

  it('offers to continue a rebase once nothing is in conflict', async () => {
    await panel({ operation: 'rebase', staged: [{ path: 'both.txt', status: 'modified', origPath: null }] });

    fireEvent.click(await screen.findByRole('button', { name: 'Continue rebase' }));

    await waitFor(() => expect(calls.operation).toHaveBeenCalledWith(REPO, 'continue'));
  });
});
