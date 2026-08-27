/**
 * A chat whose past is read again draws one copy of it, not two.
 *
 * Every chat imported by an older reading is due a re-read, and the re-read
 * republishes the whole transcript to whoever is already listening. Opening such
 * a chat from a card link or a search hit and then typing appended a second full
 * copy under the one already on screen (bw-1u1.27). The log says so itself now,
 * with one event, so the live tail and a replay from seq 0 fold to the same
 * thing (docs/agent-workbench.md §4).
 */
import { describe, expect, it } from 'vitest';

import type { WbpEvent } from '@/workbench/protocol';
import { EMPTY, reduce } from '@/workbench/use-session';

/** Distributes over the union: a bare `Omit` would collapse its variants into one. */
type Unstamped<E> = E extends unknown ? Omit<E, 'seq' | 'sessionId' | 'at'> : never;

let seq = 0;
function at(e: Unstamped<WbpEvent>): WbpEvent {
  seq += 1;
  return { ...e, seq, sessionId: 'chat-1', at: '2026-08-17T00:00:00.000Z' } as WbpEvent;
}

/** One message and one command, as the import publishes them. */
function aPastChat(id: string): WbpEvent[] {
  return [
    at({ type: 'message.started', messageId: `m-${id}`, role: 'assistant' }),
    at({ type: 'text.delta', messageId: `m-${id}`, text: 'what it said' }),
    at({ type: 'message.completed', messageId: `m-${id}` }),
    at({ type: 'link.bead', beadId: 'bw-1u1', via: 'tool' }),
    at({
      type: 'tool.started',
      toolCallId: `t-${id}`,
      name: 'Bash',
      input: { command: 'npm run build' },
      title: 'npm run build',
      parentToolCallId: null,
    }),
    at({ type: 'tool.completed', toolCallId: `t-${id}`, ok: true, output: 'built in 4s' }),
  ];
}

function fold(events: WbpEvent[]) {
  return events.reduce(reduce, EMPTY);
}

describe('a chat read again', () => {
  it('draws one copy of a past it has now been sent twice', () => {
    const view = fold([...aPastChat('first'), at({ type: 'transcript.reset' }), ...aPastChat('second')]);

    expect(view.items.filter((it) => it.kind === 'message')).toHaveLength(1);
    expect(view.items.filter((it) => it.kind === 'tool')).toHaveLength(1);
  });

  it('draws the replacement, not the copy it dropped', () => {
    const view = fold([...aPastChat('first'), at({ type: 'transcript.reset' }), ...aPastChat('second')]);

    expect(view.items.map((it) => it.id)).toEqual(['m-second', 't-second']);
  });

  it('counts the cards once, since they are read out of the same record', () => {
    const view = fold([...aPastChat('first'), at({ type: 'transcript.reset' }), ...aPastChat('second')]);

    expect(view.beads).toEqual(['bw-1u1']);
  });

  it('costs a chat that was never read twice nothing at all', () => {
    const straight = fold(aPastChat('only'));
    const reset = fold([at({ type: 'transcript.reset' }), ...aPastChat('only')]);

    expect(reset.items.map((it) => it.id)).toEqual(straight.items.map((it) => it.id));
  });
});

describe('a prompt pulled back before the agent answers', () => {
  it('removes the exact user echo from the live transcript', () => {
    const before = fold([
      at({ type: 'message.started', messageId: 'older', role: 'assistant' }),
      at({ type: 'text.delta', messageId: 'older', text: 'Earlier' }),
      at({ type: 'message.completed', messageId: 'older' }),
      at({ type: 'message.started', messageId: 'pulled-back', role: 'user' }),
      at({ type: 'text.delta', messageId: 'pulled-back', text: 'testing' }),
      at({ type: 'message.completed', messageId: 'pulled-back' }),
    ]);

    const after = reduce(before, at({ type: 'message.retracted', messageId: 'pulled-back' }));

    expect(after.items.map((item) => item.id)).toEqual(['older']);
  });

  it('stays removed when the stored event log is replayed', () => {
    const view = fold([
      at({ type: 'message.started', messageId: 'pulled-back', role: 'user' }),
      at({ type: 'text.delta', messageId: 'pulled-back', text: 'testing' }),
      at({ type: 'message.completed', messageId: 'pulled-back' }),
      at({ type: 'message.retracted', messageId: 'pulled-back' }),
    ]);

    expect(view.items).toEqual([]);
  });
});
