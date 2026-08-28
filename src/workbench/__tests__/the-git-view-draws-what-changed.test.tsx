/**
 * The rail's Git view, drawn from what git said (bw-8dp8.6).
 *
 * Four things have to be on the screen for this panel to be worth opening: the
 * changed files in the three groups git puts them in, the line of work the
 * project is on with how far it is from the shared copy, somewhere to write
 * what the change was, and the recent saved changes. This asserts all four off
 * one answer, and then that picking a file and saving it says the right thing
 * to the server.
 *
 * The server is not here — it is being written against the same route contract
 * by somebody else — so the calls are stood in for. What that leaves this
 * proving is exactly the half that is mine: what is drawn, and what is asked
 * for. Whether git does it is the end-to-end run's business.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitStatus } from '@/lib/api';
import { ChatRightRail } from '@/workbench/chat-right-rail';

// Nothing here draws a chip, but the rail's module reaches for the router.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

// Hoisted with the mock that uses it: `vi.mock` is lifted to the top of the
// file, and a plain const declared here is not yet initialised when it runs.
const calls = vi.hoisted(() => ({
  status: vi.fn(),
  log: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
  commit: vi.fn(),
  fetch: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
  branches: vi.fn(),
  checkout: vi.fn(),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const REPO = '/tmp/a-project';

/** One modified file, one new one, and one already picked — the fixture's shape. */
const CHANGED: GitStatus = {
  branch: 'a-line-of-work',
  upstream: 'origin/a-line-of-work',
  ahead: 2,
  behind: 3,
  detached: false,
  staged: [{ path: 'already-picked.ts', status: 'added', origPath: null }],
  unstaged: [{ path: 'src/changed.ts', status: 'modified', origPath: null }],
  untracked: [{ path: 'brand-new.ts' }],
  conflicted: [],
};

const HISTORY = {
  commits: [
    {
      sha: '1111111111111111111111111111111111111111',
      shortSha: '1111111',
      author: 'Somebody',
      email: 'somebody@example.com',
      date: '2026-08-27T10:00:00.000Z',
      subject: 'the change before this one',
    },
  ],
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
      projectPath={REPO}
      desktopWidth={320}
      onToggle={() => {}}
    />,
  );
}

describe('the Git view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.status.mockResolvedValue(CHANGED);
    calls.log.mockResolvedValue(HISTORY);
  });

  it('asks about the project the chat is open on', async () => {
    railOnGit();

    await waitFor(() => expect(calls.status).toHaveBeenCalled());
    expect(calls.status.mock.calls[0][0]).toBe(REPO);
    expect(calls.log.mock.calls[0][0]).toBe(REPO);
  });

  it('names the line of work, and how far it is from the shared copy', async () => {
    railOnGit();

    expect(await screen.findByTestId('git-branch-name')).toHaveTextContent('a-line-of-work');
    expect(screen.getByTestId('git-ahead')).toHaveTextContent('2');
    expect(screen.getByTestId('git-behind')).toHaveTextContent('3');
    expect(screen.getByTestId('git-upstream')).toHaveTextContent('origin/a-line-of-work');
  });

  it('puts each changed file in the group git put it in', async () => {
    railOnGit();

    const staged = await screen.findByTestId('git-staged');
    // By the whole path the row carries, not by the words on it: the name and
    // the folder it lives in are drawn as two pieces, so the folder can be the
    // half that gives way when the rail is narrow.
    expect(within(staged).getByTestId('git-file')).toHaveAttribute('data-path', 'already-picked.ts');
    expect(within(screen.getByTestId('git-unstaged')).getByTestId('git-file')).toHaveAttribute(
      'data-path',
      'src/changed.ts',
    );
    expect(within(screen.getByTestId('git-untracked')).getByTestId('git-file')).toHaveAttribute(
      'data-path',
      'brand-new.ts',
    );
    // And the name is still the part a reader sees whole.
    expect(within(screen.getByTestId('git-unstaged')).getByText('changed.ts')).toBeInTheDocument();
  });

  it('has somewhere to say what the change was, and the recent ones to read', async () => {
    railOnGit();

    expect(await screen.findByTestId('git-commit-message')).toBeInTheDocument();
    expect(within(screen.getByTestId('git-log')).getByText('the change before this one')).toBeInTheDocument();
    expect(screen.getByTestId('git-log')).toHaveTextContent('1111111');
  });

  it('picks one whole file, and then asks again rather than guessing', async () => {
    calls.stage.mockResolvedValue({ ok: true });
    railOnGit();

    const line = await screen.findByTestId('git-unstaged');
    fireEvent.click(within(line).getByRole('button', { name: 'Stage src/changed.ts' }));

    await waitFor(() => expect(calls.stage).toHaveBeenCalledWith(REPO, ['src/changed.ts']));
    // Twice: once on the way in, once because the repository has moved. A panel
    // that redraws from what it asked for is a panel that is wrong about a file
    // which is both staged and modified again.
    await waitFor(() => expect(calls.status).toHaveBeenCalledTimes(2));
  });

  it('will not commit until something is picked and something is typed', async () => {
    railOnGit();

    const save = await screen.findByTestId('git-commit');
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByTestId('git-commit-message'), { target: { value: 'what I did' } });
    expect(save).toBeEnabled();
  });

  it('saves the picked files under what was typed, and empties the box after', async () => {
    calls.commit.mockResolvedValue({ sha: 'abc1234' });
    railOnGit();

    const box = await screen.findByTestId('git-commit-message');
    fireEvent.change(box, { target: { value: '  what I did  ' } });
    fireEvent.click(screen.getByTestId('git-commit'));

    await waitFor(() => expect(calls.commit).toHaveBeenCalledWith(REPO, 'what I did'));
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it("hands back what git said, in git's own words, and keeps the message", async () => {
    calls.commit.mockRejectedValue(new Error('API error: 500 error: gpg failed to sign the data'));
    railOnGit();

    const box = await screen.findByTestId('git-commit-message');
    fireEvent.change(box, { target: { value: 'what I did' } });
    fireEvent.click(screen.getByTestId('git-commit'));

    const said = await screen.findByTestId('git-error');
    expect(said).toHaveTextContent('gpg failed to sign the data');
    // The app's own status number is not git's sentence and is not the reader's
    // business.
    expect(said).not.toHaveTextContent('API error');
    // A box emptied on the way out loses what the writer typed the moment git
    // refuses, and he has to write it again to find out if it was the message.
    expect(box).toHaveValue('what I did');
  });

  it('says so plainly when a project has changed nothing', async () => {
    calls.status.mockResolvedValue({ ...CHANGED, staged: [], unstaged: [], untracked: [] });
    railOnGit();

    expect(await screen.findByTestId('git-clean')).toBeInTheDocument();
    expect(screen.queryByTestId('git-staged')).not.toBeInTheDocument();
  });
});
