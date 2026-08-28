/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({}));

import type { WbpEvent } from '../../../src/workbench/protocol';
import { ClaudeDriver } from '../drivers/claude';
import { CodexDriver } from '../drivers/codex';

type BareEvent = Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>;

describe('provider-native proposed plans', () => {
  it('turns a Codex proposed_plan envelope into a separate shared plan event', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);

    driver.itemCompleted({
      id: 'answer-1', type: 'agentMessage',
      text: 'A preface\n\n<proposed_plan>\n# The plan\n\n1. Build it\n</proposed_plan>',
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'plan.proposed', proposalId: 'answer-1:plan:0', markdown: '# The plan\n\n1. Build it',
      actions: expect.arrayContaining([expect.objectContaining({ id: 'implement' }), expect.objectContaining({ id: 'request_changes' })]),
    }));
  });

  it('turns a Codex native plan item into the same shared plan event', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);

    driver.itemStarted({ id: 'plan-1', type: 'plan', text: '# The native plan' });
    driver.itemCompleted({ id: 'plan-1', type: 'plan', text: '# The native plan' });
    driver.itemCompleted({ id: 'plan-1', type: 'plan', text: '# The native plan' });

    expect(events.filter((event) => event.type === 'plan.proposed')).toEqual([
      expect.objectContaining({
        type: 'plan.proposed', proposalId: 'plan-1:plan:0', markdown: '# The native plan',
        actions: expect.arrayContaining([expect.objectContaining({ id: 'implement' }), expect.objectContaining({ id: 'request_changes' })]),
      }),
    ]);
  });

  it('answers Claude ExitPlanMode through its native permission promise without a generic permission event', async () => {
    const events: BareEvent[] = [];
    const driver = new ClaudeDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);

    const native = driver.onPermissionRequest('ExitPlanMode', { plan: '# Ship it' }, {});
    const proposed = events.find((event) => event.type === 'plan.proposed') as
      | { type: 'plan.proposed'; proposalId: string; markdown: string }
      | undefined;
    expect(proposed).toEqual(expect.objectContaining({ markdown: '# Ship it' }));
    expect(events.some((event) => event.type === 'ask.permission')).toBe(false);

    await driver.respondToPlan(proposed!.proposalId, { actionId: 'approve' });
    await expect(native).resolves.toEqual({ behavior: 'allow', updatedInput: { plan: '# Ship it' } });
    expect(events).toContainEqual(expect.objectContaining({ type: 'plan.resolved', status: 'approved' }));
  });
});
