/**
 * The list, talking to a helper older than itself.
 *
 * The complaint, on the running copy 2026-08-21: a chat a terminal was working
 * in showed nothing at all — no moving mark, no badge — under a heading that
 * said it was open elsewhere. The helper feeding the screen had been up since
 * 10:51 and the page had been served at 13:48, and in between, the word that
 * says who is holding a chat changed what it carries: a list of bare ids became
 * a list of chats and what each is doing. The page read the new cargo off the
 * old word, threw inside its own message handler, and never said another thing
 * about a held chat for as long as the tab stayed open. Everything else went on
 * arriving, so nothing on screen looked wrong.
 *
 * Two rules come out of that and both are measured here. A frame the page
 * cannot read is a fact about the helper, not a crash: it is said on the screen
 * and the rest of the stream keeps working. And it is not a life sentence: the
 * moment a frame arrives that does read, the line goes and the marks come back,
 * so a restarted helper heals the open tab without a reload.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestoreRow } from '@/workbench/protocol';

import { tagged } from './tagged';

const PROJECT = 'p1';
const PATH = '/home/me/project';
/** The tool's own id for the conversation the terminal is in. */
const HELD = 'held-in-a-terminal';

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
   * The helper as it was BEFORE this job: the same word, carrying a list of
   * bare conversation ids. This is the exact frame the manager's own helper was
   * still sending, read off the wire at 14:00 that day.
   */
  saysTheOldWay(ids: string[]): void {
    this.onmessage?.(tagged('workbench', JSON.stringify({ kind: 'running', conversations: ids })));
  }

  /** The helper as it is now: each chat, with what it is doing. */
  saysWhoIsWorking(holds: { id: string; doing: string }[]): void {
    this.onmessage?.(
      tagged(
        'workbench',
        JSON.stringify({
          kind: 'running',
          holds: holds.map((h) => ({ id: h.id, holder: 'terminal', doing: h.doing, since: null })),
        }),
      ),
    );
  }

  /** Something no version of this app has ever sent. */
  saysSomethingUnreadable(): void {
    this.onmessage?.(tagged('workbench', 'not json at all'));
  }
}

/** jsdom has no layout; the foot of the list is only reached when a case says so. */
class FakeFoot {
  constructor(private readonly tell: (entries: { isIntersecting: boolean }[]) => void) {}
  observe(): void {}
  disconnect(): void {}
}

/** What the helper answers the list with, as the case last set it. */
let list: RestoreRow[] = [];

const rows = () => screen.queryAllByTestId('restore-row');
const line = () => screen.queryByTestId('helper-stale');
const mark = () => document.querySelector('[data-testid="row-pill"]');

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

/** A fresh live store per case: what it knows of the helper is module-wide. */
async function freshSidebar() {
  vi.resetModules();
  return (await import('@/workbench/chat-sidebar')).ChatSidebar;
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

describe('when the helper behind the list is older than the page', () => {
  it('draws every row still, and says on screen that the helper is out of date', async () => {
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);

    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(line(), 'a fresh page accused its helper of being old before it had spoken').toBeNull();

    // The word arrives carrying what the old helper carries. Before this, the
    // page threw here and went quiet about held chats for good.
    act(() => opened[0].saysTheOldWay([HELD]));

    await waitFor(() =>
      expect(line(), 'the page lost every mark and said nothing about why').not.toBeNull(),
    );
    expect(line()!.textContent, 'the line does not say what to do about it').toMatch(/out of date/i);
    expect(rows(), 'a frame the page could not read took the list down with it').toHaveLength(2);
  });

  it('goes quiet about who is working rather than guessing', async () => {
    const { useRunningElsewhere } = await (async () => {
      vi.resetModules();
      return import('@/workbench/live');
    })();
    const { renderHook } = await import('@testing-library/react');
    const { result } = renderHook(() => useRunningElsewhere());

    act(() => opened[0].saysTheOldWay([HELD]));

    // Not an empty set. Nothing is known, and the live store spells that `null`
    // everywhere — the same answer a dropped stream gives, because the writing
    // box reads it to decide whether to lock (bw-dmxj.12).
    //
    // Here to stop the cheap cure rather than the fault above: reading the old
    // frame as "an empty list of held chats" would clear the line, draw every
    // held chat as free, and open the writing box on a conversation somebody is
    // typing in — which is worse than the silence it replaced.
    expect(result.current, 'the page claimed to know that nobody was working').toBeNull();
  });

  it('heals the open tab the moment the helper is restarted', async () => {
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);

    await waitFor(() => expect(rows()).toHaveLength(2));
    act(() => opened[0].saysTheOldWay([HELD]));
    await waitFor(() => expect(line()).not.toBeNull());

    // The helper is restarted and speaks this page's words. Nothing is
    // reloaded: the same tab is still open on the same list.
    act(() => opened[0].saysWhoIsWorking([{ id: HELD, doing: 'working' }]));

    await waitFor(() => expect(line(), 'the page went on accusing a helper that had been fixed').toBeNull());
    await waitFor(() => expect(mark(), 'the marks never came back').not.toBeNull());
    expect(mark()!.getAttribute('data-working'), 'the chat being worked in was not drawn as working').toBe('yes');
  });

  it('survives a frame no version of this app has ever sent', async () => {
    const ChatSidebar = await freshSidebar();
    render(<ChatSidebar projectId={PROJECT} projectPath={PATH} openSessionId={null} onOpen={() => {}} />);

    await waitFor(() => expect(rows()).toHaveLength(2));
    act(() => opened[0].saysSomethingUnreadable());
    await waitFor(() => expect(line()).not.toBeNull());

    // The stream is still being listened to, which is the whole of the point:
    // one bad frame used to end the conversation.
    act(() => opened[0].saysWhoIsWorking([{ id: HELD, doing: 'working' }]));
    await waitFor(() => expect(line()).toBeNull());
    await waitFor(() => expect(mark()).not.toBeNull());
  });
});
