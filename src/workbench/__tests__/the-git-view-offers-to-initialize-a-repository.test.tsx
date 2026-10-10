/**
 * A folder with no repository (bw-56ci2.1).
 *
 * The panel used to draw every control it has — branch, Fetch, Pull, Push, the
 * commit box, the history — over a folder git knows nothing about, with git's
 * refusal in red above them. None of them can work there. The panel now says
 * the folder is not a repository and offers the one thing that can be done.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type GitStatus } from '@/lib/api';
import { ChatRightRail } from '@/workbench/chat-right-rail';
import { forgetRepositoryStatus } from '@/workbench/repository-status';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const calls = vi.hoisted(() => ({
  status: vi.fn(),
  log: vi.fn(),
  init: vi.fn(),
  branches: vi.fn(),
  watch: vi.fn(() => () => {}),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const FOLDER = '/tmp/a-plain-folder';

const NOT_A_REPOSITORY = 'fatal: not a git repository (or any of the parent directories): .git';

function noRepository() {
  return new ApiError(`API error: 422 ${NOT_A_REPOSITORY}`, 422, {
    error: NOT_A_REPOSITORY,
    notARepository: true,
  });
}

const NEW_REPOSITORY: GitStatus = {
  branch: 'main',
  upstream: null,
  pushTo: null,
  ahead: 0,
  behind: 0,
  detached: false,
  staged: [],
  unstaged: [],
  untracked: [{ path: 'notes.txt' }],
  conflicted: [],
};

function railOnGit() {
  return render(
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
      projectPath={FOLDER}
      desktopWidth={320}
      onToggle={() => {}}
    />,
  );
}

describe('a folder with no repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forgetRepositoryStatus();
    calls.status.mockRejectedValue(noRepository());
    // The log refuses in git's plain words, with no mark: only status says
    // whether there is a repository.
    calls.log.mockRejectedValue(
      new ApiError(`API error: 422 ${NOT_A_REPOSITORY}`, 422, { error: NOT_A_REPOSITORY }),
    );
    calls.branches.mockRejectedValue(noRepository());
    calls.init.mockResolvedValue({ ok: true });
  });

  it('says so and draws none of the controls that need a repository', async () => {
    railOnGit();

    expect(await screen.findByTestId('git-no-repository')).toBeTruthy();
    expect(screen.getByText('Not a Git repository')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Initialize repository' })).toBeTruthy();

    for (const gone of [
      'git-branch',
      'git-fetch',
      'git-pull',
      'git-push',
      'git-commit',
      'git-commit-message',
      'git-refresh',
      'git-error',
    ]) {
      expect(screen.queryByTestId(gone), gone).toBeNull();
    }
  });

  it('initializes the repository and then draws the panel', async () => {
    railOnGit();
    const button = await screen.findByTestId('git-init');

    calls.status.mockResolvedValue(NEW_REPOSITORY);
    calls.log.mockResolvedValue({ commits: [] });
    calls.branches.mockResolvedValue({ branches: [] });
    fireEvent.click(button);

    await waitFor(() => expect(calls.init).toHaveBeenCalledWith(FOLDER));
    expect(await screen.findByTestId('git-commit')).toBeTruthy();
    expect(screen.queryByTestId('git-no-repository')).toBeNull();
    expect(screen.getByTestId('git-untracked')).toBeTruthy();
  });

  it('keeps the empty state and shows the reason when it cannot initialize', async () => {
    const said = 'fatal: cannot mkdir .git: Permission denied';
    calls.init.mockRejectedValue(new ApiError(`API error: 422 ${said}`, 422, { error: said }));
    railOnGit();

    fireEvent.click(await screen.findByTestId('git-init'));

    expect((await screen.findByTestId('git-error')).textContent).toBe(said);
    expect(screen.getByTestId('git-no-repository')).toBeTruthy();
  });

  it('still shows any other failed read as an error over the panel', async () => {
    const said = 'fatal: bad object HEAD';
    calls.status.mockRejectedValue(new ApiError(`API error: 422 ${said}`, 422, { error: said }));
    calls.log.mockRejectedValue(new ApiError(`API error: 422 ${said}`, 422, { error: said }));
    railOnGit();

    expect((await screen.findByTestId('git-error')).textContent).toBe(said);
    expect(screen.queryByTestId('git-no-repository')).toBeNull();
    expect(screen.getByTestId('git-push')).toBeTruthy();
  });
});
