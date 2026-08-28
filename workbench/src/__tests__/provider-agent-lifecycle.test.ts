/** @vitest-environment node */
import { describe, expect, it } from 'vitest';

import type { WbpEvent } from '../../../src/workbench/protocol.ts';
import { AgentLifecycle } from '../drivers/agent-lifecycle.ts';
import type { DriverEvent } from '../drivers/types.ts';

const START = {
  agentId: 'child-1', toolCallId: 'call-1', kind: 'helper' as const,
  what: 'Inspect the registry', agentType: 'scout', model: 'native-model',
};

const FINISH = {
  state: 'done' as const, result: 'Registry checked.', seconds: 12, tokens: 100, calls: 3,
};

function ledger() {
  const events: DriverEvent[] = [];
  return { events, agents: new AgentLifecycle((event) => events.push(event), () => 1_000) };
}

const of = (events: DriverEvent[], type: WbpEvent['type']) => events.filter((event) => event.type === type);

describe('the lifecycle every provider adapter shares', () => {
  it('writes one opening and one ending when native signals repeat', () => {
    const { events, agents } = ledger();
    agents.start(START);
    agents.start(START);
    agents.finish(START.agentId, FINISH);
    agents.finish(START.agentId, { ...FINISH, result: 'A repeated receipt.' });

    expect(of(events, 'agent.started')).toHaveLength(1);
    expect(of(events, 'agent.finished')).toEqual([
      expect.objectContaining({ result: 'Registry checked.', state: 'done' }),
    ]);
    expect(agents.size).toBe(0);
  });

  it('orders a terminal signal that arrived before the canonical start', () => {
    const { events, agents } = ledger();
    agents.finish(START.agentId, FINISH);
    expect(events).toEqual([]);

    agents.start(START);

    expect(events.map((event) => event.type)).toEqual(['agent.started', 'agent.finished']);
  });

  it('keeps a terminal tombstone so a late start and progress cannot reopen it', () => {
    const { events, agents } = ledger();
    agents.start(START);
    agents.finish(START.agentId, FINISH);
    agents.start(START);
    agents.progress(START.agentId, { state: 'running', seconds: 13, tokens: 1, calls: 1 });

    expect(of(events, 'agent.started')).toHaveLength(1);
    expect(of(events, 'agent.finished')).toHaveLength(1);
    expect(agents.get(START.agentId)).toMatchObject({ state: 'done', finished: true, seconds: 12, tokens: 100, calls: 3 });
  });

  it('adds late usage monotonically without writing a second ending', () => {
    const { events, agents } = ledger();
    agents.start(START);
    agents.finish(START.agentId, { ...FINISH, tokens: 0 });
    agents.finalUsage(START.agentId, { tokens: 900, seconds: 15, calls: 4 });

    expect(of(events, 'agent.finished')).toHaveLength(1);
    expect(of(events, 'agent.progress').at(-1)).toMatchObject({ tokens: 900, seconds: 15, calls: 4, finalUsage: true });
    expect(agents.get(START.agentId)).toMatchObject({ state: 'done', tokens: 900, seconds: 15, calls: 4 });
  });

  it('does not let reordered cumulative progress run backwards', () => {
    const { agents } = ledger();
    agents.start(START);
    agents.progress(START.agentId, { seconds: 20, tokens: 800, calls: 5 });
    agents.progress(START.agentId, { seconds: 12, tokens: 400, calls: 3 });

    expect(agents.get(START.agentId)).toMatchObject({ seconds: 20, tokens: 800, calls: 5 });
  });

  it('keeps a provider level signal as a replace-set rather than manufacturing edges from it', () => {
    const { events, agents } = ledger();
    agents.replaceLiveSet(['child-1']);
    expect(agents.isNativelyLive('child-1')).toBe(true);
    agents.replaceLiveSet([]);
    expect(agents.isNativelyLive('child-1')).toBe(false);
    expect(events).toEqual([]);
  });
});
