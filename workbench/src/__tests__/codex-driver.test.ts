/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({}));

import type { WbpEvent } from '../../../src/workbench/protocol';
import { CodexDriver } from '../drivers/codex';
import { createDriver, defaultPermissionMode } from '../drivers';

type BareEvent = Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>;

describe('the provider boundary', () => {
  it('selects Codex without leaking that choice through the session runtime', () => {
    expect(createDriver('codex')).toBeInstanceOf(CodexDriver);
    expect(defaultPermissionMode('codex')).toBe('on-request');
  });

  it('offers only the subagent control Codex can honestly perform', () => {
    expect(new CodexDriver().agentControls()).toEqual(['say']);
  });
});

describe('Codex subagents on the common workbench protocol', () => {
  it('draws a native spawned agent and its result as one agent row', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);

    driver.itemStarted({
      id: 'call-1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'inProgress',
      prompt: 'Inspect the session registry', model: 'gpt-5.6-luna',
      receiverThreadIds: ['agent-1'], agentsStates: { 'agent-1': { status: 'running' } },
    });
    driver.itemCompleted({
      id: 'call-1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed',
      receiverThreadIds: ['agent-1'],
      agentsStates: { 'agent-1': { status: 'completed', message: 'Registry checked.' } },
    });

    expect(events[0]).toMatchObject({
      type: 'agent.started', agentId: 'agent-1', toolCallId: 'call-1',
      what: 'Inspect the session registry', model: 'gpt-5.6-luna',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'agent.finished', agentId: 'agent-1', state: 'done', result: 'Registry checked.',
    });
  });
});
