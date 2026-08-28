/**
 * @vitest-environment node
 *
 * A helper stopped before it said anything, and the chat it was running in
 * (bw-sxzv.1).
 *
 * Stop while a helper is still working kills the helper, and the kit says so
 * with a status and nothing else: no report, no last word. The finished line it
 * leaves behind carries no result at all, which is the honest thing to carry —
 * there was no answer.
 *
 * Every event this app stores passes the trimmer on its way to the wire, and
 * the trimmer used to ask how long the result was. Asking a length of nothing
 * threw, inside the loop reading the kit's messages, so one cancelled helper
 * took the whole conversation down with it: a red line, a spinner nothing could
 * stop, and a chat that answered nothing else until the app was restarted.
 * Recorded at session 81f66ec9 seq 175; two chats died this way on 2026-08-28.
 *
 * Held across the seam rather than either side of it: the real driver reads the
 * kit's real messages, and the real wire boundary is asked what it makes of
 * them.
 */
import { describe, expect, it } from 'vitest';

import { cut } from '../../../src/workbench/imported-history.ts';
import type { WbpEvent } from '../../../src/workbench/protocol.ts';
import { boundedEvent } from '../bounded-event.ts';
import { ClaudeDriver } from '../drivers/claude.ts';

/** The chat's own helper, sent off. */
const SENT_OFF = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'afa98b872c4df37bc',
  tool_use_id: 'toolu_01GDoyt2caPUwy8LmHwbcma1',
  description: 'Sleep 45 seconds then report',
  subagent_type: 'general-purpose',
  task_type: 'local_agent',
};

/** And what the kit says about it the moment his Stop reaches it. */
const KILLED = {
  type: 'system',
  subtype: 'task_updated',
  task_id: SENT_OFF.task_id,
  patch: { status: 'killed' },
};

/**
 * What the driver puts on the wire for those messages.
 *
 * `emit` is the driver's own, reached past its privacy: the alternative is
 * `start()`, which launches a real agent process.
 */
function emitted(messages: Record<string, unknown>[]): WbpEvent[] {
  const events: WbpEvent[] = [];
  const driver = new ClaudeDriver();
  (driver as unknown as { emit: (e: Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>) => void }).emit = (e) =>
    events.push({ ...e, seq: events.length, sessionId: 's1', at: '2026-08-28T12:00:00.000Z' } as WbpEvent);
  for (const m of messages) driver.draw(m);
  return events;
}

/** The one line this is about, out of everything those two messages say. */
function finishedLine(): Extract<WbpEvent, { type: 'agent.finished' }> {
  const line = emitted([SENT_OFF, KILLED]).find((e) => e.type === 'agent.finished');
  if (line?.type !== 'agent.finished') throw new Error('the driver said nothing about the helper ending');
  return line;
}

describe('a helper stopped before it said anything', () => {
  it('leaves a finished line carrying no result, because there was no answer', () => {
    const line = finishedLine();

    expect(line.state).toBe('stopped');
    expect(line.result).toBeNull();
  });

  it('goes through the wire boundary instead of taking the chat down with it', () => {
    const line = finishedLine();

    expect(() => boundedEvent(line)).not.toThrow();
    // And comes out the far side still saying nothing. A helper that never
    // answered must not arrive holding an empty string, which a row would draw
    // as an answer of its own.
    expect(boundedEvent(line).result).toBeNull();
  });

  it('takes every other line of the same turn with it, safely', () => {
    // The throw landed in the loop reading the kit's messages, so what was
    // actually lost was the whole stream and not one row.
    expect(() => emitted([SENT_OFF, KILLED]).map(boundedEvent)).not.toThrow();
  });
});

describe('the trimmer', () => {
  it('keeps no result as no result rather than measuring it', () => {
    expect(cut(null)).toBeNull();
  });

  it('still cuts an answer a helper did give, saying how much it left out', () => {
    const long = 'x'.repeat(10_000);

    expect(cut(long).length).toBeLessThan(long.length);
    expect(cut(long)).toContain('more characters');
    expect(cut('short enough')).toBe('short enough');
  });
});
