/**
 * The one reading every screen draws a chat from.
 *
 * Four screens used to answer "what is this chat doing" four ways, and the
 * loudest of them said "working" over a terminal sitting at an empty prompt.
 * These cases hold the reading to the three facts it separates: what it is
 * doing this second, where it stands when it is doing nothing, and who holds
 * it — the last of which never stands in place of the first two (bw-96is).
 */
import { describe, expect, it } from 'vitest';

import { RECORD_QUIET_MS, chatState, counting, heldDoing, heldLine, type HeldChat } from '@/workbench/chat-state';
import type { SessionState } from '@/workbench/protocol';

/** Every state a chat of ours can be published in, in the protocol's own order. */
const ALL: SessionState[] = [
  'starting',
  'idle',
  'thinking',
  'streaming',
  'running_tool',
  'waiting_permission',
  'stopped',
  'errored',
  'ended',
  'dormant',
];

/** The states in which an agent of ours owes an answer and the mark must move. */
const MOVING: SessionState[] = ['starting', 'thinking', 'streaming', 'running_tool'];

function held(over: Partial<HeldChat> = {}): HeldChat {
  return { id: 'ef56704b', holder: 'terminal', doing: 'working', since: 1_000, ...over };
}

describe('a chat of ours', () => {
  it('moves the mark in exactly the states where an answer is owed', () => {
    for (const state of ALL) {
      expect(chatState({ state }).working, `${state} drew the wrong mark`).toBe(MOVING.includes(state));
    }
  });

  it('says something in every state, and never says two things at once', () => {
    for (const state of ALL) {
      const read = chatState({ state });
      expect(read.word, `${state} said nothing at all`).not.toBe('');
      // Working and waiting are two different marks; a chat is one or neither.
      expect(read.working && read.waiting, `${state} drew both marks`).toBe(false);
      expect(read.external, `${state} claimed a holder with none given`).toBeNull();
    }
  });

  it('counts seconds while something is going on, and not once it has stopped', () => {
    for (const state of ALL) {
      const read = chatState({ state, since: 5_000 });
      const shouldCount = MOVING.includes(state) || state === 'waiting_permission';
      expect(read.since, `${state} counted the wrong way`).toBe(shouldCount ? 5_000 : null);
      expect(counting(state), `counting() disagreed about ${state}`).toBe(shouldCount);
    }
  });

  it('prefers the driver’s own words to the table behind them', () => {
    expect(chatState({ state: 'running_tool', label: 'Asking about Edit' }).word).toBe('Asking about Edit');
    // The floor, for a label a dead process left behind or never wrote.
    expect(chatState({ state: 'running_tool', label: '' }).word).toBe('Working');
    expect(chatState({ state: 'dormant', label: null }).word).toBe('Asleep');
  });

  it('waiting on the reader is its own mark, not working', () => {
    const read = chatState({ state: 'waiting_permission', since: 9 });
    expect([read.working, read.waiting, read.since]).toEqual([false, true, 9]);
  });
});

describe('a chat another program holds', () => {
  it('says what the holder is doing, whatever our own side was left saying', () => {
    // Our state for a held chat is dormant — no agent of ours is attached —
    // and drawing "Asleep" over a terminal mid-turn is the exact lie this
    // replaces.
    for (const state of ALL) {
      const read = chatState({ state, label: 'Answering', held: held() });
      expect(read.working, `${state} lost the holder's word`).toBe(true);
      expect(read.word).toBe('Working');
      expect(read.since).toBe(1_000);
    }
  });

  it('draws the badge in every state, and never in place of the doing', () => {
    for (const state of ALL) {
      for (const doing of ['working', 'idle', 'unknown'] as const) {
        const read = chatState({ state, held: held({ doing }) });
        expect(read.external, `${state}/${doing} lost the badge`).toEqual({ holder: 'terminal' });
      }
    }
  });

  it('is idle when the holder says so, with nothing counting', () => {
    const read = chatState({ state: 'dormant', held: held({ doing: 'idle', since: 5 }) });
    expect([read.working, read.word, read.since]).toEqual([false, 'Idle', null]);
  });

  it('claims nothing at all when nothing on the machine will say', () => {
    const read = chatState({ state: 'dormant', held: held({ doing: 'unknown', since: null }) });
    // No word means the chip draws nothing; the badge beside it is the whole
    // of what the screen can honestly say.
    expect([read.working, read.waiting, read.word]).toEqual([false, false, '']);
    expect(read.external).toEqual({ holder: 'terminal' });
  });

  it('never mistakes one kind of holder for the other', () => {
    expect(chatState({ state: 'dormant', held: held({ holder: 'program' }) }).external).toEqual({
      holder: 'program',
    });
  });
});

