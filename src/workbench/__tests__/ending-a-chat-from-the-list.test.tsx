/**
 * Ending a chat from the list it is in (bw-cnxh).
 *
 * The manager's ruling, 2026-08-25: the control goes on the row, not on the
 * open chat, because ending chats is tidying and tidying is done over a list.
 * So every case here is about the ROW — which rows offer it, what a click on it
 * asks for, and what the row says afterwards.
 *
 * Two of them guard rows that must NOT offer it, and they are the ones worth
 * having: a chat somebody is typing at in a terminal has no agent of ours to
 * tear down, and marking it ended from here would say it had stopped while it
 * went on working.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestoreRow } from '@/workbench/protocol';

const PROJECT = 'p1';
const PATH = '/home/me/project';

/** The browser's WebSocket, as much of it as the live store touches. */
class FakeStream {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  close(): void {}
}

/** jsdom has no layout; the foot of the list is never reached here. */
class FakeFoot {
  observe(): void {}
  disconnect(): void {}
}

let list: RestoreRow[] = [];
/** Every command the list posted, in order — what a click actually asked for. */
let asked: Record<string, unknown>[] = [];
/** What the next command is answered with, so a refusal can be drawn. */
let refuse: string | null = null;

function row(over: Partial<RestoreRow> = {}): RestoreRow {
  return {
    sessionId: 's1',
    externalId: null,
    brand: 'claude',
    title: 'A chat',
    lastActiveAt: '2026-08-16T10:00:00.000Z',
    state: 'dormant',
    origin: 'app',
    projectId: PROJECT,
    cwdHint: PATH,
    folder: 'project',
    branch: 'main',
    beads: [],
    ...over,
  };
}

const rows = () => screen.queryAllByTestId('restore-row');
const rowNamed = (title: string) =>
  rows().find((r) => within(r).queryByText(title) !== null)!;
const endOn = (title: string) => within(rowNamed(title)).queryByTestId('row-end');

async function draw() {
  vi.resetModules();
  const { ChatSidebar } = await import('@/workbench/chat-sidebar');
  render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);
  await waitFor(() => expect(rows()).toHaveLength(list.length));
}

beforeEach(() => {
  asked = [];
  refuse = null;
  list = [row({ sessionId: 'ours', title: 'A chat of ours' })];
  vi.stubGlobal('WebSocket', FakeStream);
  vi.stubGlobal('IntersectionObserver', FakeFoot);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        asked.push(JSON.parse(init.body ?? '{}') as Record<string, unknown>);
        if (refuse !== null) return { ok: false, status: 500, text: async () => refuse } as unknown as Response;
        return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
      }
      return { ok: true, json: async () => list } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the control on a row', () => {
  it('is on every chat this app has a row for', async () => {
    await draw();

    expect(endOn('A chat of ours'), 'no way to end a chat from its own row').not.toBeNull();
  });

  it('says what it does, for a reader who cannot see the icon', async () => {
    await draw();

    expect(endOn('A chat of ours')!.getAttribute('aria-label')).toBe('End A chat of ours');
  });

  it('is not on a chat somebody else is working in', async () => {
    // No agent of ours is attached to it, so there is nothing here to tear
    // down. Marking it ended would say it had stopped while a terminal went on
    // typing into it.
    list = [row({ sessionId: 'theirs', title: 'Worked in a terminal', externalId: 'ext-1', runningElsewhere: true })];
    await draw();

    expect(endOn('Worked in a terminal')).toBeNull();
  });

  it('is not on a chat that has already ended', async () => {
    list = [row({ sessionId: 'done', title: 'Ended last week', state: 'ended' })];
    await draw();

    expect(endOn('Ended last week')).toBeNull();
  });

  it('is not on a chat begun elsewhere that this app has never opened', async () => {
    // No id of ours, so no row of ours, so nothing to mark.
    list = [row({ sessionId: null, externalId: 'ext-2', title: 'Never opened here', origin: 'terminal' })];
    await draw();

    expect(endOn('Never opened here')).toBeNull();
  });
});

describe('clicking it', () => {
  it('asks for that chat to be closed, and for no other', async () => {
    list = [
      row({ sessionId: 'ours', title: 'A chat of ours' }),
      row({ sessionId: 'other', title: 'Another chat' }),
    ];
    await draw();

    await act(async () => void fireEvent.click(endOn('Another chat')!));

    expect(asked).toEqual([{ type: 'session.close', sessionId: 'other' }]);
  });

  it('does not open the chat it is ending', async () => {
    // The row's name is a button that opens it, and the control sits on the
    // same line. A click that did both would end the chat and throw the reader
    // into it.
    const opened: string[] = [];
    vi.resetModules();
    const { ChatSidebar } = await import('@/workbench/chat-sidebar');
    render(
      <ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={(id) => opened.push(id)} />,
    );
    await waitFor(() => expect(rows()).toHaveLength(1));

    await act(async () => void fireEvent.click(endOn('A chat of ours')!));

    expect(opened).toEqual([]);
  });

  it('and a refusal is drawn rather than swallowed', async () => {
    refuse = 'the helper is not running';
    await draw();

    await act(async () => void fireEvent.click(endOn('A chat of ours')!));

    await waitFor(() => expect(screen.queryByTestId('restore-error')).not.toBeNull());
    expect(screen.getByTestId('restore-error').textContent).toMatch(/not running/);
  });
});

describe('what the row says afterwards', () => {
  it('reads Ended, where a sleeping chat says nothing at all', async () => {
    // The whole point of ending one is seeing afterwards that it took. Most of
    // the list is asleep and says nothing — this is the one asleep row that
    // does, because the owner did it on purpose.
    list = [
      row({ sessionId: 'done', title: 'Ended last week', state: 'ended' }),
      row({ sessionId: 'asleep', title: 'Nobody is in this one' }),
    ];
    await draw();

    const pill = within(rowNamed('Ended last week')).queryByTestId('row-pill');
    expect(pill, 'an ended chat looked exactly like a sleeping one').not.toBeNull();
    expect(pill!.getAttribute('data-word')).toBe('Ended');

    expect(
      within(rowNamed('Nobody is in this one')).queryByTestId('row-pill'),
      'a pill on every sleeping row is a pill on none',
    ).toBeNull();
  });

  it('and says it is ending while the asking is in flight', async () => {
    // Ending a chat kills a process, which is not instant. A row that said
    // nothing in between would read as a click that did nothing, and invite a
    // second one — the same reason opening a chat says `opening`.
    let land = () => {};
    const held = new Promise<void>((go) => {
      land = go;
    });
    const answer = globalThis.fetch as unknown as (u: string, i?: { method?: string; body?: string }) => Promise<Response>;
    vi.stubGlobal('fetch', async (u: string, i?: { method?: string; body?: string }) => {
      if (i?.method === 'POST') await held;
      return answer(u, i);
    });
    await draw();

    await act(async () => void fireEvent.click(endOn('A chat of ours')!));

    const pill = within(rowNamed('A chat of ours')).queryByTestId('row-pill');
    expect(pill, 'the row said nothing while its chat was being ended').not.toBeNull();
    expect(pill!.getAttribute('data-pill')).toBe('ending');

    await act(async () => {
      land();
      await held;
    });
  });
});
