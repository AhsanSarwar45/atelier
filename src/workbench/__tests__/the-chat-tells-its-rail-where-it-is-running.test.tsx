/**
 * Which folder the chat hands its rail (bw-rx1y.1).
 *
 * The rail reads git against whatever folder it is given, so the answer to
 * "whose repository is this" is really decided one level up, in the chat. The
 * chat knows where it is running — SessionFacts.cwd, the folder its agent was
 * started in — and that is what goes down. The project's checkout is only what
 * stands in for the moment before those facts have come back.
 *
 * The rail itself is stood in for here, down to the one prop this is about;
 * what the rail does with it is proved next door, in
 * the-git-rail-reads-the-chats-own-worktree.
 */
import { act, render } from '@testing-library/react';
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

/** The one thing asked of the rail: which folder it was pointed at. */
const pointedAt = vi.hoisted(() => vi.fn());

vi.mock('@/workbench/chat-right-rail', () => ({
  ChatRightRail: ({ workingIn }: { workingIn?: string | null }) => {
    pointedAt(workingIn);
    return null;
  },
  useRightRail: (): [boolean, () => void] => [true, () => {}],
  useGitPanel: (): [boolean, () => void] => [true, () => {}],
  useGitDiff: () => ({ diffOpen: false, flipDiff: () => {} }),
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
const WORKTREE = '/home/me/beads-web/worktrees/bw-rx1y.1';

function factsIn(cwd: string): SessionFacts {
  return { cwd, folder: cwd.split('/').pop() ?? cwd, branch: 'bw-rx1y.1' } as SessionFacts;
}

/** The chat on screen, its opening questions already asked and answered. */
async function chat() {
  render(<ChatTab projectId="beads-web" projectPath={PROJECT} openSessionId="s1" />);
  await act(async () => {});
}

beforeEach(() => {
  facts.of = null;
  pointedAt.mockReset();
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

describe('the chat tells its rail where it is running', () => {
  it('hands over its own worktree when that is where its agent was started', async () => {
    facts.of = factsIn(WORKTREE);

    await chat();

    expect(pointedAt).toHaveBeenLastCalledWith(WORKTREE);
  });

  it('hands over the project when the chat is running in the checkout itself', async () => {
    facts.of = factsIn(PROJECT);

    await chat();

    expect(pointedAt).toHaveBeenLastCalledWith(PROJECT);
  });

  it('stands the project in while the chat’s facts are still on their way', async () => {
    facts.of = null;

    await chat();

    // Not null: a rail told nothing says "No project directory for this chat",
    // which for the usual case — a chat in the checkout — is simply false.
    expect(pointedAt).toHaveBeenLastCalledWith(PROJECT);
  });
});
