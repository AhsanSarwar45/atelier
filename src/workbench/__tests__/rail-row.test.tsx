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
 * So: two lines, and the folder carried rather than drawn.
 *
 * The clause went with them, and came back. Dropping it was right only while
 * the one cut available was the browser's, at the end; the manager's own
 * picture of 2026-08-25 shows what that width does to a long one — "ing for
 * NothingShowing|KindFilter in workbench/chat-", with both ends gone. It is cut
 * in the middle now, so 288px carries what it is on and what it is on is worth
 * reading (bw-gnzl).
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatStateChip } from '@/workbench/chat-state-chip';
import type { RestoreRow } from '@/workbench/protocol';

import { tagged } from './tagged';

const PROJECT = 'p1';
const PATH = '/home/me/project';
/** The tool's own id for the conversation a terminal is working in. */
const HELD = 'held-in-a-terminal';

let opened: FakeStream[] = [];

/** The browser's WebSocket, as much of it as the live store touches. */
class FakeStream {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    opened.push(this);
  }

  close(): void {}


  /** The helper naming who is in a chat, and what that chat is doing. */
  saysWhoIsWorking(holds: { id: string; doing: string; detail?: string; since?: number }[]): void {
    this.onmessage?.(tagged('workbench', JSON.stringify({
        kind: 'running',
        holds: holds.map((h) => ({
          id: h.id,
          holder: 'terminal',
          doing: h.doing,
          since: h.since ?? null,
          detail: h.detail ?? null,
        })),
      })));
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

async function railWithAWorkingChat(on: { detail?: string; since?: number } = {}) {
  const ChatSidebar = await freshSidebar();
  render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);
  await waitFor(() => expect(rows()).toHaveLength(2));
  act(() =>
    opened[0].saysWhoIsWorking([
      { id: HELD, doing: 'summarising', detail: on.detail ?? 'auto', since: on.since },
    ]),
  );
  await waitFor(() => expect(screen.queryByTestId('row-pill')).not.toBeNull());
}

beforeEach(() => {
  opened = [];
  list = [
    row({ sessionId: 'in-a-terminal', externalId: HELD, origin: 'terminal', title: 'Worked in a terminal' }),
    row({ sessionId: 'asleep', title: 'Nobody is in this one' }),
  ];
  vi.stubGlobal('WebSocket', FakeStream);
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

  it('keeps the coding-agent brand visible on every session row', async () => {
    list = [row({ sessionId: 'codex-chat', brand: 'codex', title: 'Codex work' })];
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);
    await waitFor(() => expect(rows()).toHaveLength(1));

    expect(rows()[0].getAttribute('data-brand')).toBe('codex');
    expect(rows()[0].querySelector('[aria-label="Codex"]')).not.toBeNull();
  });

  it('says the word, what it is on and the clock, and cuts only the middle', async () => {
    // The manager's own line, off the running copy: a search worth reading at
    // both ends, in a rail 288px wide (bw-gnzl).
    await railWithAWorkingChat({
      detail: 'for NothingShowing|KindFilter in workbench/chat-sidebar.tsx',
      since: Date.now() - 74_000,
    });

    const pill = screen.getByTestId('row-pill');
    expect(pill.getAttribute('data-word')).toBe('Summarising');

    const clause = pill.querySelector('[data-testid="chat-state-detail"]');
    expect(clause, 'the rail stopped saying what the chat is on at all').not.toBeNull();

    // Two pieces, and the pinned one carries the end of the path. What the
    // browser cuts is between them.
    const pieces = Array.from(clause!.children).map((c) => c.textContent);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toMatch(/^· for NothingShowing/);
    expect(pieces[1], 'the end of the path went over the edge again').toBe('/chat-sidebar.tsx');

    // And the three that never give way are all still on the line.
    expect(pill.querySelector('[data-testid="chat-state-mark"]'), 'the mark was pushed off the front').not.toBeNull();
    expect(pill.textContent).toMatch(/Summarising/);
    expect(
      pill.querySelector('[data-testid="chat-state-count"]'),
      'how long it has been at it was pushed off the end',
    ).not.toBeNull();
  });

  it('draws the same clause on the chat own bar, from the same chip', () => {
    // Same size of chip, same reading — only the caller differs. Neither screen
    // has a switch for this any more: the cut is in the chip, so a rail and a
    // bar cannot drift apart over it.
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
    // Short enough to stand whole: nothing is split that did not need splitting.
    expect(screen.getByTestId('session-state-chip').textContent).toContain('· auto');
  });
});
