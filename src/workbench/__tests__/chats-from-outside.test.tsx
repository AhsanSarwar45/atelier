/**
 * A chat begun outside this app turns up in the list on its own.
 *
 * The complaint: adding a chat in Zed did not add it here, and it kept not
 * being there until a row was clicked — at which point every missing chat
 * appeared at once, because clicking asks for the list again as a side effect
 * (bw-uivp). The sidecar now watches the tools' own session folders and says
 * one bare word when they move; this is the list answering that word with the
 * same fetch it does when the tab opens, and nothing being clicked.
 *
 * The word carries no rows on purpose, so what is proved here is the asking:
 * that it happens on the word, that opening the tab does not do it twice, and
 * that replacing the list does not cost the reader his place in it or lose the
 * chat he has open.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestoreRow } from '@/workbench/protocol';

import { tagged } from './tagged';

const PROJECT = 'p1';
const PATH = '/home/me/project';

/** Every stream opened during a case, newest last. */
let opened: FakeStream[] = [];

/** The browser's WebSocket, as much of it as the live store touches. */
class FakeStream {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    opened.push(this);
  }

  close(): void {}


  /**
   * The sidecar has heard the tools' own session folders move, in the working
   * directories named — or, with none named, somewhere it could not place.
   */
  saysOutside(folders?: string[]): void {
    this.onmessage?.(tagged('workbench', JSON.stringify({ kind: 'outside', folders })));
  }

  /** The connection dies, the way a rebuild or a restart kills it. */
  dies(): void {
    this.onerror?.();
  }

  /** And the sidecar answers again, starting as it always does. */
  saysSnapshot(): void {
    this.onmessage?.(tagged('workbench', JSON.stringify({ kind: 'snapshot', sessions: [] })));
  }
}

/** Every watcher of the foot of the list, newest last. */
let feet: FakeFoot[] = [];

/**
 * jsdom has no layout, so it has no way of knowing what is on screen. This one
 * reaches the foot of the list only when the case says the reader scrolled
 * there — a watcher that fired on its own could not tell a list that kept the
 * reader's place from one that threw it away and grew back.
 */
class FakeFoot {
  constructor(private readonly tell: (entries: { isIntersecting: boolean }[]) => void) {
    feet.push(this);
  }

  observe(): void {}
  disconnect(): void {}

  /** The reader scrolls to the bottom and asks for the older chats. */
  reached(): void {
    this.tell([{ isIntersecting: true }]);
  }
}

/** What the sidecar answers with, as the case last set it. */
let list: RestoreRow[] = [];
/** Every url asked for, so a fetch nobody wanted is visible. */
let asked: string[] = [];

const restores = () => asked.filter((u) => u.includes('/api/workbench/restore'));
const rows = () => screen.queryAllByTestId('restore-row');
const rowFor = (key: string) => document.querySelector(`[data-row-key="${key}"]`);

function row(over: Partial<RestoreRow> = {}): RestoreRow {
  return {
    sessionId: 's1',
    externalId: null,
    brand: 'claude',
    title: 'An older chat',
    lastActiveAt: '2026-08-16T10:00:00.000Z',
    state: 'dormant',
    origin: 'app',
    projectId: PROJECT,
    cwdHint: PATH,
    folder: 'project',
    branch: null,
    beads: [],
    ...over,
  };
}

/** A fresh live store per case: the count of words heard is module-wide. */
async function freshSidebar() {
  vi.resetModules();
  return (await import('@/workbench/chat-sidebar')).ChatSidebar;
}

