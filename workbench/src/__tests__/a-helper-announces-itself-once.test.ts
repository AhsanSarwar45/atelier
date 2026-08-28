/**
 * @vitest-environment node
 *
 * A helper is one lifecycle, even when Claude announces the level snapshot
 * before the start edge that carries its dispatching call (bw-n856.2).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({}));

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

  it('keeps a helper started by another helper as a first-class nested conversation', () => {
    const events = eventsOf([
      {
        type: 'system', subtype: 'task_started', task_id: 'outer-agent',
        tool_use_id: 'outer-spawn', description: 'Coordinate the inspection',
        subagent_type: 'lead', task_type: 'local_agent',
      },
      {
        type: 'assistant', parent_tool_use_id: 'outer-spawn', uuid: 'outer-message',
        message: {
          id: 'outer-message', model: 'claude-sonnet', content: [{
            type: 'tool_use', id: 'nested-spawn', name: 'Task',
            input: { description: 'Inspect the parser', subagent_type: 'researcher' },
          }],
        },
      },
      {
        type: 'system', subtype: 'task_started', task_id: 'nested-agent',
        tool_use_id: 'nested-spawn', description: 'Inspect the parser',
        subagent_type: 'researcher', task_type: 'local_agent', owned_by_subagent: true,
      },
      {
        type: 'system', subtype: 'task_notification', task_id: 'nested-agent',
        status: 'completed', summary: 'Parser inspected.',
        usage: { duration_ms: 2_000, total_tokens: 100, tool_uses: 1 },
      },
    ]);

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.started', toolCallId: 'nested-spawn', parentToolCallId: 'outer-spawn',
      execution: expect.objectContaining({ actorId: 'outer-agent', conversationId: 'outer-agent' }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'agent.started', agentId: 'nested-agent',
      execution: expect.objectContaining({
        conversationId: 'nested-agent', actorId: 'nested-agent', parentActorId: 'outer-agent',
        operationId: 'nested-spawn', parentOperationId: 'outer-spawn',
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'agent.finished', agentId: 'nested-agent', state: 'done',
      execution: expect.objectContaining({ parentActorId: 'outer-agent' }),
    }));
    expect(events.filter((event) => event.type === 'note' && event.kind.startsWith('system/task'))).toHaveLength(0);
  });
});
