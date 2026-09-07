/**
 * The diff standing in the conversation's own place (bw-rx1y.4).
 *
 * The chat is the only thing on the screen wide enough to read a side-by-side
 * diff in, so the diff takes the centre rather than a third column — but only
 * while all three of the reader's switches say so: the rail open, the rail on
 * Git, and the diff asked for. Shutting the rail or leaving the Git view is the
 * reader putting the whole subject away, and the conversation has to come back
 * on its own, without their remembering a switch two panels deep.
 *
 * The status line above and the box below do not move either way, and the place
 * the reader had got to in the conversation is still theirs when they come
 * back — which is why the transcript is hidden rather than unmounted.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionFacts } from '@/workbench/protocol';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/** What the chat's own facts say, set per case. */
const { facts } = vi.hoisted(() => ({ facts: { of: null as SessionFacts | null } }));

vi.mock('@/workbench/use-session', async (real) => {
  const actual = await real<typeof import('@/workbench/use-session')>();
  const { EMPTY } = await import('@/workbench/fold');
  return {
    ...actual,
    sendCommand: vi.fn(async () => ({ model: null, effort: null })),
    useSession: () => ({ ...EMPTY, state: 'idle' as const, stateLabel: 'Idle', loadOlder: null }),
    useSessionFacts: () => facts.of,
    useSessionFactsRead: () => (facts.of ? { facts: facts.of, at: Date.now() } : null),
  };
});

vi.mock('@/workbench/live', () => ({
  useHeardFromOutside: () => 0,
  useHeldFactsAreOld: () => false,
  useHolds: () => new Map(),
  useLiveSessions: () => [],
  usePlanUsage: () => ({ available: false, plan: null, session: null, week: null, opus: null, at: null }),
  useRunningElsewhere: () => new Set<string>(),
  useRunningSaidAt: () => null,
}));

vi.mock('@/workbench/chat-sidebar', () => ({ ChatSidebar: () => null }));

/** The three switches, held by the test so a case can set any of them. */
const switches = vi.hoisted(() => ({ right: true, git: true, diff: true }));
/** What the rail was handed, so the button's way home can be checked. */
const railGot = vi.hoisted(() => vi.fn());

vi.mock('@/workbench/chat-right-rail', () => ({
  ChatRightRail: (props: { diffOpen?: boolean; onFlipDiff?: () => void }) => {
    railGot(props);
    return null;
  },
  useRightRail: (): [boolean, () => void] => [switches.right, () => {}],
  useGitPanel: (): [boolean, () => void] => [switches.git, () => {}],
  useGitDiff: () => ({ diffOpen: switches.diff, flipDiff: () => {} }),
}));

/** The diff itself is proved next door; here only that it is drawn, and where. */
const diffPointedAt = vi.hoisted(() => vi.fn());

vi.mock('@/workbench/git-diff-view', () => ({
  GitDiffView: ({ path }: { path: string | null }) => {
    diffPointedAt(path);
    return <div data-testid="git-diff-view-stub" />;
  },
}));

vi.mock('@/workbench/paths-on-disk', () => ({
  usePathsOnDisk: () => ({ real: () => false, home: '/home/me', ask: () => {} }),
}));

vi.mock('@/workbench/known-cards', () => ({
  useKnownCards: () => new Set<string>(),
  useKnownCardStatuses: () => new Map<string, string>(),
}));

const { default: ChatTab } = await import('@/workbench/chat-tab');

const PROJECT = '/home/me/beads-web';
const WORKTREE = '/home/me/beads-web/worktrees/bw-rx1y.4';

function factsIn(cwd: string): SessionFacts {
  return { cwd, folder: cwd.split('/').pop() ?? cwd, branch: 'bw-rx1y.4' } as SessionFacts;
}

async function chat() {
  const drawn = render(<ChatTab projectId="beads-web" projectPath={PROJECT} openSessionId="s1" />);
  await act(async () => {});
  return drawn;
}

/** The conversation's own pane, which is on screen whether or not it is shown. */
function transcript() {
  return screen.getByTestId('transcript');
}

