/**
 * The chat list does not move under the reader's hand.
 *
 * The order is who spoke last, and the chats at the top are the ones agents are
 * working in right now, so on a busy machine that order changes every few
 * seconds on its own. He aims at the third row and opens the second. Measured
 * on 2026-08-20: the top six rows re-ordered inside six seconds with nothing
 * clicked (bw-khe.5).
 *
 * So a row the list has already shown keeps its place, and only what is in it
 * changes. What must NOT be lost is a chat begun somewhere else joining the
 * list on its own (bw-uivp), so a row nobody has seen still arrives, at the
 * place the fresh order gives it.
 *
 * And the place a row keeps is a place under a heading. A row whose heading has
 * changed is not where it was any more, and holding it there drew the day out
 * of order — TODAY under YESTERDAY (bw-hgd2). Those rows are let go.
 */
import { describe, expect, it } from 'vitest';

import { asSettled, groupRows, holdStill, OPEN_ELSEWHERE } from '@/workbench/chat-sidebar';
import { byWhatIsWorking, type RestoreRow } from '@/workbench/protocol';

const now = new Date(2026, 7, 19, 12, 0, 0);
const at = (day: number, hour: number, minute = 0) => new Date(2026, 7, day, hour, minute, 0).toISOString();

function row(id: string, over: Partial<RestoreRow> = {}): RestoreRow {
  return {
    sessionId: id,
    externalId: `x-${id}`,
    brand: 'claude',
    title: `chat ${id}`,
    lastActiveAt: at(19, 10),
    state: 'dormant',
    origin: 'app',
    projectId: 'p1',
    cwdHint: '/home/me/project',
    folder: 'project',
    branch: null,
    beads: [],
    ...over,
  };
}

const ids = (rows: RestoreRow[]) => rows.map((r) => r.sessionId);
/** What the list is holding him to: the rows as it last drew them. */
const drawn = (rows: RestoreRow[]) => asSettled(rows, now);
const held = (fresh: RestoreRow[], settled: RestoreRow[]) => holdStill(fresh, drawn(settled), now);

describe('holding the list still', () => {
  it('takes the fresh order the first time, having nothing to hold to', () => {
    const fresh = [row('a'), row('b'), row('c')];
    expect(ids(holdStill(fresh, [], now))).toEqual(['a', 'b', 'c']);
  });

  it('keeps the order he is looking at when the chats re-sort themselves', () => {
    // The measured case: two working chats trade places while he is clicking.
    const fresh = [row('b'), row('a'), row('c')];
    expect(ids(held(fresh, [row('a'), row('b'), row('c')]))).toEqual(['a', 'b', 'c']);
  });

  it('lets a row change everything about itself except where it is', () => {
    const fresh = [row('b', { state: 'thinking' }), row('a', { title: 'renamed', state: 'idle' })];
    const out = held(fresh, [row('a'), row('b')]);
    expect(ids(out)).toEqual(['a', 'b']);
    expect(out[0]!.title).toBe('renamed');
    expect(out[0]!.state).toBe('idle');
    expect(out[1]!.state).toBe('thinking');
  });

  it('still lets a chat begun elsewhere arrive, at the top where it belongs', () => {
    const fresh = [row('new'), row('a'), row('b')];
    expect(ids(held(fresh, [row('a'), row('b')]))).toEqual(['new', 'a', 'b']);
  });

  it('puts a newcomer behind whichever row it now follows', () => {
    const fresh = [row('a'), row('new'), row('b')];
    expect(ids(held(fresh, [row('a'), row('b')]))).toEqual(['a', 'new', 'b']);
  });

  it('keeps two newcomers in their own order behind the same row', () => {
    const fresh = [row('a'), row('one'), row('two'), row('b')];
    expect(ids(held(fresh, [row('a'), row('b')]))).toEqual(['a', 'one', 'two', 'b']);
  });

  it('drops a row that is no longer in the list', () => {
    const fresh = [row('c'), row('a')];
    expect(ids(held(fresh, [row('a'), row('b'), row('c')]))).toEqual(['a', 'c']);
  });

  it('holds a chat that has no id of its own by the one it is offered under', () => {
    const waiting = row('unused', { sessionId: null, externalId: 'from-a-terminal' });
    const fresh = [row('a'), waiting];
    expect(held(fresh, [waiting, row('a')]).map((r) => r.externalId)).toEqual(['from-a-terminal', 'x-a']);
  });

  it('is settled again by an empty memory, which is what re-opening the list gives it', () => {
    const fresh = [row('b'), row('a')];
    expect(ids(holdStill(fresh, [], now))).toEqual(['b', 'a']);
  });
});

/**
 * The complaint, 2026-09-04: a screenshot of the rail with YESTERDAY over seven
 * rows and TODAY over one row below them. The row under TODAY was a chat begun
 * the afternoon before and spoken in again that morning: its clock, its time and
 * its heading had all moved on, and only its PLACE was a day old, because the
 * list was holding it where it had drawn it (bw-hgd2).
 */
describe('a row that has left the block it was drawn in', () => {
  /** Yesterday's chats, oldest last, as the list settled overnight. */
  const yesterday = [
    row('ten', { lastSpokeAt: at(18, 22) }),
    row('four', { lastSpokeAt: at(18, 16) }),
    row('two', { lastSpokeAt: at(18, 14) }),
  ];

  it('takes the place the fresh order gives it, so the day is never out of order', () => {
    // He sends a message this morning in the chat he began yesterday afternoon.
    const spokenIn = row('two', { lastSpokeAt: at(19, 11, 20) });
    const fresh = [spokenIn, ...yesterday.slice(0, 2)].sort(byWhatIsWorking);
    const out = holdStill(fresh, drawn(yesterday), now);
    expect(ids(out)).toEqual(['two', 'ten', 'four']);
    expect(groupRows(out, now).map((g) => g.heading)).toEqual(['Today', 'Yesterday']);
  });

  it('and it is his own message that moves it, not an agent writing in it', () => {
    // Ten minutes of an agent answering him: the newest thing on the list, and
    // not his own. The row does not move and the day over it does not change.
    const working = row('four', { lastSpokeAt: at(18, 16), lastActiveAt: at(19, 11, 40), state: 'thinking' });
    const fresh = [working, row('ten', { lastSpokeAt: at(18, 22) }), row('two', { lastSpokeAt: at(18, 14) })];
    expect(ids(holdStill(fresh, drawn(yesterday), now))).toEqual(['ten', 'four', 'two']);
  });

  it('holds it still when his message only moves it inside the day it is already in', () => {
    const today = [row('a', { lastSpokeAt: at(19, 10) }), row('b', { lastSpokeAt: at(19, 9) })];
    const spokenIn = row('b', { lastSpokeAt: at(19, 11, 30) });
    const fresh = [spokenIn, today[0]!].sort(byWhatIsWorking);
    expect(ids(holdStill(fresh, drawn(today), now))).toEqual(['a', 'b']);
  });

  it('carries a chat somebody has taken up into the block at the top', () => {
    // Open elsewhere is a heading like any other: a row that joins it cannot
    // stay halfway down the list, where it would open that heading a second
    // time under the days (bw-dmxj.11).
    const taken = row('two', { lastSpokeAt: at(18, 14), runningElsewhere: true });
    const fresh = [taken, ...yesterday.slice(0, 2)].sort(byWhatIsWorking);
    const out = holdStill(fresh, drawn(yesterday), now);
    expect(ids(out)).toEqual(['two', 'ten', 'four']);
    expect(groupRows(out, now).map((g) => g.heading)).toEqual([OPEN_ELSEWHERE, 'Yesterday']);
  });
});
