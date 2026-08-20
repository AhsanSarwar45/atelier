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
 */
import { describe, expect, it } from 'vitest';

import { holdStill } from '@/workbench/chat-sidebar';
import type { RestoreRow } from '@/workbench/protocol';

function row(id: string, over: Partial<RestoreRow> = {}): RestoreRow {
  return {
    sessionId: id,
    externalId: `x-${id}`,
    brand: 'claude',
    title: `chat ${id}`,
    lastActiveAt: '2026-08-19T10:00:00.000Z',
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

describe('holding the list still', () => {
  it('takes the fresh order the first time, having nothing to hold to', () => {
    const fresh = [row('a'), row('b'), row('c')];
    expect(ids(holdStill(fresh, []))).toEqual(['a', 'b', 'c']);
  });

  it('keeps the order he is looking at when the chats re-sort themselves', () => {
    // The measured case: two working chats trade places while he is clicking.
    const fresh = [row('b'), row('a'), row('c')];
    expect(ids(holdStill(fresh, ['a', 'b', 'c']))).toEqual(['a', 'b', 'c']);
  });

  it('lets a row change everything about itself except where it is', () => {
    const fresh = [row('b', { state: 'thinking' }), row('a', { title: 'renamed', runningElsewhere: true })];
    const out = holdStill(fresh, ['a', 'b']);
    expect(ids(out)).toEqual(['a', 'b']);
    expect(out[0]!.title).toBe('renamed');
    expect(out[0]!.runningElsewhere).toBe(true);
    expect(out[1]!.state).toBe('thinking');
  });

  it('still lets a chat begun elsewhere arrive, at the top where it belongs', () => {
    const fresh = [row('new'), row('a'), row('b')];
    expect(ids(holdStill(fresh, ['a', 'b']))).toEqual(['new', 'a', 'b']);
  });

  it('puts a newcomer behind whichever row it now follows', () => {
    const fresh = [row('a'), row('new'), row('b')];
    expect(ids(holdStill(fresh, ['a', 'b']))).toEqual(['a', 'new', 'b']);
  });

  it('keeps two newcomers in their own order behind the same row', () => {
    const fresh = [row('a'), row('one'), row('two'), row('b')];
    expect(ids(holdStill(fresh, ['a', 'b']))).toEqual(['a', 'one', 'two', 'b']);
  });

  it('drops a row that is no longer in the list', () => {
    const fresh = [row('c'), row('a')];
    expect(ids(holdStill(fresh, ['a', 'b', 'c']))).toEqual(['a', 'c']);
  });

  it('holds a chat that has no id of its own by the one it is offered under', () => {
    const waiting = row('unused', { sessionId: null, externalId: 'from-a-terminal' });
    const fresh = [row('a'), waiting];
    const settled = ['ext:from-a-terminal', 'a'];
    expect(holdStill(fresh, settled).map((r) => r.externalId)).toEqual(['from-a-terminal', 'x-a']);
  });

  it('is settled again by an empty memory, which is what re-opening the list gives it', () => {
    const fresh = [row('b'), row('a')];
    expect(ids(holdStill(fresh, []))).toEqual(['b', 'a']);
  });
});
