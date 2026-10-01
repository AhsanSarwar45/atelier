/**
 * The diff beside the conversation (bw-v79ny.4).
 *
 * It used to stand IN the conversation's place, and only while three switches
 * agreed: the rail open, the rail on Git, and the diff asked for. A chat picked
 * from the list then seemed not to open at all — it had opened, behind the
 * diff. Now the diff is a pane of its own beside the conversation, with its own
 * header and its own close, so one switch is all there is and nothing else on
 * the screen can be hiding it.
 *
 * A phone has no room for two panes, so there the diff still takes the
 * conversation's place (bw-rx1y.4), and the place the reader had got to in the
 * conversation is still theirs when they come back — which is why the
 * transcript is hidden there rather than unmounted.
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
  useChatNames: () => new Map(),
  useHeardFromOutside: () => 0,
  useHeldFactsAreOld: () => false,
  useHolds: () => new Map(),
  useLiveSessions: () => [],
  useLiveSessionWhere: () => undefined,
  usePlanUsage: () => ({ available: false, plan: null, session: null, week: null, opus: null, at: null }),
  useRunningElsewhere: () => new Set<string>(),
  useRunningSaidAt: () => null,
}));

vi.mock('@/workbench/chat-sidebar', () => ({ ChatSidebar: () => null }));

/** The three switches, held by the test so a case can set any of them. */
const switches = vi.hoisted(() => ({ right: true, git: true, diff: true }));
/** The diff's one switch, flipped. */
const flipDiff = vi.hoisted(() => vi.fn());
/** What the rail was handed, so the button's way home can be checked. */
const railGot = vi.hoisted(() => vi.fn());

vi.mock('@/workbench/chat-right-rail', () => ({
  ChatRightRail: (props: { diffOpen?: boolean; onFlipDiff?: () => void }) => {
    railGot(props);
    return null;
  },
  useLeftRail: (): [boolean, () => void] => [true, () => {}],
  useRightRail: (): [boolean, () => void] => [switches.right, () => {}],
  useGitPanel: (): [boolean, () => void] => [switches.git, () => {}],
  useGitDiff: () => ({ diffOpen: switches.diff, flipDiff }),
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

/**
 * What a phone answers when the app asks. jsdom's own `matchMedia` says no to
 * every query, which is the wide screen; a phone case has to say so itself.
 */
function phoneWidth() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  facts.of = factsIn(WORKTREE);
  switches.right = true;
  switches.git = true;
  switches.diff = true;
  railGot.mockReset();
  flipDiff.mockReset();
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

describe('the chat shows its diff beside the conversation', () => {
  it('draws the diff beside the conversation, which stays in view', async () => {
    await chat();

    expect(screen.getByTestId('git-diff-pane')).toBeInTheDocument();
    expect(screen.getByTestId('chat-split')).toHaveAttribute('data-diff', 'beside');
    expect(transcriptShowing(), 'the diff hid the conversation').toBe(true);
    expect(screen.getByTestId('composer-frame')).toBeInTheDocument();
    // Against the chat's OWN worktree, which for a chat in a worktree is not
    // the project's checkout.
    expect(diffPointedAt).toHaveBeenLastCalledWith(WORKTREE);
  });

  it('says in its header what it shows, and closes from there or with Esc', async () => {
    await chat();

    expect(screen.getByTestId('git-diff-header')).toHaveTextContent('Uncommitted changes');
    expect(screen.getByTestId('git-diff-header')).toHaveTextContent('bw-rx1y.4');
    fireEvent.click(screen.getByTestId('git-diff-close'));
    expect(flipDiff).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByTestId('git-diff-pane'), { key: 'Escape' });
    expect(flipDiff).toHaveBeenCalledTimes(2);
  });

  it('keeps the conversation alone when the reader has not asked for the diff', async () => {
    switches.diff = false;
    await chat();

    expect(screen.queryByTestId('git-diff-pane')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-split')).not.toHaveAttribute('data-diff');
    expect(transcriptShowing()).toBe(true);
  });

  it('does not hang off the rail: shut, or on another view, the diff stays', async () => {
    switches.right = false;
    switches.git = false;
    await chat();

    expect(
      screen.queryByTestId('git-diff-pane'),
      'the diff went away with a panel the reader did not close it from',
    ).toBeInTheDocument();
    expect(transcriptShowing()).toBe(true);
  });

  it('takes the conversation’s place on a phone, where there is room for one', async () => {
    phoneWidth();
    switches.right = false;
    await chat();

    expect(screen.getByTestId('git-diff-pane')).toBeInTheDocument();
    expect(transcriptShowing()).toBe(false);
  });

  // The one press back on a phone lives on the app's bar (`chat-diff-back`),
  // which is a portal into the shell this test does not draw. It is proved
  // where it is used, driven at 390px: tests/e2e/the-git-diff-on-a-phone.spec.ts.

  it('hands the rail the switch and the way to flip it', async () => {
    await chat();

    const handed = railGot.mock.calls.at(-1)![0];
    expect(handed.diffOpen).toBe(true);
    expect(typeof handed.onFlipDiff).toBe('function');
  });

  it('gives a phone reader back the line they were on when the diff goes away', async () => {
    phoneWidth();
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
