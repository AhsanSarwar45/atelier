/**
 * Closing a chat from the list it is in (bw-cnxh).
 *
 * The manager's ruling, 2026-08-25: the control goes on the row, not on the
 * open chat, because closing chats is tidying and tidying is done over a list.
 * So every case here is about the ROW — which rows offer it, where on the row it
 * is drawn, what a click on it asks for, and what the row says afterwards.
 *
 * The cases worth having are the ones about rows that must NOT offer it, and
 * about the width it must not take. A chat somebody is typing at in a terminal
 * has no agent of ours to tear down, and a control that holds its own width on
 * every row cuts every name in the list short to reserve room for a button
 * nobody can see (the manager, 2026-08-26).
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
    // Awake by default: an agent of ours is attached, which is the only kind of
    // row there is anything here to close.
    state: 'idle',
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
const closeOn = (title: string) => within(rowNamed(title)).queryByTestId('row-close');

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
  it('is on a chat with an agent of ours attached', async () => {
    await draw();

    expect(closeOn('A chat of ours'), 'no way to close a chat from its own row').not.toBeNull();
  });

  it('and an attached chat between turns says Idle', async () => {
    await draw();

    const pill = within(rowNamed('A chat of ours')).getByTestId('row-pill');
    expect(pill).toHaveTextContent('Idle');
  });

  it('says what it does, for a reader who cannot see the icon', async () => {
    await draw();

    expect(closeOn('A chat of ours')!.getAttribute('aria-label')).toBe('Close A chat of ours');
  });

  it('is not on a chat somebody else is working in', async () => {
    // No agent of ours is attached to it, so there is nothing here to tear
    // down. Closing it would call it asleep while a terminal went on typing
    // into it.
    list = [
      row({ sessionId: 'theirs', title: 'Worked in a terminal', externalId: 'ext-1', runningElsewhere: true }),
    ];
    await draw();

    expect(closeOn('Worked in a terminal')).toBeNull();
  });

  it('is not on a chat that is already asleep', async () => {
    // Nothing to take away, so a control there would be a button that did
    // nothing on the bulk of the list.
    list = [row({ sessionId: 'done', title: 'Nobody is in this one', state: 'dormant' })];
    await draw();

    expect(closeOn('Nobody is in this one')).toBeNull();
  });

  it('is not on a chat begun elsewhere that this app has never opened', async () => {
    // No id of ours, so no row of ours, so nothing to close.
    list = [row({ sessionId: null, externalId: 'ext-2', title: 'Never opened here', origin: 'terminal' })];
    await draw();

    expect(closeOn('Never opened here')).toBeNull();
  });
});

describe('where it is drawn', () => {
  it('over the clock, so it holds no width of its own', async () => {
    // The fault the manager sent it back for: a control standing in the line as
    // its own item held a width and a gap on all forty rows, so every name in
    // the list was cut short to reserve room for a button nobody could see.
    // Drawn over the clock instead, the box is the clock's width whether the
    // pointer is on the row or not. jsdom has no layout to measure, so what is
    // asserted is the arrangement that makes the width constant: the control is
    // taken out of the flow, inside the same box the clock sits in.
    await draw();

    const control = closeOn('A chat of ours')!;
    expect(control.className).toContain('absolute');
    const box = control.parentElement!;
    expect(box.className).toContain('relative');
    expect(box.textContent, 'the control is not sharing the clock’s box').toMatch(/\d/);
  });

  it('and the clock is only hidden while the pointer is on the row', async () => {
    // Hidden by hover, not by removal: the clock keeps its width, which is what
    // stops the row shifting under the pointer as the control appears.
    await draw();

    const clock = closeOn('A chat of ours')!.parentElement!.firstElementChild!;
    expect(clock.textContent).toMatch(/\d/);
    expect(clock.className).toContain('group-hover/row:opacity-0');
  });

  it('and a row with nothing to close still shows its clock', async () => {
    // The plain case, which the arrangement above must not have cost: no
    // control, no fading, just the time.
    list = [row({ sessionId: 'done', title: 'Nobody is in this one', state: 'dormant' })];
    await draw();

    expect(rowNamed('Nobody is in this one').textContent).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('clicking it', () => {
  it('asks for that chat to be closed, and for no other', async () => {
    list = [
      row({ sessionId: 'ours', title: 'A chat of ours' }),
      row({ sessionId: 'other', title: 'Another chat' }),
    ];
    await draw();

    await act(async () => void fireEvent.click(closeOn('Another chat')!));

    expect(asked).toEqual([{ type: 'session.close', sessionId: 'other' }]);
  });

  it('does not open the chat it is closing', async () => {
    // The row's name is a button that opens it, and the control sits on the
    // same line. A click that did both would close the chat and throw the
    // reader into it.
    const opened: string[] = [];
    vi.resetModules();
    const { ChatSidebar } = await import('@/workbench/chat-sidebar');
    render(
      <ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={(id) => opened.push(id)} />,
    );
    await waitFor(() => expect(rows()).toHaveLength(1));

    await act(async () => void fireEvent.click(closeOn('A chat of ours')!));

    expect(opened).toEqual([]);
  });

  it('and a refusal is drawn rather than swallowed', async () => {
    refuse = 'the helper is not running';
    await draw();

    await act(async () => void fireEvent.click(closeOn('A chat of ours')!));

    await waitFor(() => expect(screen.queryByTestId('restore-error')).not.toBeNull());
    expect(screen.getByTestId('restore-error').textContent).toMatch(/not running/);
  });
});

describe('what the row says afterwards', () => {
  it('nothing — a closed chat reads exactly like every other sleeping one', async () => {
    // The manager's ruling, 2026-08-26: closing a chat is closing the terminal
    // it ran in, and this app has no way to tell such a chat from one whose
    // agent simply went. A word on the row would claim a difference that is not
    // there, and it would be the one sleeping row in the list wearing a pill.
    list = [
      row({ sessionId: 'done', title: 'Closed a moment ago', state: 'dormant' }),
      row({ sessionId: 'asleep', title: 'Nobody is in this one', state: 'dormant' }),
    ];
    await draw();

    for (const title of ['Closed a moment ago', 'Nobody is in this one']) {
      expect(
        within(rowNamed(title)).queryByTestId('row-pill'),
        `${title} wore a pill; a pill on every sleeping row is a pill on none`,
      ).toBeNull();
    }
  });

  it('but it does say it is closing while the asking is in flight', async () => {
    // Closing a chat kills a process, which is not instant. A row that said
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

    await act(async () => void fireEvent.click(closeOn('A chat of ours')!));

    const pill = within(rowNamed('A chat of ours')).queryByTestId('row-pill');
    expect(pill, 'the row said nothing while its chat was being closed').not.toBeNull();
    expect(pill!.getAttribute('data-pill')).toBe('ending');

    await act(async () => {
      land();
      await held;
    });
  });
});
