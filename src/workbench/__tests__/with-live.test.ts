/**
 * The list of chats keeps up with what is happening.
 *
 * It is asked for when the tab opens. What the chats in it are doing reaches
 * it through the app's one live stream, and this is the join. Which chats are
 * in it is the server's answer alone: the stream only says when to ask again.
 */
import { describe, expect, it } from 'vitest';

import { unlisted, withLive, withLocal } from '@/workbench/chat-sidebar';
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
    // Every row the server sends is named (protocol.ts, RestoreRow.name).
    name: over.name ?? over.title ?? 'An older chat',
  };
}

function session(over: Partial<LiveSession> = {}): LiveSession {
  return {
    id: 's2',
    brand: 'claude',
    model: null,
    externalId: null,
    projectId: PROJECT,
    projectPath: '/home/me/project',
    cwd: '/home/me/project/worktrees/fix-a-thing',
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

describe('which chats are listed is the server\'s answer', () => {
  it('a chat the stream knows and the list does not is never drawn from the stream', () => {
    expect(withLive([row()], [session()]).map((r) => r.sessionId)).toEqual(['s1']);
    expect(withLive([], [session({ state: 'dormant' })])).toEqual([]);
  });

  it('it is a reason to ask the server again, awake or asleep, wherever it works', () => {
    // A new chat that has not been spoken in is asleep, and so is one whose
    // profile was just changed; both used to fall out of the list here
    // (bw-ljko.1). A chat in a worktree the page has never heard of is the
    // server's to place, not the page's.
    expect(unlisted([row()], [session()], PROJECT)).toEqual(['s2:claude:']);
    expect(unlisted([row()], [session({ state: 'dormant' })], PROJECT)).toEqual(['s2:claude:']);
    expect(unlisted([row()], [session({ cwd: '/somewhere/else' })], PROJECT)).toEqual(['s2:claude:']);
  });

  it('a chat whose conversation was replaced under it is asked about again', () => {
    // A profile switch keeps the chat and its provider and starts a new
    // conversation, so the row's conversation id is the old one.
    const listed = row({ externalId: 'x-old' });
    expect(unlisted([listed], [session({ id: 's1', externalId: 'x-old' })], PROJECT)).toEqual([]);
    expect(unlisted([listed], [session({ id: 's1', externalId: null })], PROJECT)).toEqual(['s1:claude:']);
    expect(unlisted([listed], [session({ id: 's1', brand: 'codex', externalId: 'x-old' })], PROJECT)).toEqual(['s1:codex:x-old']);
  });

  it('another project\'s chats are not this list\'s question', () => {
    expect(unlisted([], [session({ projectId: 'other' })], PROJECT)).toEqual([]);
  });

  it('the database\'s answer replaces what it holds and keeps what only discovery found', () => {
    const found = row({ sessionId: null, externalId: 'x9', title: 'Only in the tool' });
    const drawn = [row({ title: 'Old title' }), found];
    const local = [row({ title: 'New title' }), row({ sessionId: 's2', title: 'Just started' })];
    const laid = withLocal(drawn, local);
    expect(laid.map((r) => r.title).sort()).toEqual(['Just started', 'New title', 'Only in the tool']);
  });

  it('a chat already listed is not listed twice, and takes the newer state', () => {
    const merged = withLive([row()], [session({ id: 's1', state: 'thinking', title: 'Renamed' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.state).toBe('thinking');
    expect(merged[0]!.title).toBe('An older chat');
  });

  it('what the row already knew survives a live frame that knows less', () => {
    const merged = withLive([row({ beads: ['bw-1'] })], [session({ id: 's1', title: null, beads: [] })]);
    expect(merged[0]!.beads).toEqual(['bw-1']);
    expect(merged[0]!.title).toBe('An older chat');
  });

  it('a sleeping chat the list does hold keeps its place', () => {
    const merged = withLive([row()], [session({ id: 's1', state: 'dormant' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sessionId).toBe('s1');
  });

  // The list is ordered by where the work is, not by what happened last, and the
  // stream must not undo that when it merges a chat this app is driving.
  it('a chat somebody is working in stays above one that only started later', () => {
    const busy = row({ sessionId: 's1', runningElsewhere: true });
    const later = row({ sessionId: 's2', lastActiveAt: '2026-08-16T11:00:00.000Z' });
    const merged = withLive([later, busy], [session()]);
    expect(merged.map((r) => r.sessionId)).toEqual(['s1', 's2']);
  });

  it('a row keeps the later of the two dates, never the stream’s alone', () => {
    const merged = withLive(
      [row({ lastActiveAt: '2026-08-16T12:00:00.000Z' })],
      [session({ id: 's1', state: 'thinking', lastActiveAt: '2026-08-16T11:00:00.000Z' })],
    );
    expect(merged[0]!.lastActiveAt).toBe('2026-08-16T12:00:00.000Z');
  });

  it('the working mark survives the stream touching the row', () => {
    const merged = withLive([row({ runningElsewhere: true })], [session({ id: 's1', state: 'thinking' })]);
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
    const marked = withLive([row({ sessionId: null, externalId: 'x1' })], [], new Set(['x1']));
    expect(marked[0]!.runningElsewhere).toBe(true);
  });

  it('marks a dormant Atelier-created chat when a current outside owner resumes it', () => {
    const marked = withLive(
      [row({ sessionId: 's1', state: 'dormant', externalId: 'x1' })],
      [],
      new Set(['x1']),
      new Map([['x1', { id: 'x1', holder: 'program' as const, doing: 'running' as const, detail: 'Bash', since: 1_000 }]]),
    );

    expect(marked[0]!.runningElsewhere).toBe(true);
    expect(marked[0]!.held?.detail).toBe('Bash');
  });

  it('keeps following an imported terminal session after it has a local id', () => {
    const marked = withLive(
      [row({ sessionId: 'imported', origin: 'terminal', state: 'dormant', externalId: 'x1' })],
      [],
      new Set(['x1']),
      new Map([['x1', { id: 'x1', holder: 'terminal' as const, doing: 'running' as const, detail: 'Bash', since: 1_000 }]]),
    );

    expect(marked[0]!.runningElsewhere).toBe(true);
    expect(marked[0]!.held?.doing).toBe('running');
  });

  it('and it goes when the work stops', () => {
    const marked = withLive([row({ externalId: 'x1', runningElsewhere: true })], [], new Set<string>());
    expect(marked[0]!.runningElsewhere).toBe(false);
  });

  it('a chat that starts being worked in climbs over one with a newer date', () => {
    const rows = [
      row({ sessionId: null, externalId: 'x1', lastActiveAt: '2026-08-16T09:00:00.000Z' }),
      row({ sessionId: 's2', externalId: 'x2', lastActiveAt: '2026-08-16T12:00:00.000Z' }),
    ];
    expect(withLive(rows, [], new Set<string>()).map((r) => r.externalId ?? r.sessionId)).toEqual(['x2', 'x1']);
    expect(withLive(rows, [], new Set(['x1'])).map((r) => r.externalId ?? r.sessionId)).toEqual(['x1', 'x2']);
  });

  // Until the stream has spoken there is nothing to apply, and the list has
  // already arrived marked from the sidecar.
  it('says nothing before the stream has, rather than saying nothing is running', () => {
    const merged = withLive([row({ externalId: 'x1', runningElsewhere: true })], [], null);
    expect(merged[0]!.runningElsewhere).toBe(true);
  });

  it('a chat this app started itself is left alone: the stream names conversations', () => {
    const merged = withLive([row({ externalId: null, runningElsewhere: true })], [], new Set<string>());
    expect(merged[0]!.runningElsewhere).toBe(true);
  });

  it('an outside owner outranks stale local state and a read-only follower', () => {
    // The server has already removed this app's own provider drivers from the
    // hold set. What remains is somebody else, even if a stale state or the
    // follower opened to tail that transcript still reads as awake.
    const merged = withLive(
      [row({ externalId: 'x1', runningElsewhere: true })],
      [session({ id: 's1', externalId: 'x1', state: 'thinking' })],
      new Set(['x1']),
      new Map([['x1', { id: 'x1', holder: 'terminal' as const, doing: 'working' as const, since: null }]]),
    );
    expect(merged[0]!.runningElsewhere).toBe(true);
    expect(merged[0]!.held?.holder).toBe('terminal');
  });

  it('and still says so for a chat nothing of ours is on', () => {
    const merged = withLive(
      [row({ sessionId: null, externalId: 'x1' })],
      [],
      new Set(['x1']),
      new Map([['x1', { id: 'x1', holder: 'terminal' as const, doing: 'working' as const, since: null }]]),
    );
    expect(merged[0]!.runningElsewhere).toBe(true);
    expect(merged[0]!.held?.holder).toBe('terminal');
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
    expect(withLive(rows, [working]).map((r) => r.sessionId)).toEqual(['talking', 'busy']);
  });

  it('a message he sends carries its chat to the top', () => {
    const rows = [
      row({ sessionId: 'talking', lastActiveAt: spoke, lastSpokeAt: spoke }),
      row({ sessionId: 'busy', lastActiveAt: '2026-08-16T08:00:00.000Z', lastSpokeAt: '2026-08-16T08:00:00.000Z' }),
    ];
    const answered = session({ id: 'busy', lastActiveAt: '2026-08-16T12:00:00.000Z', lastSpokeAt: '2026-08-16T12:00:00.000Z' });
    expect(withLive(rows, [answered]).map((r) => r.sessionId)).toEqual(['busy', 'talking']);
  });

  it('never backwards: the row keeps a later time read from the chat’s own record', () => {
    // He typed in a terminal, which our driver never saw; the record did.
    const known = row({ sessionId: 's1', lastSpokeAt: '2026-08-16T12:00:00.000Z' });
    const stale = session({ id: 's1', lastSpokeAt: '2026-08-16T09:00:00.000Z' });
    expect(withLive([known], [stale])[0]!.lastSpokeAt).toBe('2026-08-16T12:00:00.000Z');
  });

  it('a chat nobody has spoken in keeps no clock of its own, so it orders by what happened', () => {
    const known = row({ sessionId: 's1', lastSpokeAt: null });
    const quiet = session({ id: 's1', lastSpokeAt: null, lastActiveAt: '2026-08-16T12:00:00.000Z' });
    const [merged] = withLive([known], [quiet]);
    expect(merged!.lastSpokeAt, 'silence was written down as a time').toBeNull();
    expect(merged!.lastActiveAt).toBe('2026-08-16T12:00:00.000Z');
  });

  it('a held row keeps its holder and forgets what they were doing once the stream is gone', () => {
    // The stream said this, then died. The row was fetched before any of it and
    // is not fetched again while nothing is speaking, so its own copy is older
    // than the one just thrown away: drawn as it stands, the mark starts
    // turning again and counts from a moment long gone (bw-96is.22).
    const working = row({
      sessionId: 'in-a-terminal',
      externalId: 'x1',
      origin: 'terminal',
      runningElsewhere: true,
      held: { id: 'x1', holder: 'terminal', doing: 'working', since: 1_000 },
    });

    const [drawn] = withLive([working], [], null, null, true);
    expect(drawn!.held?.holder, 'the badge went with it: a terminal does not leave because a browser did').toBe('terminal');
    expect(drawn!.held?.doing, 'the row went on saying what a dead connection last saw').toBe('unknown');
    expect(drawn!.held?.since, 'the seconds went on counting from a fact nobody stands behind').toBeNull();
    expect(drawn!.runningElsewhere, 'the door was opened on a chat somebody is in').toBe(true);
  });

  it('leaves the row alone while the stream has simply not spoken yet', () => {
    // The same null holds, and the opposite answer: nothing has been said, so
    // what the list was fetched with is the freshest thing there is.
    const working = row({
      sessionId: 'in-a-terminal',
      externalId: 'x1',
      origin: 'terminal',
      runningElsewhere: true,
      held: { id: 'x1', holder: 'terminal', doing: 'working', since: 1_000 },
    });

    const [drawn] = withLive([working], [], null, null, false);
    expect(drawn!.held?.doing, 'a list rubbed its own marks out before anybody had spoken').toBe('working');
    expect(drawn!.held?.since).toBe(1_000);
  });

});
