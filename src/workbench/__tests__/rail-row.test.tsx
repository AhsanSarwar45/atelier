/**
 * The restore rail's row, at the width it is actually drawn at.
 *
 * The manager, reading the list on the running copy 2026-08-23: three lines per
 * chat, the middle one a chip naming the folder — which the chat's own bar names
 * again, with its branch, the moment the row is clicked. And the chip on the
 * bottom line arrived cut short, "Summarising · au…", because 288px minus a
 * badge saying somebody else is in there does not hold a word, a clause and a
 * clock.
 *
 * So: two lines, the folder carried rather than drawn, and no detail clause in
 * the rail. The clause is not deleted — it is kept where there is room for it,
 * which is the chat's own bar, and the last case here holds that half in place
 * so the cure does not quietly become "nobody says which one it is at all".
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatStateChip } from '@/workbench/chat-state-chip';
import type { RestoreRow } from '@/workbench/protocol';

const PROJECT = 'p1';
const PATH = '/home/me/project';
/** The tool's own id for the conversation a terminal is working in. */
const HELD = 'held-in-a-terminal';

let opened: FakeStream[] = [];

/** The browser's EventSource, as much of it as the live store touches. */
class FakeStream {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    opened.push(this);
  }

  close(): void {}

  /** The helper naming who is in a chat, and what that chat is doing. */
  saysWhoIsWorking(holds: { id: string; doing: string; detail?: string }[]): void {
    this.onmessage?.({
      data: JSON.stringify({
        kind: 'running',
        holds: holds.map((h) => ({
          id: h.id,
          holder: 'terminal',
          doing: h.doing,
          since: null,
          detail: h.detail ?? null,
        })),
      }),
    });
  }
}

/** jsdom has no layout; the foot of the list is never reached here. */
class FakeFoot {
  observe(): void {}
  disconnect(): void {}
}

let list: RestoreRow[] = [];

const rows = () => screen.queryAllByTestId('restore-row');
const held = () => rows().find((r) => r.getAttribute('data-external-id') === HELD)!;

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

async function freshSidebar() {
  vi.resetModules();
  return (await import('@/workbench/chat-sidebar')).ChatSidebar;
}

async function railWithAWorkingChat() {
  const ChatSidebar = await freshSidebar();
  render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);
  await waitFor(() => expect(rows()).toHaveLength(2));
  act(() => opened[0].saysWhoIsWorking([{ id: HELD, doing: 'summarising', detail: 'auto' }]));
  await waitFor(() => expect(screen.queryByTestId('row-pill')).not.toBeNull());
}

beforeEach(() => {
  opened = [];
  list = [
    row({ sessionId: 'in-a-terminal', externalId: HELD, origin: 'terminal', title: 'Worked in a terminal' }),
    row({ sessionId: 'asleep', title: 'Nobody is in this one' }),
  ];
  vi.stubGlobal('EventSource', FakeStream);
  vi.stubGlobal('IntersectionObserver', FakeFoot);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => list }) as unknown as Response),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a row on the restore rail', () => {
  it('draws two lines and no more, whatever the chat is doing', async () => {
    await railWithAWorkingChat();

    // The busiest row there is: worked in from a terminal, a badge saying so,
    // and a state chip. If any row grows a third line it is this one.
    expect(
      held().children.length,
      'the row the manager was reading grew back its third line',
    ).toBe(2);

    // And the quiet one, which says nothing at all below its name.
    const asleep = rows().find((r) => r !== held())!;
    expect(asleep.children.length, 'a sleeping chat drew a line with nothing on it').toBe(1);
  });

  it('carries the folder without drawing it, because the chat itself names it', async () => {
    await railWithAWorkingChat();

    expect(
      screen.queryByTestId('row-folder-chip'),
      'the rail drew the folder again under the name, which the chat bar draws with its branch',
    ).toBeNull();

    // Not lost — carried, the same way the cards this chat worked on are. Which
    // checkout a row belongs to is still readable off the row itself.
    expect(held().getAttribute('data-folder')).toBe('project');
  });

  it('says the word and the clock, and leaves the clause to the chat bar', async () => {
    await railWithAWorkingChat();

    const pill = screen.getByTestId('row-pill');
    expect(pill.getAttribute('data-word')).toBe('Summarising');
    expect(
      pill.querySelector('[data-testid="chat-state-detail"]'),
      'the rail is 288px wide and drew "· auto" into it anyway',
    ).toBeNull();
    // The chip that stays is the whole chip, not a stub: the word is still there
    // to be read.
    expect(pill.textContent).toMatch(/Summarising/);
  });

  it('keeps the clause on the chat own bar, where there is room for it', () => {
    // Same size of chip, same reading — only the caller differs. The cure for a
    // narrow rail must not travel to the screen that has the width.
    render(
      <ChatStateChip
        state={{
          word: 'Summarising',
          working: true,
          waiting: false,
          doing: 'summarising',
          detail: 'auto',
          told: true,
          mark: 'summarising',
          since: null,
          turnSince: null,
          external: null,
        }}
        testId="session-state-chip"
      />,
    );

    expect(
      screen.getByTestId('session-state-chip').querySelector('[data-testid="chat-state-detail"]'),
      'which compaction it is stopped being said anywhere at all',
    ).not.toBeNull();
  });
});
