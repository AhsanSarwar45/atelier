/** @vitest-environment node */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import type { WbpEvent } from '../../../src/workbench/protocol.ts';
import type { DriverEvent } from '../drivers/types.ts';
import { Store } from '../store.ts';

function append(store: Store, seq: number, body: DriverEvent): void {
  store.appendEvent({
    ...body,
    seq,
    sessionId: 'chat',
    at: new Date(seq * 1000).toISOString(),
  } as WbpEvent);
}

describe('durable transcript items', () => {
  it('stores a streamed message and a progressing tool as two complete stable items', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'atelier-items-')), 'workbench.db');
    let store = new Store(path);
    append(store, 1, { type: 'message.started', messageId: 'answer', role: 'assistant' });
    for (let seq = 2; seq < 1_002; seq++) {
      append(store, seq, { type: 'text.delta', messageId: 'answer', text: 'x' });
    }
    append(store, 1_002, { type: 'message.completed', messageId: 'answer' });
    append(store, 1_003, {
      type: 'tool.started', toolCallId: 'command', name: 'Bash', title: 'Run checks',
      input: { command: 'npm test' }, parentToolCallId: null,
    });
    for (let seq = 1_004; seq < 2_004; seq++) {
      append(store, seq, { type: 'tool.progress', toolCallId: 'command', seconds: seq - 1_003 });
    }
    append(store, 2_004, { type: 'tool.completed', toolCallId: 'command', ok: true, output: 'passed' });

    expect(store.transcriptItems('chat', null).items).toMatchObject([
      { kind: 'message', id: 'answer', text: 'x'.repeat(1_000), done: true },
      { kind: 'tool', id: 'command', status: 'ok', seconds: 1_000, output: 'passed' },
    ]);
    store.close();

    store = new Store(path);
    expect(store.transcriptItems('chat', null).items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'message:answer', 'tool:command',
    ]);
    store.close();
  });

  it('resets and retracts projected items exactly as replay does', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'atelier-item-reset-')), 'workbench.db'));
    append(store, 1, { type: 'message.started', messageId: 'old', role: 'user' });
    append(store, 2, { type: 'text.delta', messageId: 'old', text: 'old words' });
    append(store, 3, { type: 'transcript.reset' });
    append(store, 4, { type: 'message.started', messageId: 'retracted', role: 'user' });
    append(store, 5, { type: 'message.retracted', messageId: 'retracted' });
    append(store, 6, { type: 'notice', text: 'new history' });

    expect(store.transcriptItems('chat', null).items).toMatchObject([
      { kind: 'notice', text: 'new history' },
    ]);
    store.close();
  });

  it('advances from the unseen tail without rereading already projected events', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'atelier-item-tail-')), 'workbench.db');
    const store = new Store(path);
    append(store, 1, { type: 'message.started', messageId: 'prompt', role: 'user' });
    append(store, 2, { type: 'text.delta', messageId: 'prompt', text: 'before projection' });
    expect(store.transcriptItems('chat', null).items).toHaveLength(1);

    // The durable item is now sufficient for every future page. Poisoning an
    // old source row makes an accidental full rebuild observable without
    // depending on timing or an implementation-only counter.
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE event SET json = 'not json' WHERE session_id = 'chat' AND seq = 2").run();
    raw.close();

    append(store, 3, { type: 'message.completed', messageId: 'prompt' });
    append(store, 4, {
      type: 'tool.started', toolCallId: 'delegate', name: 'Agent', title: 'Send helper',
      input: { task: 'review' }, parentToolCallId: null,
    });
    append(store, 5, {
      type: 'agent.started', agentId: 'helper', toolCallId: 'delegate', kind: 'helper',
      what: 'review', agentType: null, model: null,
    });
    append(store, 6, { type: 'agent.identified', agentId: 'helper', agentType: 'reviewer' });
    append(store, 7, {
      type: 'question.requested', requestId: 'question', blocking: true,
      questions: [{
        id: 'choice', header: 'Choice', prompt: 'Continue?', selection: 'single',
        options: [], allowCustom: true, secret: false,
      }], parentToolCallId: 'delegate',
    });
    append(store, 8, {
      type: 'question.resolved', requestId: 'question',
      answers: [{ questionId: 'choice', optionIds: [], customText: 'yes' }],
    });
    append(store, 9, {
      type: 'plan.proposed', proposalId: 'first', markdown: 'First', actions: [],
    });
    append(store, 10, {
      type: 'plan.proposed', proposalId: 'second', markdown: 'Second', actions: [],
    });
    append(store, 11, {
      type: 'agent.finished', agentId: 'helper', state: 'done', result: 'reviewed',
      seconds: 2, tokens: 3, calls: 1, model: null,
    });

    expect(store.transcriptItems('chat', null).items).toMatchObject([
      { kind: 'message', id: 'prompt', text: 'before projection', done: true },
      { kind: 'tool', id: 'delegate', title: 'reviewer finished', status: 'ok' },
      {
        kind: 'question', id: 'question',
        answers: [{ questionId: 'choice', optionIds: [], customText: 'yes' }], askedBy: 'review',
      },
      { kind: 'plan', id: 'first', status: 'superseded' },
      { kind: 'plan', id: 'second', status: 'proposed' },
    ]);
    store.close();
  });
});