describe('what a held chat is doing, from the two signals there are', () => {
  const now = 1_787_138_400_000;

  it('takes the holder’s own word first, and the moment it said it', () => {
    expect(heldDoing({ status: 'busy', statusAt: now - 4_000, recordMovedAt: null, burstAt: null, now })).toEqual({
      doing: 'working',
      since: now - 4_000,
    });
    // Its word beats the record even when the record disagrees: a chat that
    // has just been told to stop is idle the moment it says so, however
    // recently it was writing.
    expect(heldDoing({ status: 'idle', statusAt: now, recordMovedAt: now, burstAt: null, now })).toEqual({
      doing: 'idle',
      since: null,
    });
  });

  it('falls back to the record moving when nothing says a word', () => {
    const moving = heldDoing({ status: null, statusAt: null, recordMovedAt: now - 2_000, burstAt: null, now });
    expect(moving).toEqual({ doing: 'working', since: now - 2_000 });

    const quiet = heldDoing({
      status: null,
      statusAt: null,
      recordMovedAt: now - RECORD_QUIET_MS - 1,
      burstAt: null,
      now,
    });
    expect(quiet).toEqual({ doing: 'idle', since: null });
  });

  it('counts the turn from where it began, not from the last line of it', () => {
    // The record grows through an answer, so counting from its newest write
    // would restart the seconds every few lines. The burst's own start is what
    // the reader is watching.
    const begun = now - 30_000;
    expect(
      heldDoing({ status: null, statusAt: null, recordMovedAt: now - 1_000, burstAt: begun, now }),
    ).toEqual({ doing: 'working', since: begun });
  });

  it('says it does not know rather than guessing idle', () => {
    // A host-driven process writes no status; if its record is not found
    // either, the honest answer is nothing at all — not that it is idle.
    expect(heldDoing({ status: null, statusAt: null, recordMovedAt: null, burstAt: null, now })).toEqual({
      doing: 'unknown',
      since: null,
    });
  });

  it('is silent about when a chat went idle, so nothing counts against it', () => {
    for (const status of ['idle', null]) {
      const read = heldDoing({ status, statusAt: now, recordMovedAt: now - RECORD_QUIET_MS - 1, burstAt: now, now });
      expect(read.since, `${status ?? 'no'} status left a count running`).toBeNull();
    }
  });
});

describe('the line where a held chat’s writing box would be', () => {
  /** The reading for a held chat, as the pane has it. */
  const held = (doing: HeldChat['doing'], holder: HeldChat['holder'] = 'terminal') =>
    chatState({ state: 'dormant', held: { id: 'c', holder, doing, since: 1_000 } });

  it('claims somebody is working only while the mark beside it says so', () => {
    // The two are a foot apart on the screen. The line used to say somebody was
    // working in the chat whatever the holder was doing, so a terminal that had
    // gone quiet drew "Idle" and a flat contradiction of it (bw-96is.9).
    expect(heldLine(held('working'))).toContain('is working in it now');
    for (const doing of ['idle', 'unknown'] as const) {
      expect(heldLine(held(doing)), `${doing} was described as working`).not.toContain('working');
    }
  });

  it('says they have it open whatever they are doing, because that is what is true', () => {
    for (const doing of ['working', 'idle', 'unknown'] as const) {
      expect(heldLine(held(doing)), `${doing} said nothing about who holds it`).toContain('has this chat open');
    }
  });

  it('names a terminal as somebody and anything else as another program', () => {
    expect(heldLine(held('idle', 'terminal'))).toContain('in a terminal');
    expect(heldLine(held('idle', 'program'))).toContain('Another program');
    expect(heldLine(held('idle', 'program'))).not.toContain('terminal');
  });

  it('promises the box back when they let go, not when they stop working', () => {
    // A terminal that has stopped working still holds the conversation, so
    // "when they stop" promised a box that does not arrive.
    const line = heldLine(held('idle'));
    expect(line).toContain('comes back when they let go');
    expect(line).not.toContain('when they stop');
  });
});
