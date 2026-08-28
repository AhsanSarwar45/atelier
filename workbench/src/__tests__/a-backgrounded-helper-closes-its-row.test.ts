/**
 * @vitest-environment node
 *
 * A helper left running in the background still comes home (bw-n856.1).
 *
 * Claude delivers that edge as a task-notification synthetic user turn, not
 * as the foreground task_notification system message the driver already
 * understands. This is the shape recorded in session 717fb41d on 2026-08-28.
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
  type: 'user',
  origin: { kind: 'task-notification' },
  message: {
    role: 'user',
    content: `<task-notification>
<task-id>a4430e4bc8ebb1844</task-id>
<tool-use-id>toolu_01SentItOff</tool-use-id>
<status>completed</status>
<summary>Agent "Trace the stuck chat" finished</summary>
<result>Found the broken lifecycle edge.</result>
<usage><subagent_tokens>12000</subagent_tokens><tool_uses>3</tool_uses><duration_ms>45000</duration_ms></usage>
</task-notification>`,
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
