/**
 * The seconds on a chip, and where they count from.
 *
 * Three screens draw that number — the row in the list, the glance strip and a
 * board card — and all three read it off one field the live stream keeps
 * (`busySince`). A mistake here is silent: a wrong number is still a number, in
 * three places at once, and until this nothing exercised it (bw-96is.12).
 *
 * The rule it holds to is that the count belongs to the piece of work, not to
 * the event: an agent reading two files in a row publishes `running_tool`
 * twice, and starting again on the second would show a forty-second turn as one
 * (bw-f1q.17).
 */
import { describe, expect, it } from 'vitest';

import { countingFrom } from '@/workbench/live';
import type { SessionState } from '@/workbench/protocol';

const BEGAN = '2026-08-21T10:00:00.000Z';
const LATER = '2026-08-21T10:00:40.000Z';

/** A chat as the store already has it. */
function had(over: Partial<{ state: SessionState; activity: string; busySince: string | null }> = {}) {
  return { state: 'running_tool' as SessionState, activity: 'Reading live.ts', busySince: BEGAN, ...over };
}

describe('where the seconds on a working chat count from', () => {
  it('carries on through the same piece of work said twice', () => {
    // The measured shape of it: the driver republishes its state as the answer
    // grows, and every one of those is the same turn.
    const on = countingFrom(had(), { state: 'running_tool', label: 'Reading live.ts', at: LATER });
    expect(on, 'the count restarted on a repeat of what it was already doing').toBe(BEGAN);
  });

  it('starts again when the words change, even in the same state', () => {
    const on = countingFrom(had(), { state: 'running_tool', label: 'Reading chat-state.ts', at: LATER });
    expect(on, 'a new piece of work kept the old turn’s clock').toBe(LATER);
  });

  it('starts again when the state changes, even under the same words', () => {
    const on = countingFrom(had(), { state: 'thinking', label: 'Reading live.ts', at: LATER });
    expect(on).toBe(LATER);
  });

  it('starts at this event for a chat the store has never seen', () => {
    expect(countingFrom(undefined, { state: 'thinking', label: 'Thinking', at: LATER })).toBe(LATER);
  });

  it('counts nothing at all once the chat has stopped working', () => {
    for (const state of ['idle', 'stopped', 'errored', 'dormant'] as SessionState[]) {
      expect(countingFrom(had(), { state, label: '', at: LATER }), `${state} left a count running`).toBeNull();
    }
  });

  it('counts while the chat is waiting on the reader, which is its own kind of waiting', () => {
    // A question about a tool is not working, but how long it has been asked is
    // exactly what the reader wants: the chip wears a hand and the same seconds.
    expect(countingFrom(undefined, { state: 'waiting_permission', label: 'Edit', at: LATER })).toBe(LATER);
  });

  it('survives a chat that was working with no start recorded', () => {
    // Nothing in the restore list says when a turn began, so a chat found
    // already working can reach here with a null. Repeating its own state must
    // not leave the count unset for ever.
    const on = countingFrom(had({ busySince: null }), { state: 'running_tool', label: 'Reading live.ts', at: LATER });
    expect(on).toBe(LATER);
  });
});
