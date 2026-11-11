/**
 * The Tasks tab's New task button lands in a chat's composer (bw-bp53q.9):
 * `@task ` is waiting there, and the box has focus. "New chat" opens the New
 * chat dialog through the address, and the chat it starts gets the line.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { answering, address } = vi.hoisted(() => ({ answering: vi.fn(), address: { search: '' } }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(address.search),
}));

vi.mock('@/workbench/use-session', async (real) => {
  const actual = await real<typeof import('@/workbench/use-session')>();
  const { EMPTY } = await import('@/workbench/fold');
  return {
    ...actual,
    sendCommand: answering,
    useSession: () => ({ ...EMPTY, state: 'idle' as const, stateLabel: 'Idle', loadOlder: null }),
    useSessionFacts: () => null,
    useSessionFactsRead: () => null,
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
vi.mock('@/workbench/chat-right-rail', () => ({
  ChatRightRail: () => null,
  useLeftRail: (): [boolean, () => void] => [true, () => {}],
  useRightRail: (): [boolean, () => void] => [false, () => {}],
  useGitPanel: (): [boolean, () => void] => [false, () => {}],
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
const { readUnsentLine, writeUnsentLine } = await import('@/workbench/drafts');
const { startTaskIn, NEW_TASK_LINE } = await import('@/workbench/tasks/new-task');

const PROJECT = 'p1';
const PATH = '/home/me/project';

beforeEach(() => {
  answering.mockReset();
  answering.mockImplementation(async (cmd: { type: string }) => {
    if (cmd.type === 'providers.list') {
      return { providers: [{ brand: 'claude', name: 'Claude', available: true, path: '/bin/claude', installUrl: '', models: [] }] };
    }
    return { model: null, effort: null };
  });
  vi.stubGlobal('WebSocket', class {
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    close(): void {}
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response));
  address.search = '';
  writeUnsentLine('s1', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('New task in a chat that exists', () => {
  it('opens the chat with `@task ` in the composer, and the composer focused', async () => {
    startTaskIn('s1');
    render(<ChatTab projectId={PROJECT} projectPath={PATH} openSessionId="s1" />);
    await act(async () => {});
    const frame = screen.getByTestId('composer-frame');
    expect(readUnsentLine('s1')).toBe(NEW_TASK_LINE);
    expect(frame.querySelector('.cm-content')?.textContent ?? frame.textContent).toMatch(/@task|New task/);
    await waitFor(() => expect(frame.contains(document.activeElement)).toBe(true));
  });
});

describe('New task in a new chat', () => {
  it('opens the New chat dialog, and the chat it starts has `@task ` waiting', async () => {
    window.history.replaceState({ __NA: true }, '', '/project?id=p1&tab=chat&newchat=task');
    address.search = 'id=p1&tab=chat&newchat=task';
    const replace = vi.spyOn(window.history, 'replaceState');
    render(<ChatTab projectId={PROJECT} projectPath={PATH} openSessionId={null} />);
    await act(async () => {});
    expect(await screen.findByTestId('new-chat-provider-dialog')).toBeVisible();
    // The ask is let go of, so a reload or Back does not open the dialog again.
    expect(window.location.search).toBe('?id=p1&tab=chat');
    // With no state of Next's own, so Next follows it and the screen stops
    // reading the ask; carrying Next's state, the chat started next was pushed
    // with `newchat=task` still on it and the dialog opened a second time.
    expect(replace).toHaveBeenCalledWith(null, '', '/project?id=p1&tab=chat');
    replace.mockRestore();
    const start = screen.getByTestId('new-chat-start');
    await waitFor(() => expect(start).toBeEnabled());
    await act(async () => { fireEvent.click(start); });
    const started = answering.mock.calls.map(([cmd]) => cmd as { type: string; sessionId?: string }).find((cmd) => cmd.type === 'session.start');
    expect(started?.sessionId).toBeTruthy();
    expect(readUnsentLine(started!.sessionId!)).toBe(NEW_TASK_LINE);
  });
});
