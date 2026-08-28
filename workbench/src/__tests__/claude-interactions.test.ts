/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({}));

import type { WbpEvent } from '../../../src/workbench/protocol';
import { ClaudeDriver } from '../drivers/claude';

type BareEvent = Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>;

describe('Claude native interactions', () => {
  it('preserves descriptions, previews, multi-select, custom text, and per-question notes', async () => {
    const events: BareEvent[] = [];
    const driver = new ClaudeDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);
    const input = { questions: [
      {
        header: 'Scope', question: 'What should ship?', multiSelect: true,
        options: [
          { label: 'API', description: 'Backend endpoints', preview: '```ts\n/api\n```' },
          { label: 'UI', description: 'Browser interface' },
        ],
      },
      { header: 'Region', question: 'Where?', multiSelect: false, options: [{ label: 'EU', description: 'Europe' }] },
    ] };

    const native = driver.onPermissionRequest('AskUserQuestion', input, {});
    const requested = events.find((event: any) => event.type === 'question.requested') as any;
    expect(requested).toMatchObject({
      blocking: true,
      questions: [
        {
          id: 'question:0', selection: 'multiple', allowCustom: true,
          options: [
            { id: 'question:0:option:0', label: 'API', description: 'Backend endpoints', preview: '```ts\n/api\n```' },
            { id: 'question:0:option:1', label: 'UI', description: 'Browser interface' },
          ],
        },
        { id: 'question:1', selection: 'single' },
      ],
    });
    expect(events.some((event: any) => event.type === 'ask.permission')).toBe(false);

    driver.answerQuestions(requested.requestId, { answers: [
      { questionId: 'question:0', optionIds: ['question:0:option:0', 'question:0:option:1'], customText: 'Docs', note: 'Keep it small' },
      { questionId: 'question:1', optionIds: ['question:1:option:0'] },
    ] });

    await expect(native).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: { 'What should ship?': 'API, UI, Docs', 'Where?': 'EU' },
        annotations: { 'What should ship?': { notes: 'Keep it small', preview: '```ts\n/api\n```' } },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'question.resolved', requestId: requested.requestId }));
  });

  it('keeps ExitPlanMode on the shared plan path instead of generic permission UI', async () => {
    const events: BareEvent[] = [];
    const driver = new ClaudeDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);
    const native = driver.onPermissionRequest('ExitPlanMode', { plan: '# Plan' }, {});
    const proposed = events.find((event: any) => event.type === 'plan.proposed') as any;
    expect(events.some((event: any) => event.type === 'ask.permission')).toBe(false);
    await driver.respondToPlan(proposed.proposalId, { actionId: 'approve' });
    await expect(native).resolves.toMatchObject({ behavior: 'allow' });
  });
});
