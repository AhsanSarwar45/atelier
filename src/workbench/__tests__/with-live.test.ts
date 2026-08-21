/**
 * The list of chats keeps up with what is happening.
 *
 * It is asked for once when the tab opens. Everything after that — a chat
 * started here, from a card, or in another window — reaches it through the
 * app's one live stream, and this is the join.
 */
import { describe, expect, it } from 'vitest';

import { withLive } from '@/workbench/chat-sidebar';
import type { LiveSession } from '@/workbench/live';
import type { RestoreRow } from '@/workbench/protocol';

const PROJECT = 'p1';

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
    cwdHint: '/home/me/project',
    folder: 'project',
    branch: null,
    beads: [],
    ...over,
  };
}

function session(over: Partial<LiveSession> = {}): LiveSession {
  return {
    id: 's2',
    brand: 'claude',
    externalId: null,
    projectId: PROJECT,
    projectPath: '/home/me/project/worktrees/fix-a-thing',
    title: 'Just started',
    state: 'starting',
    activity: 'Starting',
    waitingFor: null,
    busySince: null,
    lastActiveAt: '2026-08-16T11:00:00.000Z',
    lastSpokeAt: null,
    startedAt: '2026-08-16T11:00:00.000Z',
    beads: [],
    ...over,
  };
}

describe('the list keeps up', () => {
  it('a chat that started after the list was fetched joins it, newest first', () => {
    const merged = withLive([row()], [session()], PROJECT);
    expect(merged.map((r) => r.sessionId)).toEqual(['s2', 's1']);
    expect(merged[0]!.title).toBe('Just started');
  });

  it('the new row says where it is working', () => {
    const [fresh] = withLive([], [session()], PROJECT);
    expect(fresh!.folder).toBe('fix-a-thing');
    expect(fresh!.cwdHint).toBe('/home/me/project/worktrees/fix-a-thing');
  });

  it('a chat already listed is not listed twice, and takes the newer state', () => {
    const merged = withLive([row()], [session({ id: 's1', state: 'thinking', title: 'Renamed' })], PROJECT);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.state).toBe('thinking');
    expect(merged[0]!.title).toBe('Renamed');
  });

  it('what the row already knew survives a live frame that knows less', () => {
    const merged = withLive([row({ beads: ['bw-1'] })], [session({ id: 's1', title: null, beads: [] })], PROJECT);
    expect(merged[0]!.beads).toEqual(['bw-1']);
    expect(merged[0]!.title).toBe('An older chat');
  });

  it('another project\'s chats stay out of this one\'s list', () => {
    expect(withLive([], [session({ projectId: 'other' })], PROJECT)).toEqual([]);
  });

  it('a sleeping chat the list left out does not come back through the live stream', () => {
    expect(withLive([], [session({ state: 'dormant', title: null })], PROJECT)).toEqual([]);
  });

  it('a sleeping chat the list does hold keeps its place', () => {
    const merged = withLive([row()], [session({ id: 's1', state: 'dormant' })], PROJECT);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sessionId).toBe('s1');
  });

  // The list is ordered by where the work is, not by what happened last, and the
  // stream must not undo that when it merges a chat this app is driving.
  it('a chat somebody is working in stays above one that only started later', () => {
    const busy = row({ sessionId: 's1', runningElsewhere: true });
    const merged = withLive([busy], [session()], PROJECT);
    expect(merged.map((r) => r.sessionId)).toEqual(['s1', 's2']);
  });

  it('a row keeps the later of the two dates, never the stream’s alone', () => {
    const merged = withLive(
      [row({ lastActiveAt: '2026-08-16T12:00:00.000Z' })],
      [session({ id: 's1', state: 'thinking', lastActiveAt: '2026-08-16T11:00:00.000Z' })],
      PROJECT,
    );
    expect(merged[0]!.lastActiveAt).toBe('2026-08-16T12:00:00.000Z');
  });

  it('the working mark survives the stream touching the row', () => {
    const merged = withLive([row({ runningElsewhere: true })], [session({ id: 's1', state: 'thinking' })], PROJECT);
    expect(merged[0]!.runningElsewhere).toBe(true);
  });
});

/**
 * The mark keeps up on its own. Nobody reloads the tab to find out that a
 * terminal has been opened, so the set of conversations live processes are
 * holding arrives on the stream and is applied over the list as it stands.
 */
