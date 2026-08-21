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

import { clockTime, groupRows, OPEN_ELSEWHERE } from '@/workbench/chat-sidebar';
import { byWhatIsWorking, laterOf, whenHeSpoke, type RestoreRow } from '@/workbench/protocol';

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
 * The blocks the list is drawn in follow from that order: the chats another
 * program holds are first whatever their date, so the heading over them says
 * that, and the days start underneath.
 *
 * The heading is what the block has in common and nothing more. It read
 * "Working now" and the block is filled by who HOLDS a chat, so a terminal left
 * at a prompt overnight was filed as working (bw-96is.15) — the same swap of
 * occupancy for activity this job removed from the row, the pane and the badge.
 *
 * Written in local time, because a heading is a day as the reader's own clock
 * counts it and the run may be anywhere.
 */
describe('the blocks the list is drawn in', () => {
  const now = new Date(2026, 7, 19, 12, 0, 0);
  const at = (day: number, hour: number) => new Date(2026, 7, day, hour, 0, 0).toISOString();

  it('says only that a held chat is open elsewhere, never that it is working', () => {
    const quiet = row({
      sessionId: 'quiet',
      lastActiveAt: at(19, 9),
      runningElsewhere: true,
      // A terminal sitting at a prompt: held, and doing nothing at all.
      held: { id: 'x1', holder: 'terminal', doing: 'idle', since: null },
    });
    const [block] = groupRows([quiet], now);
    expect(block!.heading).toBe(OPEN_ELSEWHERE);
    expect(block!.heading.toLowerCase(), 'the heading claims work the holder is not doing').not.toContain('working');
  });

  it('files a held chat that is working and one that is not under the same heading', () => {
    // Two blocks would read better and behave worse: the list's order is held
    // still while the reader looks at it, so a chat whose terminal stopped
    // would cross from one block to the other under his hand. What each is
    // doing is on the row, which changes in place.
    const busy = row({
      sessionId: 'busy',
      lastActiveAt: at(19, 11),
      runningElsewhere: true,
      held: { id: 'x1', holder: 'terminal', doing: 'working', since: 1 },
    });
    const quiet = row({
      sessionId: 'quiet',
      lastActiveAt: at(19, 9),
      runningElsewhere: true,
      held: { id: 'x2', holder: 'terminal', doing: 'idle', since: null },
    });
    const groups = groupRows([busy, quiet], now);
    expect(groups.map((g) => g.heading)).toEqual([OPEN_ELSEWHERE]);
    expect(groups[0]!.rows.map((r) => r.sessionId)).toEqual(['busy', 'quiet']);
  });

  it('puts a chat being worked in under its own heading, not under a day', () => {
    const working = row({ sessionId: 'busy', lastActiveAt: at(17, 16), runningElsewhere: true });
    const idle = row({ sessionId: 'idle', lastActiveAt: at(19, 10) });
    const groups = groupRows([working, idle], now);
    expect(groups.map((g) => g.heading)).toEqual([OPEN_ELSEWHERE, 'Today']);
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
    expect(headings).toEqual([OPEN_ELSEWHERE, 'Today', 'Yesterday']);
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

/**
 * The clock the list runs on.
 *
 * The complaint: "the ordering of the chats must be the last time the USER
 * sent a message, so they don't keep jumping around as agents message". Every
 * reply, every line of thinking, every question about a tool moved a row, so
 * three agents at work shuffled the list under the manager's cursor (bw-zhs9).
 *
 * One clock for all three uses of a time — the order, the day over a row, and
 * the time on the row — because ordering by one and heading by another files a
 * row under a day it is not dated for.
 */
describe('the clock the list runs on', () => {
  const now = new Date(2026, 7, 19, 12, 0, 0);
  const at = (day: number, hour: number) => new Date(2026, 7, day, hour, 0, 0).toISOString();

  it('a chat whose agent is working sits where he left it, not at the top', () => {
    const talking = row({ sessionId: 'talking', lastActiveAt: at(19, 9), lastSpokeAt: at(19, 9) });
    // Ten minutes of an agent writing: the newest thing on the list, and not
    // his own.
    const busy = row({ sessionId: 'busy', lastActiveAt: at(19, 11), lastSpokeAt: at(19, 8) });
    expect([busy, talking].sort(byWhatIsWorking).map((r) => r.sessionId)).toEqual(['talking', 'busy']);
  });

  it('and the message he sends carries it back to the top', () => {
    const talking = row({ sessionId: 'talking', lastActiveAt: at(19, 9), lastSpokeAt: at(19, 9) });
    const answered = row({ sessionId: 'busy', lastActiveAt: at(19, 11), lastSpokeAt: at(19, 11) });
    expect([talking, answered].sort(byWhatIsWorking).map((r) => r.sessionId)).toEqual(['busy', 'talking']);
  });

  it('a chat nobody has spoken in orders by what happened in it, as the whole list used to', () => {
    const older = row({ sessionId: 'older', lastActiveAt: at(19, 9), lastSpokeAt: null });
    const newer = row({ sessionId: 'newer', lastActiveAt: at(19, 11) });
    expect([older, newer].sort(byWhatIsWorking).map((r) => r.sessionId)).toEqual(['newer', 'older']);
  });

  it('the day over a row and the time on it are the same clock as the order', () => {
    // He spoke yesterday; the agent answered this morning. The row belongs
    // under yesterday, where its own order puts it.
    const row_ = row({ sessionId: 'yesterday', lastActiveAt: at(19, 11), lastSpokeAt: at(18, 16) });
    const today = row({ sessionId: 'today', lastActiveAt: at(19, 10), lastSpokeAt: at(19, 10) });
    const groups = groupRows([today, row_].sort(byWhatIsWorking), now);
    expect(groups.map((g) => g.heading)).toEqual(['Today', 'Yesterday']);
    expect(groups[1]!.rows.map((r) => r.sessionId)).toEqual(['yesterday']);
    expect(clockTime(whenHeSpoke(row_))).toBe(clockTime(at(18, 16)));
  });
});
