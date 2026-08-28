/**
 * @vitest-environment node
 *
 * A helper left running in the background still comes home (bw-n856.1).
 *
 * Claude's SDK publishes task_notification as the lifecycle edge. Synthetic
 * prose in a user turn is transcript content, not a second protocol.
 */
import { describe, expect, it } from 'vitest';

import type { WbpEvent } from '../../../src/workbench/protocol.ts';
import { ClaudeDriver } from '../drivers/claude.ts';

const STARTED = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'a4430e4bc8ebb1844',
  tool_use_id: 'toolu_01SentItOff',
  description: 'Trace the stuck chat',
  subagent_type: 'scout',
  task_type: 'local_agent',
};

const CAME_HOME = {
  type: 'system',
  subtype: 'task_notification',
  task_id: 'a4430e4bc8ebb1844',
  tool_use_id: 'toolu_01SentItOff',
  status: 'completed',
  summary: 'Found the broken lifecycle edge.',
  output_file: '/tmp/claude/task-output',
  usage: {
    total_tokens: 12000,
    tool_uses: 3,
    duration_ms: 45000,
  },
};

function eventsOf(messages: Record<string, unknown>[]): WbpEvent[] {
  const events: WbpEvent[] = [];
  const driver = new ClaudeDriver();
  (driver as unknown as { emit: (event: Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>) => void }).emit = (event) =>
    events.push({ ...event, seq: events.length, sessionId: 's1', at: '2026-08-28T05:00:00.000Z' } as WbpEvent);
  for (const message of messages) driver.draw(message);
  return events;
}

describe('a helper sent to the background', () => {
  it('writes its finished line when the completion notification comes back', () => {
    const finished = eventsOf([STARTED, CAME_HOME]).filter((event) => event.type === 'agent.finished');

    expect(finished).toEqual([
      expect.objectContaining({
        type: 'agent.finished',
        agentId: 'a4430e4bc8ebb1844',
        state: 'done',
        result: 'Found the broken lifecycle edge.',
        seconds: 45,
        tokens: 12000,
        calls: 3,
      }),
    ]);
  });
});