beforeEach(() => {
  opened = [];
  feet = [];
  asked = [];
  list = [row()];
  vi.stubGlobal('WebSocket', FakeStream);
  vi.stubGlobal('IntersectionObserver', FakeFoot);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input));
      const answer = list;
      return { ok: true, json: async () => answer } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a chat begun in another tool', () => {
  it('reconciles an existing chat stranded on Starting when its row is opened', async () => {
    list = [row({ sessionId: 'stranded', externalId: 'outside-1', state: 'starting' })];
    const openedChat = vi.fn();
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={openedChat} />);

    await screen.findByTestId('row-name');
    screen.getByTestId('row-name').click();

    expect(openedChat).toHaveBeenCalledWith('stranded');
    await waitFor(() => expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) =>
      init?.method === 'POST' && JSON.parse(String(init.body)).type === 'session.open',
    )).toBe(true));
  });

  it('is neither external nor asleep once no other process holds it', async () => {
    list = [row({ origin: 'terminal', externalId: 'outside-1', runningElsewhere: false })];
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByTestId('chat-external')).toBeNull();
    expect(screen.queryByText('Asleep')).toBeNull();
    expect(screen.queryByTestId('row-pill')).toBeNull();
  });

  it('becomes external only while another live process holds it', async () => {
    list = [row({
      origin: 'terminal', externalId: 'outside-1', runningElsewhere: true,
      held: { id: 'outside-1', holder: 'terminal', doing: 'idle', since: null },
    })];
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByTestId('chat-external')).toBeInTheDocument();
    expect(screen.getByTestId('row-pill')).toHaveTextContent('Idle');
  });

  it('joins the list on the word alone, with nothing clicked', async () => {
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);

    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(opened.length, 'the list never listened to the app’s stream').toBe(1);

    // Zed writes a conversation into its own folder. Nothing in this app knows
    // the chat exists, and nobody touches the screen.
    list = [row(), row({ sessionId: 's2', title: 'Begun in Zed', lastActiveAt: '2026-08-16T11:00:00.000Z' })];
    act(() => opened[0].saysOutside());

    await waitFor(() => expect(screen.getByText('Begun in Zed')).toBeInTheDocument());
    expect(restores(), 'the list was not asked for again on the word').toHaveLength(2);
  });

  it('does not make the tab ask twice for the list it just fetched', async () => {
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);

    await waitFor(() => expect(rows()).toHaveLength(1));
    // Watching a count that starts somewhere is not the same as being told it
    // moved: opening the tab is one fetch, and the word has not been said.
    expect(restores()).toHaveLength(1);
  });

  it('leaves the reader where he was in a long list', async () => {
    const many = Array.from({ length: 45 }, (_, i) =>
      row({ sessionId: `s${i}`, title: `Chat ${i}`, lastActiveAt: `2026-08-16T${String(23 - i % 24).padStart(2, '0')}:00:00.000Z` }),
    );
    list = many;

    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);

    // A screenful first, then the rest when he scrolls for them.
    await waitFor(() => expect(rows()).toHaveLength(40));
    act(() => feet[feet.length - 1]!.reached());
    await waitFor(() => expect(rows()).toHaveLength(45));

    list = [...many, row({ sessionId: 'zed', title: 'Begun in Zed', lastActiveAt: '2026-08-16T23:30:00.000Z' })];
    act(() => opened[0].saysOutside());

    // All 46, not the first screenful: a list replaced under the reader must
    // not throw him back to the top of it.
    await waitFor(() => expect(rows()).toHaveLength(46));
  });

  it('keeps the open chat marked as the open one', async () => {
    list = [row(), row({ sessionId: 's2', title: 'The one being read', state: 'idle' })];

    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId="s2" onOpen={() => {}} />);

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(rowFor('s2')).toHaveClass('bg-accent');

    list = [...list, row({ sessionId: 'zed', title: 'Begun in Zed' })];
    act(() => opened[0].saysOutside());

    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rowFor('s2'), 'the chat being read stopped looking open').toHaveClass('bg-accent');
    expect(rowFor('s1')).not.toHaveClass('bg-accent');
  });
});

/**
 * The word is scoped, because this machine runs agents in many projects at
 * once: measured against the running sidecar, four words arrived in one idle
 * twelve-second window from other people's work, and each one rebuilt the whole
 * list on every open tab (bw-uivp.4).
 */
describe('whose work the word is about', () => {
  it('another project’s agent typing costs this list nothing', async () => {
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);
    await waitFor(() => expect(rows()).toHaveLength(1));

    act(() => opened[0].saysOutside(['/home/me/somewhere-else']));
    act(() => opened[0].saysOutside(['/home/me/another-thing/worktrees/job']));
    // Proved by what happens next rather than by a wait: a word about this
    // project fetches once, so if the two before it had fetched there would be
    // three here.
    act(() => opened[0].saysOutside([PATH]));
    await waitFor(() => expect(restores()).toHaveLength(2));
    expect(restores(), 'somebody else’s work rebuilt this list').toHaveLength(2);
  });

  it('a chat begun in this project does', async () => {
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);
    await waitFor(() => expect(rows()).toHaveLength(1));

    act(() => opened[0].saysOutside([PATH]));
    await waitFor(() => expect(restores()).toHaveLength(2));
  });

  it('and so does one begun in a copy of it, where the jobs are built', async () => {
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);
    await waitFor(() => expect(rows()).toHaveLength(1));

    act(() => opened[0].saysOutside([`${PATH}/worktrees/some-job`]));
    await waitFor(() => expect(restores()).toHaveLength(2));
  });

  it('a word the sidecar could not place is for everyone', async () => {
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);
    await waitFor(() => expect(rows()).toHaveLength(1));

    // Fail towards the extra fetch, never towards the missing chat.
    act(() => opened[0].saysOutside([]));
    await waitFor(() => expect(restores()).toHaveLength(2));
  });
});

/**
 * The sidecar stops watching the folders the moment the last browser leaves, so
 * a chat begun while the stream was down was heard by nobody. Coming back is
 * itself the word (bw-uivp.5).
 */
describe('when the stream has been away', () => {
  it('the list is asked for again as soon as it comes back', async () => {
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);
    await waitFor(() => expect(rows()).toHaveLength(1));

    // The sidecar was rebuilt; a chat was begun in Zed while it was gone.
    act(() => opened[0].dies());
    list = [row(), row({ sessionId: 'zed', title: 'Begun while it was down' })];

    // The word arrives on the connection that comes back, not on the dead one:
    // the window stops listening to a connection it has given up on, so a frame
    // off a corpse is nobody's answer (live-wire.ts, bw-zkh4.10).
    await waitFor(() => expect(opened).toHaveLength(2), { timeout: 4_000 });
    act(() => opened[1].saysSnapshot());

    await waitFor(() => expect(screen.getByText('Begun while it was down')).toBeInTheDocument());
    expect(restores()).toHaveLength(2);
  });

  it('but an ordinary first snapshot is not a word', async () => {
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);
    await waitFor(() => expect(rows()).toHaveLength(1));

    act(() => opened[0].saysSnapshot());
    await Promise.resolve();
    expect(restores(), 'opening the tab fetched the list twice').toHaveLength(1);
  });
});
