/** @vitest-environment node */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { WbpEvent } from '../../../src/workbench/protocol.ts';
import type { DriverEvent } from '../drivers/types.ts';
import { Store } from '../store.ts';
import { transcriptPage } from '../transcript-page.ts';

// A driver's own event: every field of the one kind, rather than the handful
// every kind shares. `Omit` over a union keeps only what they all have, so a
// line saying which message it belonged to was not a line this could write.
function event(store: Store, seq: number, body: DriverEvent): void {
  store.appendEvent({
    ...body,
    seq,
    sessionId: 'chat',
    at: new Date(seq * 1000).toISOString(),
  } as WbpEvent);
}

describe('paged transcript storage', () => {
  it('keeps each selected message beside the thinking row it produced', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'atelier-speakers-')), 'workbench.db'));
    let seq = 0;
    for (let i = 0; i < 41; i++) {
      event(store, ++seq, { type: 'message.started', messageId: `m-${i}`, role: i % 2 ? 'assistant' : 'user' });
      event(store, ++seq, { type: 'text.delta', messageId: `m-${i}`, text: `message ${i}` });
      event(store, ++seq, { type: 'thinking.delta', messageId: `m-${i}`, text: `thought ${i}` });
      event(store, ++seq, { type: 'message.completed', messageId: `m-${i}` });
    }

    const newest = transcriptPage(store, 'chat', null);
    const messages = newest.items.filter((item) => item.kind === 'message');
    expect(newest.items).toHaveLength(40);
    expect(messages).toHaveLength(20);
    expect(messages[0]).toMatchObject({ id: 'm-21', role: 'assistant' });
    expect(messages.filter((item) => item.role === 'user')).toHaveLength(10);
    expect(newest.items.filter((item) => item.kind === 'thinking')).toHaveLength(20);
    expect(newest.hasOlder).toBe(true);
  });

  it('pages a tool-heavy turn in complete items and reaches its user prompt on the next page', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'atelier-turns-')), 'workbench.db'));
    let seq = 0;
    event(store, ++seq, { type: 'message.started', messageId: 'prompt', role: 'user' });
    event(store, ++seq, { type: 'text.delta', messageId: 'prompt', text: 'Please inspect the whole repository' });
    event(store, ++seq, { type: 'message.completed', messageId: 'prompt' });
    event(store, ++seq, { type: 'message.started', messageId: 'answer', role: 'assistant' });
    for (let i = 0; i < 75; i++) {
      event(store, ++seq, {
        type: 'tool.started', toolCallId: `tool-${i}`, name: 'Read', title: `Read file ${i}`,
        input: { file_path: `file-${i}.ts` }, parentToolCallId: null,
      });
      event(store, ++seq, { type: 'tool.completed', toolCallId: `tool-${i}`, ok: true, output: 'done' });
    }
    event(store, ++seq, { type: 'text.delta', messageId: 'answer', text: 'Finished' });
    event(store, ++seq, { type: 'message.completed', messageId: 'answer' });

    const newest = transcriptPage(store, 'chat', null);
    expect(newest.items).toHaveLength(40);
    expect(newest.items.every((item) => item.kind === 'tool')).toBe(true);
    expect(newest.items.find((item) => item.kind === 'message')).toBeUndefined();

    const older = transcriptPage(store, 'chat', newest.cursor);
    expect(older.items.find((item) => item.kind === 'message' && item.role === 'user')).toMatchObject({
      id: 'prompt', text: 'Please inspect the whole repository',
    });
    expect(older.hasOlder).toBe(false);
    expect(new Set([...older.items, ...newest.items].map((item) => `${item.kind}:${item.id}`)).size).toBe(77);
  });

  it('never lets one enormous turn or hidden diagnostics exceed the item limit', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'atelier-enormous-turn-')), 'workbench.db'));
    let seq = 0;
    event(store, ++seq, { type: 'message.started', messageId: 'prompt', role: 'user' });
    event(store, ++seq, { type: 'text.delta', messageId: 'prompt', text: 'Inspect everything' });
    event(store, ++seq, { type: 'message.completed', messageId: 'prompt' });
    for (let i = 0; i < 200; i++) {
      event(store, ++seq, {
        type: 'note', noteId: `hook-${i}`, rank: 'detail', kind: 'hook/completed',
        text: `hook ${i}`, body: null,
      });
      event(store, ++seq, {
        type: 'tool.started', toolCallId: `tool-${i}`, name: 'Read', title: `Read ${i}`,
        input: { file_path: `${i}.ts` }, parentToolCallId: null,
      });
      for (let progress = 0; progress < 20; progress++) {
        event(store, ++seq, { type: 'tool.progress', toolCallId: `tool-${i}`, seconds: progress });
      }
      event(store, ++seq, { type: 'tool.completed', toolCallId: `tool-${i}`, ok: true, output: 'done' });
    }

    const newest = transcriptPage(store, 'chat', null);
    expect(newest.items).toHaveLength(40);
    expect(newest.items.every((item) => item.kind === 'tool')).toBe(true);
    expect(newest.hasOlder).toBe(true);
  });

  it('fetches a large tool body only by its call id', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'atelier-tool-')), 'workbench.db'));
    event(store, 1, {
      type: 'tool.started', toolCallId: 'call', name: 'Bash', title: 'Ran the tests',
      input: { command: 'npm test', payload: 'x'.repeat(100_000) }, parentToolCallId: null,
    });
    event(store, 2, { type: 'tool.completed', toolCallId: 'call', ok: true, output: 'y'.repeat(200_000) });
    event(store, 3, { type: 'diff', toolCallId: 'call', path: 'a.ts', before: 'old', after: 'new' });

    expect(store.toolDetails('chat', 'call')).toEqual({
      input: { command: 'npm test', payload: 'x'.repeat(100_000) },
      output: 'y'.repeat(200_000),
      diff: { path: 'a.ts', before: 'old', after: 'new' },
    });
    expect(store.toolDetails('chat', 'missing')).toBeNull();
  });
});
