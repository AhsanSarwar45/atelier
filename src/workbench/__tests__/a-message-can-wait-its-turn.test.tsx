/**
 * A message written while the agent is working (bw-r54j.4, bw-r54j.5).
 *
 * Before this, the only thing on the row while a chat worked was Stop, and the
 * only way to say anything was Enter — which interrupted the running turn, in
 * silence, with nothing on the screen to say that was what would happen. A
 * reader who wanted to add a thought had no way to see either choice, and a
 * reader on a phone had no way to make the second one at all.
 *
 * So the row now says what can be done: stop it, hold what was written, or
 * push it through now. Enter is the safe one and Cmd/Ctrl+Enter is the
 * deliberate one, and neither is needed, because both are buttons.
 *
 * The chat around them is stood in for down to what this is about: that the
 * chat is working, what it is holding, and what the server was asked for.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HeldMessage, SessionState } from '@/workbench/protocol';

const { answering, held, chatState } = vi.hoisted(() => ({
  answering: vi.fn(),
  held: { current: [] as HeldMessage[] },
  chatState: { current: 'thinking' as SessionState },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/** A chat mid-answer, holding whatever the case put in front of it. */
vi.mock('@/workbench/use-session', async (real) => {
  const actual = await real<typeof import('@/workbench/use-session')>();
  const { EMPTY } = await import('@/workbench/fold');
  return {
    ...actual,
    sendCommand: answering,
    useSession: () => ({
      ...EMPTY,
      state: chatState.current,
      stateLabel: chatState.current === 'thinking' ? 'Thinking' : null,
      held: held.current,
      loadOlder: null,
    }),
    useSessionFacts: () => null,
    useSessionFactsRead: () => null,
  };
});

