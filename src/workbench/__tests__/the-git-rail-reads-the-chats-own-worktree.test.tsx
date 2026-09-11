/**
 * Whose repository the Git rail is reading (bw-rx1y.1).
 *
 * The rail was handed the project's checkout and nothing else, so a chat
 * started in worktrees/X — which is how most of the work on this board is done
 * — showed the branch and the changes of a tree its agent never touches. The
 * numbers were real, they were just somebody else's, which is the worst kind
 * of wrong number to put beside a conversation.
 *
 * What the rail reads git against is the chat's own folder, SessionFacts.cwd,
 * and the project's checkout only stands in while those facts are still on
 * their way. The cards beside it stay the project's: a card belongs to the
 * board, not to a worktree.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitStatus } from '@/lib/api';
import { ChatRightRail } from '@/workbench/chat-right-rail';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const calls = vi.hoisted(() => ({
  status: vi.fn(),
  log: vi.fn(),
  watch: vi.fn(),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const cardsAskedFor = vi.hoisted(() => vi.fn());

vi.mock('@/workbench/known-cards', () => ({
  useKnownCards: () => new Set<string>(),
  useKnownCardStatuses: (path: string | null) => {
    cardsAskedFor(path);
    return new Map<string, string>();
  },
}));

const PROJECT = '/home/me/beads-web';
const WORKTREE = '/home/me/beads-web/worktrees/bw-rx1y.1';

function on(branch: string): GitStatus {
  return {
    branch,
    upstream: null,
    pushTo: null,
    ahead: 0,
    behind: 0,
    detached: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
}

function rail(workingIn: string | null) {
  return render(
    <ChatRightRail
      projectId="beads-web"
      cards={[]}
      agents={[]}
      items={[]}
      sessionId="chat-1"
      agentControls={[]}
      onOpenAgent={() => {}}
      open
      view="git"
      projectPath={PROJECT}
      workingIn={workingIn}
      desktopWidth={320}
      onToggle={() => {}}
    />,
  );
}

describe('the Git rail reads the chat’s own worktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.status.mockImplementation(async (path: string) =>
      on(path === WORKTREE ? 'bw-rx1y.1' : 'main'));
    calls.log.mockResolvedValue({ commits: [] });
    calls.watch.mockReturnValue(() => {});
  });

  it('asks git about the folder the chat is running in, not the project’s checkout', async () => {
    rail(WORKTREE);

    await waitFor(() => expect(calls.status).toHaveBeenCalledWith(WORKTREE, expect.anything()));
    expect(calls.status).not.toHaveBeenCalledWith(PROJECT, expect.anything());
    // The branch on screen is the worktree's, which is the whole point: it is
    // the line of work this chat's agent is committing onto.
    await waitFor(() => expect(screen.getByTestId('git-branch-name')).toHaveTextContent('bw-rx1y.1'));
    // And it listens to that tree for changes, not to the checkout.
    expect(calls.watch).toHaveBeenCalledWith(WORKTREE, expect.any(Function));
  });

  it('falls back to the project’s checkout for a chat that has no folder of its own', async () => {
    rail(null);

    await waitFor(() => expect(calls.status).toHaveBeenCalledWith(PROJECT, expect.anything()));
    await waitFor(() => expect(screen.getByTestId('git-branch-name')).toHaveTextContent('main'));
  });

  it('leaves nothing of the project on screen when the chat’s folder arrives late', async () => {
    // Facts are a round trip away, so the first paint has only the project to
    // go on and draws main.
    const drawn = rail(null);
    await waitFor(() => expect(screen.getByTestId('git-branch-name')).toHaveTextContent('main'));

    drawn.rerender(
      <ChatRightRail
        projectId="beads-web"
        cards={[]}
        agents={[]}
        items={[]}
        sessionId="chat-1"
        agentControls={[]}
        onOpenAgent={() => {}}
        open
        view="git"
        projectPath={PROJECT}
        workingIn={WORKTREE}
        desktopWidth={320}
        onToggle={() => {}}
      />,
    );

    // The view is a fresh one, not the old one with a new path: before the
    // worktree's own answer is back there is nothing on the branch line at
    // all. The project's `main` sitting there until the read returns would be
    // a wrong answer worn confidently, which is what the key is for.
    expect(screen.getByTestId('git-branch-name')).not.toHaveTextContent('main');

    await waitFor(() => expect(screen.getByTestId('git-branch-name')).toHaveTextContent('bw-rx1y.1'));
  });

  it('still reads the project’s cards, which belong to the board and not to a worktree', () => {
    rail(WORKTREE);

    expect(cardsAskedFor).toHaveBeenCalledWith(PROJECT);
    expect(cardsAskedFor).not.toHaveBeenCalledWith(WORKTREE);
  });
});
