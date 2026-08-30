/**
 * A Stop that does not stop anything, and whether he is told (bw-sxzv.4).
 *
 * The button sent its command and threw the answer away. When the command was
 * refused — which is what happens in a chat whose agent is already gone — the
 * rejection went nowhere at all: no line, no change to the button, and the chip
 * beside it still saying Thinking. He clicked it again, and again, because
 * there was nothing on the screen to suggest clicking it was pointless.
 *
 * That is worst exactly where it matters most. Stop is the last thing left to
 * try in a chat that has already broken, so a Stop that fails in silence turns
 * one broken chat into a screen he cannot read at all.
 *
 * The chat around the button is stood in for down to the two things this is
 * about: that the chat is working, so the button is drawn, and what the server
 * says back when it is pressed.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { answering } = vi.hoisted(() => ({ answering: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/** A chat mid-answer, and a server that says what it thinks of a Stop. */
vi.mock('@/workbench/use-session', async (real) => {
  const actual = await real<typeof import('@/workbench/use-session')>();
  const { EMPTY } = await import('@/workbench/fold');
  return {
    ...actual,
    sendCommand: answering,
    useSession: () => ({ ...EMPTY, state: 'thinking' as const, stateLabel: 'Thinking', loadOlder: null }),
    useSessionFacts: () => null,
  };
});

vi.mock('@/workbench/live', () => ({
  useHeardFromOutside: () => 0,
  useHeldFactsAreOld: () => false,
  useHolds: () => new Map(),
  useLiveSessions: () => [],
  usePlanUsage: () => ({ available: false, plan: null, session: null, week: null, opus: null, at: null }),
  useRunningElsewhere: () => new Set<string>(),
}));

vi.mock('@/workbench/chat-sidebar', () => ({ ChatSidebar: () => null }));
vi.mock('@/workbench/chat-right-rail', () => ({
  ChatRightRail: () => null,
  useRightRail: (): [boolean, () => void] => [false, () => {}],
  useGitPanel: (): [boolean, () => void] => [false, () => {}],
}));
vi.mock('@/workbench/paths-on-disk', () => ({
  usePathsOnDisk: () => ({ real: () => false, home: '/home/me', ask: () => {} }),
}));
vi.mock('@/workbench/known-cards', () => ({
  useKnownCards: () => new Set<string>(),
  useKnownCardStatuses: () => new Map<string, string>(),
}));

const { default: ChatTab } = await import('@/workbench/chat-tab');

const PROJECT = 'p1';
const PATH = '/home/me/project';

/** What the server does with the Stop, set per case. */
let stopping: () => Promise<unknown>;

/** The chat on screen, working, with its Stop button in reach. */
async function aWorkingChat(): Promise<HTMLElement> {
  render(<ChatTab projectId={PROJECT} projectPath={PATH} openSessionId="s1" />);
  // Let the screen finish asking its own opening questions, so what shows up
  // afterwards is the answer to the click and nothing else.
  await act(async () => {});
  return screen.getByTestId('stop-button');
}

beforeEach(() => {
  stopping = async () => undefined;
  answering.mockReset();
  // The screen asks for a few things of its own on the way up — what the
  // provider's defaults are, and so on. Only the Stop is this test's business;
  // the rest are answered plainly so nothing else goes red.
  answering.mockImplementation(async (cmd: { type: string }) =>
    cmd.type === 'session.stop' ? stopping() : { model: null, effort: null });
  // The live store and the picture loader both reach for the browser's own
  // things, which a bench has none of. Neither is what this is about.
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

describe('Stop, refused', () => {
  it('says so on his screen, in the server’s own words', async () => {
    stopping = () => Promise.reject(new Error('That chat is no longer running.'));

    fireEvent.click(await aWorkingChat());

    const said = await screen.findByTestId('send-error');
    expect(said).toHaveTextContent('The chat could not be stopped.');
    // Why it failed, not only that it did: the two reasons a Stop is refused —
    // the agent is gone, or another program holds the chat — call for different
    // things from him, and only the server knows which one this was.
    expect(said).toHaveTextContent('That chat is no longer running.');
  });

  it('and asks for the stop it was told to ask for', async () => {
    stopping = () => Promise.reject(new Error('That chat is no longer running.'));

    fireEvent.click(await aWorkingChat());
    await screen.findByTestId('send-error');

    expect(answering).toHaveBeenCalledWith({ type: 'session.stop', sessionId: 's1' });
  });

  it('and the line goes when he tries again', async () => {
    // A stale complaint under a button he has just pressed reads as a fresh
    // one. The second press clears it before it asks.
    stopping = () => Promise.reject(new Error('That chat is no longer running.'));
    const stop = await aWorkingChat();
    fireEvent.click(stop);
    await screen.findByTestId('send-error');

    stopping = () => new Promise(() => {});
    fireEvent.click(stop);

    expect(screen.queryByTestId('send-error')).toBeNull();
  });
});

describe('Stop, taken', () => {
  it('says nothing at all', async () => {
    stopping = async () => undefined;

    fireEvent.click(await aWorkingChat());
    await act(async () => {});

    expect(screen.queryByTestId('send-error')).toBeNull();
  });
});
