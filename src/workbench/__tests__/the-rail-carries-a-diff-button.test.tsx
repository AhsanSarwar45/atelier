/**
 * The one button that swaps the conversation for the diff (bw-rx1y.4).
 *
 * It sits in the Git panel's branch header rather than on the tab bar above,
 * because it is a thing the reader reaches for while already looking at what
 * changed — and because the bar is full. What is asserted here is the rail's
 * half: that the switch is remembered for the browser, that the rail hands the
 * button down to the panel, and that a rail given no way to flip it draws no
 * button at all, since the diff itself is drawn a level up, in the chat.
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitStatus } from '@/lib/api';
import { ChatRightRail, useGitDiff } from '@/workbench/chat-right-rail';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const calls = vi.hoisted(() => ({
  status: vi.fn(),
  log: vi.fn(),
  branches: vi.fn(),
  watch: vi.fn(),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const REPO = '/tmp/a-worktree';

function standing(): GitStatus {
  return {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    detached: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
}

function railOnGit(over: { diffOpen?: boolean; onFlipDiff?: () => void } = {}) {
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
      {...over}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  calls.status.mockResolvedValue(standing());
  calls.log.mockResolvedValue({ commits: [] });
  calls.branches.mockResolvedValue({ branches: [] });
  calls.watch.mockReturnValue(() => {});
});

describe('the switch that puts the diff in the conversation’s place', () => {
  it('opens off, because a chat should open on the chat', () => {
    const { result } = renderHook(() => useGitDiff());
    expect(result.current.diffOpen).toBe(false);
  });

  it('remembers being turned on, for the browser and not for one chat', () => {
    const first = renderHook(() => useGitDiff());
    act(() => first.result.current.flipDiff());

    expect(localStorage.getItem('workbench.git-diff')).toBe('1');

    // A second chat, opened later, is drawn from what was remembered.
    const later = renderHook(() => useGitDiff());
    expect(later.result.current.diffOpen).toBe(true);
  });

  it('remembers being turned off again', () => {
    localStorage.setItem('workbench.git-diff', '1');
    const { result, rerender } = renderHook(() => useGitDiff());
    expect(result.current.diffOpen).toBe(true);

    act(() => result.current.flipDiff());
    rerender();

    expect(localStorage.getItem('workbench.git-diff')).toBe('0');
    expect(renderHook(() => useGitDiff()).result.current.diffOpen).toBe(false);
  });
});

describe('the rail hands the button down to the Git panel', () => {
  it('draws it on the branch line, quietly, when the diff is not showing', async () => {
    railOnGit({ diffOpen: false, onFlipDiff: () => {} });
    await waitFor(() => expect(screen.getByTestId('git-diff-toggle')).toBeInTheDocument());

    const button = screen.getByTestId('git-diff-toggle');
    expect(button).toHaveAttribute('aria-label', 'Show diff');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    // On the same line as the branch and the re-read, not in a row of its own.
    expect(screen.getByTestId('git-branch')).toContainElement(button);
  });

  it('says so loudly when the diff is what the reader is looking at', async () => {
    railOnGit({ diffOpen: true, onFlipDiff: () => {} });
    await waitFor(() => expect(screen.getByTestId('git-diff-toggle')).toBeInTheDocument());

    const button = screen.getByTestId('git-diff-toggle');
    expect(button).toHaveAttribute('aria-label', 'Hide diff');
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('asks the chat to flip it, having no view of its own to change', async () => {
    const asked = vi.fn();
    railOnGit({ diffOpen: false, onFlipDiff: asked });
    await waitFor(() => expect(screen.getByTestId('git-diff-toggle')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('git-diff-toggle'));

    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('draws no button at all when there is nothing for it to flip', async () => {
    railOnGit();
    await waitFor(() => expect(screen.getByTestId('git-branch')).toBeInTheDocument());
    expect(
      screen.queryByTestId('git-diff-toggle'),
      'a rail outside a chat offered a swap it could not make',
    ).not.toBeInTheDocument();
  });
});
