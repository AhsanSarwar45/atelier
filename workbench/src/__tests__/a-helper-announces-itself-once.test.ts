/**
 * @vitest-environment node
 *
 * A helper is one lifecycle, even when Claude announces the level snapshot
 * before the start edge that carries its dispatching call (bw-n856.2).
 */
import { describe, expect, it } from 'vitest';

import type { WbpEvent } from '../../../src/workbench/protocol.ts';
import { ClaudeDriver } from '../drivers/claude.ts';

function eventsOf(messages: Record<string, unknown>[]): WbpEvent[] {
  const events: WbpEvent[] = [];
  const driver = new ClaudeDriver();
  (driver as unknown as { emit: (event: Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>) => void }).emit = (event) =>
    events.push({ ...event, seq: events.length, sessionId: 's1', at: '2026-08-28T05:00:00.000Z' } as WbpEvent);
  for (const message of messages) driver.draw(message);
  return events;
}

describe('one helper announced through two Claude message shapes', () => {
  it('writes one start edge, carrying the call that can identify and control it', () => {
    const messages = [
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'a7960d4dd5e6e1706', task_type: 'local_agent', description: 'Fix the type errors' }],
      },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'a7960d4dd5e6e1706',
        tool_use_id: 'toolu_01RealDispatchCall',
        description: 'Fix the type errors',
        subagent_type: 'general-purpose',
        task_type: 'local_agent',
      },
    ];

    const started = eventsOf(messages).filter((event) => event.type === 'agent.started');

    expect(started).toEqual([
      expect.objectContaining({
        type: 'agent.started',
        agentId: 'a7960d4dd5e6e1706',
        toolCallId: 'toolu_01RealDispatchCall',
      }),
    ]);
  });
});
