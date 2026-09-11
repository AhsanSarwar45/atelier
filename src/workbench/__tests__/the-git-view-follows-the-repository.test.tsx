/**
 * The Git panel keeping up with a repository that moves without it (bw-8nwh.2).
 *
 * The panel used to read git once, when it was opened, and then only after its
 * own actions — so a commit or a push made in a terminal, or by an agent
 * working in the same checkout, left "2 ahead" on the screen for as long as
 * nobody thought to press refresh. Worse than a stale number: it is a number
 * that looks current.
 *
 * The server watches the repository's git directory and says so on the
 * window's one connection; what is asserted here is the panel's half of that —
 * that it listens while it is on screen, reads git again on being told, does
 * not run two of those reads over each other, comes back to a window the
 * reader returns to, looks slowly for a working-tree edit the watcher cannot
 * see, and lets go of all of it when it goes away. That the watcher really
 * fires on a real commit is the server's half, proved against the real `git`
 * binary in `server/src/routes/git_watch.rs`.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitStatus } from '@/lib/api';
import { ChatRightRail } from '@/workbench/chat-right-rail';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

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
  watch: vi.fn(),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const REPO = '/tmp/a-project';

/** Whoever the panel gave the server's watcher to watch on its behalf. */
let told: (() => void) | null = null;
/** Whether the panel let that watch go. */
let stopped = false;

function standing(ahead: number): GitStatus {
  return {
    branch: 'main',
    upstream: 'origin/main',
    pushTo: null,
    ahead,
    behind: 0,
    detached: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
}

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

/** The panel drawn, with its first read already done. */
async function openPanel() {
  const drawn = railOnGit();
  await waitFor(() => expect(calls.status).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId('git-ahead')).toHaveAttribute('data-count', '2'));
  return drawn;
}

describe('the Git panel follows a repository that changes outside it', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    told = null;
    stopped = false;
    calls.status.mockResolvedValue(standing(2));
    calls.log.mockResolvedValue({ commits: [] });
    calls.watch.mockImplementation((_path: string, onChange: () => void) => {
      told = onChange;
      return () => {
        stopped = true;
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks to be told about the repository it is pointed at', async () => {
    await openPanel();
    expect(calls.watch).toHaveBeenCalledWith(REPO, expect.any(Function));
  });

  it('reads git again when the repository moves, without anybody pressing refresh', async () => {
    await openPanel();

    // Somebody pushes from a terminal: the branch is level with the shared
    // copy now, and the server says the git directory moved.
    calls.status.mockResolvedValue(standing(0));
    told?.();

    await waitFor(() =>
      expect(
        screen.getByTestId('git-ahead'),
        'the panel went on drawing a count the push had already made wrong',
      ).toHaveAttribute('data-count', '0'),
    );
    // And no hand touched the button that would have done it.
    expect(screen.getByTestId('git-refresh')).toBeEnabled();
  });

  it('never runs two reads over each other, and still reads once more after a burst', async () => {
    await openPanel();

    // A read the test holds open, so the burst below lands while it is in
    // flight — which is exactly what a push does: several refs in a moment.
    let answer: (status: GitStatus) => void = () => {};
    calls.status.mockImplementationOnce(
      () => new Promise<GitStatus>((settle) => (answer = settle)),
    );
    const readsBefore = calls.status.mock.calls.length;

    told?.();
    await waitFor(() => expect(calls.status.mock.calls.length).toBe(readsBefore + 1));
    told?.();
    told?.();
    told?.();
    // Still the one, however many times it was told.
    expect(calls.status.mock.calls.length).toBe(readsBefore + 1);

    calls.status.mockResolvedValue(standing(0));
    answer(standing(2));

    // One more read for the whole burst, not three.
    await waitFor(() => expect(calls.status.mock.calls.length).toBe(readsBefore + 2));
    await waitFor(() => expect(screen.getByTestId('git-ahead')).toHaveAttribute('data-count', '0'));
    expect(calls.status.mock.calls.length).toBe(readsBefore + 2);
  });

  it('looks again when the window is come back to', async () => {
    await openPanel();
    const readsBefore = calls.status.mock.calls.length;

    calls.status.mockResolvedValue(standing(0));
    fireEvent.focus(window);

    await waitFor(() => expect(screen.getByTestId('git-ahead')).toHaveAttribute('data-count', '0'));
    expect(calls.status.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it('looks slowly for a working-tree edit, which the watcher cannot see', async () => {
    // A file changed on disk moves nothing inside the git directory, so
    // nothing is ever said about it; this is the only thing that finds it.
    vi.useFakeTimers();
    railOnGit();
    await vi.waitFor(() => expect(calls.status).toHaveBeenCalled());
    const readsBefore = calls.status.mock.calls.length;

    await vi.advanceTimersByTimeAsync(5_000);

    expect(calls.status.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  it('lets go of the watch when the panel goes away', async () => {
    const drawn = await openPanel();
    expect(stopped).toBe(false);

    drawn.unmount();

    expect(stopped, 'the panel left a watch running behind it').toBe(true);
  });
});