vi.mock('@/workbench/live', () => ({
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

const PROJECT = 'p1';
const PATH = '/home/me/project';

function aWaitingMessage(text: string, id = 'held-1'): HeldMessage {
  return { id, sessionId: 's1', text, images: [], parts: null, heldAt: '2026-09-19T00:00:00.000Z' };
}

/** The working chat on screen, with whatever was typed into its box. */
async function aWorkingChat(typed = ''): Promise<HTMLTextAreaElement> {
  render(<ChatTab projectId={PROJECT} projectPath={PATH} openSessionId="s1" />);
  await act(async () => {});
  const box = screen.getByTestId('composer') as HTMLTextAreaElement;
  if (typed) fireEvent.change(box, { target: { value: typed } });
  return box;
}

/** Every command of one kind the screen asked the server for. */
function asked(type: string): Record<string, unknown>[] {
  return answering.mock.calls
    .map(([command]) => command as Record<string, unknown>)
    .filter((command) => command.type === type);
}

beforeEach(() => {
  // An unsent line is kept for the reader between visits, which would carry
  // one case's typing into the next one's empty box.
  localStorage.clear();
  held.current = [];
  chatState.current = 'thinking';
  answering.mockReset();
  answering.mockImplementation(async () => ({ model: null, effort: null }));
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

describe('a chat that is working, with something written in the box', () => {
  it('offers all three: stop it, hold it, or send it now', async () => {
    await aWorkingChat('one more thing');

    expect(screen.getByTestId('stop-button')).toBeInTheDocument();
    expect(screen.getByTestId('queue-button')).toBeInTheDocument();
    expect(screen.getByTestId('send-now-button')).toBeInTheDocument();
  });

  it('and nothing to send or hold until something is written', async () => {
    await aWorkingChat();

    expect(screen.getByTestId('stop-button')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-button')).toBeNull();
    expect(screen.queryByTestId('send-now-button')).toBeNull();
  });

  it('holds what was written when the hold button is pressed, and empties the box', async () => {
    const box = await aWorkingChat('one more thing');

    fireEvent.click(screen.getByTestId('queue-button'));
    await act(async () => {});

    expect(asked('prompt.hold')).toEqual([
      { type: 'prompt.hold', sessionId: 's1', text: 'one more thing', images: [] },
    ]);
    expect(asked('prompt.send')).toEqual([]);
    expect(box.value).toBe('');
  });

  it('pushes it into the running turn when the other button is pressed', async () => {
    await aWorkingChat('say this now');

    fireEvent.click(screen.getByTestId('send-now-button'));
    await act(async () => {});

    expect(asked('prompt.send')).toHaveLength(1);
    expect(asked('prompt.hold')).toEqual([]);
  });

  it('holds on Enter and pushes on Cmd or Ctrl with Enter', async () => {
    const box = await aWorkingChat('a thought');

    fireEvent.keyDown(box, { key: 'Enter' });
    await act(async () => {});
    expect(asked('prompt.hold')).toHaveLength(1);
    expect(asked('prompt.send')).toEqual([]);

    fireEvent.change(box, { target: { value: 'and this one now' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    await act(async () => {});
    expect(asked('prompt.send')).toHaveLength(1);
    expect(asked('prompt.hold')).toHaveLength(1);
  });
});

describe('a message that is waiting', () => {
  it('is drawn, in the order it will go, with what can be done to it', async () => {
    held.current = [aWaitingMessage('first thing'), aWaitingMessage('second thing', 'held-2')];

    await aWorkingChat();

    const waiting = screen.getAllByTestId('held-message');
    expect(waiting).toHaveLength(2);
    expect(waiting[0]).toHaveTextContent('first thing');
    expect(waiting[0]).toHaveTextContent('Next, when this turn ends');
    expect(waiting[1]).toHaveTextContent('Waiting, 2 in line');
    expect(screen.getAllByTestId('held-message-push')).toHaveLength(2);
  });

  it('goes through now when pushed', async () => {
    held.current = [aWaitingMessage('first thing')];
    await aWorkingChat();

    fireEvent.click(screen.getAllByTestId('held-message-push')[0]!);
    await act(async () => {});

    expect(asked('prompt.push')).toEqual([
      { type: 'prompt.push', sessionId: 's1', heldId: 'held-1', takeover: false },
    ]);
  });

  it('is dropped when dropped', async () => {
    held.current = [aWaitingMessage('first thing')];
    await aWorkingChat();

    fireEvent.click(screen.getAllByTestId('held-message-drop')[0]!);
    await act(async () => {});

    expect(asked('prompt.drop')).toEqual([{ type: 'prompt.drop', sessionId: 's1', heldId: 'held-1' }]);
  });

  it('comes back into the writing box to be edited, and leaves the queue doing it', async () => {
    held.current = [aWaitingMessage('first thing')];
    const box = await aWorkingChat();

    fireEvent.click(screen.getAllByTestId('held-message-edit')[0]!);
    await act(async () => {});

    expect(asked('prompt.drop')).toEqual([{ type: 'prompt.drop', sessionId: 's1', heldId: 'held-1' }]);
    expect(box.value).toBe('first thing');
  });
});

describe('the queue a chat is opened on', () => {
  it('comes back from the server, and follows what happens to it after', async () => {
    const { asView, reduce } = await import('@/workbench/fold');
    // Opened on a chat that was already holding something: the queue is in the
    // snapshot, not folded out of the history, so a reload finds it.
    const opened = asView({ held: [aWaitingMessage('written before the reload')] });
    expect(opened.held).toHaveLength(1);

    const withAnother = reduce(opened, {
      type: 'prompt.held',
      seq: 2,
      sessionId: 's1',
      at: '2026-09-19T00:00:01.000Z',
      held: aWaitingMessage('written just now', 'held-2'),
    });
    expect(withAnother.held.map((message) => message.id)).toEqual(['held-1', 'held-2']);

    // The same message arriving twice — a live event behind a snapshot that
    // already had it — is one waiting message, not two.
    const again = reduce(withAnother, {
      type: 'prompt.held',
      seq: 3,
      sessionId: 's1',
      at: '2026-09-19T00:00:02.000Z',
      held: aWaitingMessage('written just now', 'held-2'),
    });
    expect(again.held).toHaveLength(2);

    const sent = reduce(again, {
      type: 'prompt.released',
      seq: 4,
      sessionId: 's1',
      at: '2026-09-19T00:00:03.000Z',
      heldId: 'held-1',
      reason: 'sent',
    });
    expect(sent.held.map((message) => message.id)).toEqual(['held-2']);
  });
});

/**
 * The reply is over and only a task the agent sent away is still going
 * (bw-ekpt.1).
 *
 * The chat is not mid-turn here, so there is nothing for a message to be
 * thrown into and nothing for it to wait behind: the box takes it as it would
 * at rest. Stop stays, because the task that is still going can be stopped.
 * Before this, the one word "busy" covered both this state and a reply being
 * written, so typing here queued the message behind work nobody was waiting on.
 */
describe('a chat whose reply is done, with a task of its own still running', () => {
  it('offers Send, not Queue and Send now, and still offers Stop', async () => {
    chatState.current = 'waiting_for_agents';

    await aWorkingChat('one more thing');

    expect(screen.getByTestId('send-button')).toBeInTheDocument();
    expect(screen.getByTestId('stop-button')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-button')).toBeNull();
    expect(screen.queryByTestId('send-now-button')).toBeNull();
  });

  it('sends on Enter instead of holding', async () => {
    chatState.current = 'waiting_for_agents';

    const box = await aWorkingChat('one more thing');
    fireEvent.keyDown(box, { key: 'Enter' });
    await act(async () => {});

    expect(asked('prompt.send')).toHaveLength(1);
    expect(asked('prompt.hold')).toEqual([]);
  });

  it('tells a message already waiting that it is going now, not when the turn ends', async () => {
    chatState.current = 'waiting_for_agents';
    held.current = [aWaitingMessage('first thing')];

    await aWorkingChat();

    expect(screen.getAllByTestId('held-message')[0]).toHaveTextContent('Sending now');
  });
});