describe('the working mark keeps up', () => {
  it('a chat that starts being worked in is marked, without the list being asked again', () => {
    const marked = withLive([row({ externalId: 'x1' })], [], PROJECT, new Set(['x1']));
    expect(marked[0]!.runningElsewhere).toBe(true);
  });

  it('and it goes when the work stops', () => {
    const marked = withLive([row({ externalId: 'x1', runningElsewhere: true })], [], PROJECT, new Set<string>());
    expect(marked[0]!.runningElsewhere).toBe(false);
  });

  it('a chat that starts being worked in climbs over one with a newer date', () => {
    const rows = [
      row({ sessionId: 's1', externalId: 'x1', lastActiveAt: '2026-08-16T09:00:00.000Z' }),
      row({ sessionId: 's2', externalId: 'x2', lastActiveAt: '2026-08-16T12:00:00.000Z' }),
    ];
    expect(withLive(rows, [], PROJECT, new Set<string>()).map((r) => r.sessionId)).toEqual(['s2', 's1']);
    expect(withLive(rows, [], PROJECT, new Set(['x1'])).map((r) => r.sessionId)).toEqual(['s1', 's2']);
  });

  // Until the stream has spoken there is nothing to apply, and the list has
  // already arrived marked from the sidecar.
  it('says nothing before the stream has, rather than saying nothing is running', () => {
    const merged = withLive([row({ externalId: 'x1', runningElsewhere: true })], [], PROJECT, null);
    expect(merged[0]!.runningElsewhere).toBe(true);
  });

  it('a chat this app started itself is left alone: the stream names conversations', () => {
    const merged = withLive([row({ externalId: null, runningElsewhere: true })], [], PROJECT, new Set<string>());
    expect(merged[0]!.runningElsewhere).toBe(true);
  });
});

/**
 * The list is ordered by when the person himself last spoke, and the live
 * stream must not drag a row up it. The complaint: rows jumped around under
 * the manager's cursor while agents worked, and the chat he was talking in
 * slid away from him mid-sentence (bw-zhs9).
 */
describe('what the stream may move a row for', () => {
  const spoke = '2026-08-16T09:00:00.000Z';

  it('an agent working in a chat leaves the row where it was', () => {
    const rows = [
      row({ sessionId: 'talking', lastActiveAt: spoke, lastSpokeAt: spoke }),
      row({ sessionId: 'busy', lastActiveAt: '2026-08-16T08:00:00.000Z', lastSpokeAt: '2026-08-16T08:00:00.000Z' }),
    ];
    // The agent in the lower chat has been writing for ten minutes: its own
    // clock is now the newest thing on the list, and its spoken clock is not.
    const working = session({
      id: 'busy',
      lastActiveAt: '2026-08-16T12:00:00.000Z',
      lastSpokeAt: '2026-08-16T08:00:00.000Z',
      state: 'streaming',
    });
    expect(withLive(rows, [working], PROJECT).map((r) => r.sessionId)).toEqual(['talking', 'busy']);
  });

  it('a message he sends carries its chat to the top', () => {
    const rows = [
      row({ sessionId: 'talking', lastActiveAt: spoke, lastSpokeAt: spoke }),
      row({ sessionId: 'busy', lastActiveAt: '2026-08-16T08:00:00.000Z', lastSpokeAt: '2026-08-16T08:00:00.000Z' }),
    ];
    const answered = session({ id: 'busy', lastActiveAt: '2026-08-16T12:00:00.000Z', lastSpokeAt: '2026-08-16T12:00:00.000Z' });
    expect(withLive(rows, [answered], PROJECT).map((r) => r.sessionId)).toEqual(['busy', 'talking']);
  });

  it('never backwards: the row keeps a later time read from the chat’s own record', () => {
    // He typed in a terminal, which our driver never saw; the record did.
    const known = row({ sessionId: 's1', lastSpokeAt: '2026-08-16T12:00:00.000Z' });
    const stale = session({ id: 's1', lastSpokeAt: '2026-08-16T09:00:00.000Z' });
    expect(withLive([known], [stale], PROJECT)[0]!.lastSpokeAt).toBe('2026-08-16T12:00:00.000Z');
  });

  it('a chat nobody has spoken in keeps no clock of its own, so it orders by what happened', () => {
    const known = row({ sessionId: 's1', lastSpokeAt: null });
    const quiet = session({ id: 's1', lastSpokeAt: null, lastActiveAt: '2026-08-16T12:00:00.000Z' });
    const [merged] = withLive([known], [quiet], PROJECT);
    expect(merged!.lastSpokeAt, 'silence was written down as a time').toBeNull();
    expect(merged!.lastActiveAt).toBe('2026-08-16T12:00:00.000Z');
  });
});