/** Whether the conversation is what the reader is actually looking at. */
function transcriptShowing() {
  // Hidden rather than unmounted, so "gone" is a class on a pane that is still
  // there — and the whole point of the choice is that it is still there.
  return !transcript().parentElement!.className.split(/\s+/).includes('hidden');
}

beforeEach(() => {
  facts.of = factsIn(WORKTREE);
  switches.right = true;
  switches.git = true;
  switches.diff = true;
  railGot.mockReset();
  diffPointedAt.mockReset();
  vi.stubGlobal('WebSocket', class {
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    close(): void {}
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the chat swaps its transcript for the diff, and only on all three switches', () => {
  it('draws the diff in the conversation’s place when every switch is on', async () => {
    await chat();

    expect(screen.getByTestId('git-diff-pane')).toBeInTheDocument();
    expect(transcriptShowing(), 'the conversation was drawn over the diff').toBe(false);
    // Against the chat's OWN worktree, which for a chat in a worktree is not
    // the project's checkout.
    expect(diffPointedAt).toHaveBeenLastCalledWith(WORKTREE);
  });

  it('leaves the status line above and the box below exactly where they were', async () => {
    await chat();

    expect(screen.getByTestId('git-diff-pane')).toBeInTheDocument();
    // The reader can go on talking to the agent while reading what it wrote.
    expect(screen.getByTestId('composer-frame')).toBeInTheDocument();
  });

  it('keeps the conversation when the reader has not asked for the diff', async () => {
    switches.diff = false;
    await chat();

    expect(screen.queryByTestId('git-diff-pane')).not.toBeInTheDocument();
    expect(transcriptShowing()).toBe(true);
  });

  it('brings the conversation back when the rail leaves the Git view', async () => {
    switches.git = false;
    await chat();

    expect(
      screen.queryByTestId('git-diff-pane'),
      'the diff outlived the panel whose button asked for it',
    ).not.toBeInTheDocument();
    expect(transcriptShowing()).toBe(true);
  });

  it('brings the conversation back when the rail is shut, which is what the phone’s drawer does', async () => {
    // The cross inside the drawer and the scrim behind it both call flipRight;
    // rightOpen goes false, and the diff goes with it — no code of its own.
    switches.right = false;
    await chat();

    expect(screen.queryByTestId('git-diff-pane')).not.toBeInTheDocument();
    expect(transcriptShowing()).toBe(true);
  });

  it('hands the rail the switch and the way to flip it', async () => {
    await chat();

    const handed = railGot.mock.calls.at(-1)![0];
    expect(handed.diffOpen).toBe(true);
    expect(typeof handed.onFlipDiff).toBe('function');
  });

  it('gives the reader back the line they were on when the diff goes away', async () => {
    switches.diff = false;
    const drawn = await chat();

    // The reader scrolls up into the history, away from the end.
    const pane = transcript();
    Object.defineProperty(pane, 'scrollHeight', { configurable: true, value: 4_000 });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 600 });
    pane.scrollTop = 1_234;
    await act(async () => {
      fireEvent.scroll(pane);
    });

    switches.diff = true;
    await act(async () => {
      drawn.rerender(<ChatTab projectId="beads-web" projectPath={PROJECT} openSessionId="s1" />);
    });
    expect(screen.getByTestId('git-diff-pane')).toBeInTheDocument();
    // The very thing this proves: the same element, not a fresh one. An
    // unmounted transcript would take the virtualiser's measurements with it.
    expect(transcript()).toBe(pane);

    // A browser may forget where a hidden box was scrolled to; the chat does
    // not, so this is the worst case rather than an unlikely one.
    pane.scrollTop = 0;

    switches.diff = false;
    await act(async () => {
      drawn.rerender(<ChatTab projectId="beads-web" projectPath={PROJECT} openSessionId="s1" />);
    });

    expect(transcriptShowing()).toBe(true);
    expect(
      transcript().scrollTop,
      'coming back from the diff dropped the reader somewhere other than where they were',
    ).toBe(1_234);
  });
});
