/**
 * When a notification appeared, on the row that announces it (bw-zvgc).
 *
 * The tray said what a chat wanted and never when it started wanting it, so a
 * chat that stopped a minute ago and one that stopped last night read exactly
 * alike — and nothing anywhere was writing that time down, so there was nothing
 * the page could have drawn even if it had wanted to.
 *
 * The moment is the server's now, recorded when the chat reached the state
 * being announced. That is the whole point of these cases: the row must draw
 * what it was given and must not work the time out for itself, or a reload
 * would move it and two tabs would disagree about the same chat.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { whenItAppeared } from '@/workbench/when';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

/** Half past eight this morning, whenever this test happens to run. */
function thisMorning(): string {
  const at = new Date();
  at.setHours(8, 30, 0, 0);
  return at.toISOString();
}

/** The same clock, a fortnight back. */
function aFortnightAgo(): string {
  const at = new Date(thisMorning());
  at.setDate(at.getDate() - 14);
  return at.toISOString();
}

let rows: Record<string, unknown>[] = [];
vi.mock('@/lib/api', () => ({
  request: async (path: string) =>
    ({ ok: true, status: path.endsWith('/read') ? 204 : 200, json: async () => rows }) as unknown as Response,
}));
vi.mock('@/workbench/live', () => ({ useLiveSessions: () => [] }));

function aRow(over: Record<string, unknown> = {}) {
  return {
    id: 'chat-1',
    name: 'A chat',
    projectId: 'project-1',
    projectName: 'Keystone',
    state: 'errored',
    says: 'it stopped with an error',
    href: '/project?id=project-1&tab=chat&chat=chat-1',
    needsAction: true,
    at: thisMorning(),
    ...over,
  };
}

async function openTheTray() {
  const { WorkbenchStatus } = await import('@/workbench/globals');
  await act(async () => void render(<WorkbenchStatus />));
  await waitFor(() => expect(screen.queryByTestId('tray-badge')).not.toBeNull());
  await act(async () => void fireEvent.click(screen.getByTestId('tray-badge')));
  await waitFor(() => expect(screen.queryByTestId('tray-panel')).not.toBeNull());
}

beforeEach(() => {
  push.mockClear();
  rows = [aRow()];
});

afterEach(() => vi.clearAllMocks());

describe('the words on a moment', () => {
  it('says the clock alone for something that appeared today', () => {
    const at = thisMorning();
    expect(whenItAppeared(at)).toBe(new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }));
  });

  it('says the day in front of it for anything older', () => {
    const now = new Date('2026-09-22T12:00:00.000Z');
    expect(whenItAppeared('2026-09-21T09:15:00.000Z', now)).toMatch(/^Yesterday /);
    expect(whenItAppeared('2026-09-08T09:15:00.000Z', now)).not.toMatch(/^(Today|Yesterday)/);
  });
});

describe('a tray row', () => {
  it('says when it appeared', async () => {
    await openTheTray();

    expect(screen.getByTestId('tray-when')).toHaveTextContent(whenItAppeared(thisMorning()));
  });

  it('draws the time the server gave it, whatever kind of row it is', async () => {
    rows = [
      aRow(),
      aRow({ id: 'chat-2', state: 'idle', says: 'Ready to read', needsAction: false, at: aFortnightAgo() }),
    ];
    await openTheTray();

    const said = screen.getAllByTestId('tray-when').map((it) => it.textContent);
    expect(said).toEqual([whenItAppeared(thisMorning()), whenItAppeared(aFortnightAgo())]);
    // A row under "other updates" is timed too. Both kinds sit in the same
    // tray, and a reader comparing two of them needs the same fact on each.
    expect(said[1]).not.toBe(said[0]);
  });

  it('keeps the server time across a fresh page rather than re-timing itself', async () => {
    // Something that appeared a fortnight ago. A row that timed itself from
    // when it was drawn would call this one "now" every time a tab opened.
    rows = [aRow({ at: aFortnightAgo() })];
    await openTheTray();
    expect(screen.getByTestId('tray-when')).toHaveTextContent(whenItAppeared(aFortnightAgo()));

    // A fresh page: the component goes away and comes back, asking the server
    // again, exactly as a reload or a second tab would.
    cleanup();
    await openTheTray();

    expect(screen.getByTestId('tray-when')).toHaveTextContent(whenItAppeared(aFortnightAgo()));
  });
});
