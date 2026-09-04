/**
 * Work sent off by a chat that has since gone to sleep.
 *
 * A row in the sent-away panel goes quiet when the kit says so, and for a
 * command left running in the background the kit is the only thing that ever
 * says so. So a chat that ends while a command is out leaves that row saying
 * "working" forever: no process, no driver, and nothing left that could
 * contradict it. Measured on the owner's own board, 2026-09-04: 75 rows still
 * claiming to work, 57 of them in chats that were asleep, the oldest by
 * fifteen hours (bw-t26l.20).
 *
 * Asleep is the only state that settles them. A turn ending is not: a command
 * sent to the background is MEANT to outlive its turn, and closing those would
 * be the same lie told the other way round.
 *
 * Both folds, and the snapshot, because a restored chat arrives already folded
 * and never sees another state event to correct it.
 */
import { describe, expect, it } from 'vitest';

import { EMPTY, asView, foldAll, reduce, type SessionView } from '@/workbench/fold';
import type { WbpEvent } from '@/workbench/protocol';

let stamped = 0;
type Said<T> = T extends unknown ? Omit<T, 'seq' | 'sessionId' | 'at'> : never;
function said(e: Said<WbpEvent>): WbpEvent {
  stamped += 1;
  return { ...e, seq: stamped, sessionId: 'chat-1', at: '2026-09-04T00:00:00.000Z' } as WbpEvent;
}

/** A chat that sends off a helper and a background command, and answers neither. */
function sentOff(): WbpEvent[] {
  return [
    said({
      type: 'agent.started',
      agentId: 'task-1',
      toolCallId: 'call-1',
      kind: 'command',
      what: 'for p in 3535 3536; do ss -ltn; done',
      agentType: 'shell',
      model: null,
    }),
    said({
      type: 'agent.started',
      agentId: 'help-1',
      toolCallId: 'call-2',
      kind: 'helper',
      what: 'find the callers',
      agentType: 'general-purpose',
      model: null,
    }),
    said({ type: 'agent.progress', agentId: 'task-1', seconds: 4, tokens: 0, calls: 0, doing: 'Working', state: 'running' }),
  ];
}

function live(events: WbpEvent[]): SessionView {
  return events.reduce(reduce, EMPTY);
}

describe('work nobody is watching', () => {
  it('settles every open row when the chat goes to sleep, and says why', () => {
    const asleep = [
      ...sentOff(),
      said({ type: 'session.state', state: 'dormant', label: 'Asleep' }),
    ];
    for (const view of [live(asleep), foldAll(asleep)]) {
      expect(view.agents.map((a) => a.state)).toEqual(['stopped', 'stopped']);
      // Never `done`: nobody watched these finish, and a row claiming a
      // success it did not see is worse than one admitting it lost sight.
      expect(view.agents.every((a) => a.state !== 'done')).toBe(true);
      expect(view.agents[0]!.result).toContain('went to sleep');
    }
  });

  it('leaves a background command alone when only the turn ended', () => {
    const idle = [...sentOff(), said({ type: 'session.state', state: 'idle', label: 'Ready' })];
    for (const view of [live(idle), foldAll(idle)]) {
      expect(view.agents.map((a) => a.state)).toEqual(['running', 'running']);
    }
  });

  it('keeps what the kit actually said about a row it did close', () => {
    const answered = [
      ...sentOff(),
      said({
        type: 'agent.finished',
        agentId: 'task-1',
        state: 'done',
        result: 'both ports free',
        seconds: 9,
        tokens: 0,
        calls: 0,
        model: null,
      }),
      said({ type: 'session.state', state: 'dormant', label: 'Asleep' }),
    ];
    for (const view of [live(answered), foldAll(answered)]) {
      const [command, helper] = view.agents;
      expect(command!.state).toBe('done');
      expect(command!.result).toBe('both ports free');
      expect(helper!.state).toBe('stopped');
    }
  });

  it('reads a restored chat the same way, which never sees a state event at all', () => {
    const restored = asView({
      state: 'dormant',
      agents: [
        { ...foldAll(sentOff()).agents[0]! },
        { ...foldAll(sentOff()).agents[1]! },
      ],
    });
    expect(restored.agents.map((a) => a.state)).toEqual(['stopped', 'stopped']);

    // And a chat that really is working keeps its rows.
    const working = asView({ state: 'streaming', agents: foldAll(sentOff()).agents });
    expect(working.agents.map((a) => a.state)).toEqual(['running', 'running']);
  });
});
