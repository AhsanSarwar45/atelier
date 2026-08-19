/**
 * What the restore list puts first, and which date a row carries.
 *
 * Both are the same complaint: a chat that was genuinely being worked on sat
 * 54th of 55 rows and the list draws 40, so it was not merely low down, it was
 * not drawn at all (bw-dmxj). Its date was the last time this app looked at it,
 * and its order was that date.
 *
 * Both rules live in the protocol rather than in either half, because the
 * sidecar sorts the list and the screen sorts it again once the live stream has
 * added to it, and two spellings of one order is how two halves disagree.
 */
import { describe, expect, it } from 'vitest';

import { groupRows, WORKING_NOW } from '@/workbench/chat-sidebar';
import { byWhatIsWorking, laterOf, type RestoreRow } from '@/workbench/protocol';

function row(over: Partial<RestoreRow> = {}): RestoreRow {
  return {
    sessionId: 's1',
    externalId: 'x1',
    brand: 'claude',
    title: 'A chat',
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

describe('the date a row carries', () => {
  // The measured case: our log said 15:11 on the 17th, the conversation was
  // written at 16:02 the same day, and the row sorted on ours.
  it('takes the tool’s date when the chat moved on without us', () => {
    expect(laterOf('2026-08-17T15:11:00.000Z', '2026-08-17T16:02:00.000Z')).toBe('2026-08-17T16:02:00.000Z');
  });

  it('keeps our own when it is the later of the two', () => {
    expect(laterOf('2026-08-19T09:00:00.000Z', '2026-08-18T23:59:00.000Z')).toBe('2026-08-19T09:00:00.000Z');
  });

  it('keeps our own when the tool has no date for the chat at all', () => {
    expect(laterOf('2026-08-19T09:00:00.000Z', null)).toBe('2026-08-19T09:00:00.000Z');
    expect(laterOf('2026-08-19T09:00:00.000Z', undefined)).toBe('2026-08-19T09:00:00.000Z');
  });
});

describe('what the list puts first', () => {
  it('a chat somebody is working in beats a more recent one nobody is', () => {
    const working = row({ sessionId: 'busy', lastActiveAt: '2026-08-17T16:02:00.000Z', runningElsewhere: true });
    const idle = row({ sessionId: 'idle', lastActiveAt: '2026-08-19T10:00:00.000Z' });
    expect([idle, working].sort(byWhatIsWorking).map((r) => r.sessionId)).toEqual(['busy', 'idle']);
  });

  it('two chats being worked in are newest first between themselves', () => {
    const older = row({ sessionId: 'older', lastActiveAt: '2026-08-19T09:00:00.000Z', runningElsewhere: true });
    const newer = row({ sessionId: 'newer', lastActiveAt: '2026-08-19T11:00:00.000Z', runningElsewhere: true });
    expect([older, newer].sort(byWhatIsWorking).map((r) => r.sessionId)).toEqual(['newer', 'older']);
  });

  it('with nobody working anywhere it is the order the list always had', () => {
    const a = row({ sessionId: 'a', lastActiveAt: '2026-08-19T11:00:00.000Z' });
    const b = row({ sessionId: 'b', lastActiveAt: '2026-08-19T09:00:00.000Z' });
    expect([b, a].sort(byWhatIsWorking).map((r) => r.sessionId)).toEqual(['a', 'b']);
  });

  // The flag is absent on a row the screen built out of the live stream: those
  // are this app's own sessions, which it already knows everything about.
  it('a row that says nothing about it is not treated as working', () => {
    const working = row({ sessionId: 'busy', lastActiveAt: '2026-08-17T16:02:00.000Z', runningElsewhere: true });
    const silent = row({ sessionId: 'silent', lastActiveAt: '2026-08-19T10:00:00.000Z' });
    delete silent.runningElsewhere;
    expect([silent, working].sort(byWhatIsWorking).map((r) => r.sessionId)).toEqual(['busy', 'silent']);
  });

  it('a flag set false is the same as no flag at all', () => {
    const off = row({ sessionId: 'off', lastActiveAt: '2026-08-19T10:00:00.000Z', runningElsewhere: false });
    const none = row({ sessionId: 'none', lastActiveAt: '2026-08-19T11:00:00.000Z' });
    expect([off, none].sort(byWhatIsWorking).map((r) => r.sessionId)).toEqual(['none', 'off']);
  });
});

/**
 * The blocks the list is drawn in follow from that order: the chats being
 * worked in are first whatever their date, so the heading over them says that,
 * and the days start underneath.
 *
 * Written in local time, because a heading is a day as the reader's own clock
 * counts it and the run may be anywhere.
 */
describe('the blocks the list is drawn in', () => {
  const now = new Date(2026, 7, 19, 12, 0, 0);
  const at = (day: number, hour: number) => new Date(2026, 7, day, hour, 0, 0).toISOString();

  it('puts a chat being worked in under its own heading, not under a day', () => {
    const working = row({ sessionId: 'busy', lastActiveAt: at(17, 16), runningElsewhere: true });
    const idle = row({ sessionId: 'idle', lastActiveAt: at(19, 10) });
    const groups = groupRows([working, idle], now);
    expect(groups.map((g) => g.heading)).toEqual([WORKING_NOW, 'Today']);
    expect(groups[0].rows.map((r) => r.sessionId)).toEqual(['busy']);
  });

  it('never draws a day twice', () => {
    const working = row({ sessionId: 'busy', lastActiveAt: at(19, 8), runningElsewhere: true });
    const rows = [
      working,
      row({ sessionId: 'a', lastActiveAt: at(19, 11) }),
      row({ sessionId: 'b', lastActiveAt: at(18, 9) }),
      row({ sessionId: 'c', lastActiveAt: at(19, 7) }),
    ];
    const headings = groupRows(rows, now).map((g) => g.heading);
    expect(headings, 'a heading was opened twice').toEqual(Array.from(new Set(headings)));
    expect(headings).toEqual([WORKING_NOW, 'Today', 'Yesterday']);
  });

  it('with nobody working it is the days alone, in the order given', () => {
    const rows = [
      row({ sessionId: 'a', lastActiveAt: at(19, 11) }),
      row({ sessionId: 'b', lastActiveAt: at(19, 9) }),
      row({ sessionId: 'c', lastActiveAt: at(18, 9) }),
    ];
    const groups = groupRows(rows, now);
    expect(groups.map((g) => g.heading)).toEqual(['Today', 'Yesterday']);
    expect(groups[0].rows.map((r) => r.sessionId)).toEqual(['a', 'b']);
  });
});
