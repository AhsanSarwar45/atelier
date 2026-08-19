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
