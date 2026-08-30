/**
 * A complaint about a chat he has already left (bw-o83v).
 *
 * One tab serves every chat in a project, and it is never remounted when he
 * opens a different one — only told which chat is open now. The two lines that
 * report a refusal were held on that tab rather than on the chat, and nothing
 * cleared them when the open chat changed. So a pick refused in one chat stayed
 * drawn under the composer of the next, and the next, until some later pick in
 * some other chat happened to clear it.
 *
 * That reads as a fresh failure every time, about whatever is on screen now.
 * The chat around the lines is stood in for down to what raises them.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { answering } = vi.hoisted(() => ({ answering: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/** A working chat that announces an effort to pick, and a server that refuses. */
vi.mock('@/workbench/use-session', async (real) => {
  const actual = await real<typeof import('@/workbench/use-session')>();
  const { EMPTY } = await import('@/workbench/fold');
  return {
    ...actual,
    sendCommand: answering,
    useSession: () => ({
      ...EMPTY,
      state: 'thinking' as const,
      stateLabel: 'Thinking',
      loadOlder: null,
      menu: { ...EMPTY.menu, efforts: [{ value: 'high', displayName: 'High' }] },
    }),
    useSessionFacts: () => null,
  };
});

vi.mock('@/workbench/live', () => ({
  useHeldFactsAreOld: () => false,
  useHeardFromOutside: () => 0,
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

beforeEach(() => {
  answering.mockReset();
  // Everything the screen asks for on the way up is answered plainly; the two
  // commands these cases are about are refused.
  answering.mockImplementation(async (cmd: { type: string }) => {
    if (cmd.type === 'session.effort') throw new Error('That chat would not take the effort.');
    if (cmd.type === 'session.stop') throw new Error('That chat is no longer running.');
    return { model: null, effort: null };
  });
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

/** The chat on screen, with its composer in reach. */
async function aChatOn(sessionId: string) {
  const drawn = render(<ChatTab projectId={PROJECT} projectPath={PATH} openSessionId={sessionId} />);
  // Let the screen finish asking its own opening questions, so what shows up
  // afterwards is the answer to the click and nothing else.
  await act(async () => {});
  return drawn;
}

/** Open the effort picker and take the level it offers, which is refused. */
async function pickAnEffort(): Promise<void> {
  const trigger = screen.getAllByTestId('effort-picker')[0]!;
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  const option = (await screen.findAllByTestId('effort-picker-option'))[0]!;
  // The refusal comes back after the click, so the line it draws is a second
  // settling of the screen, not part of the click itself.
  await act(async () => { fireEvent.click(option); });
}

describe('the line a refused pick draws', () => {
  it('goes when he opens another chat, so it cannot complain about that one', async () => {
    const { rerender } = await aChatOn('s1');
    await pickAnEffort();
    expect(await screen.findByTestId('steer-error')).toHaveTextContent('That chat would not take the effort.');

    // The same tab, told a different chat is open — which is all that happens
    // when he clicks one in the list.
    rerender(<ChatTab projectId={PROJECT} projectPath={PATH} openSessionId="s2" />);
    await act(async () => {});

    expect(screen.queryByTestId('steer-error')).toBeNull();
  });

  it('stays while he is still in the chat that raised it', async () => {
    // The clearing is the chat changing, not the screen drawing again: a line
    // that vanished on the next render would be no line at all.
    const { rerender } = await aChatOn('s1');
    await pickAnEffort();
    await screen.findByTestId('steer-error');

    rerender(<ChatTab projectId={PROJECT} projectPath={PATH} openSessionId="s1" />);
    await act(async () => {});

    expect(screen.getByTestId('steer-error')).toHaveTextContent('That chat would not take the effort.');
  });
});

describe('the line a refused message draws', () => {
  it('goes the same way when he opens another chat', async () => {
    const { rerender } = await aChatOn('s1');
    fireEvent.click(screen.getByTestId('stop-button'));
    expect(await screen.findByTestId('send-error')).toHaveTextContent('That chat is no longer running.');

    rerender(<ChatTab projectId={PROJECT} projectPath={PATH} openSessionId="s2" />);
    await act(async () => {});

    expect(screen.queryByTestId('send-error')).toBeNull();
  });
});
