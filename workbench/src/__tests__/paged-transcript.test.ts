/** @vitest-environment node */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { WbpEvent } from '../../../src/workbench/protocol.ts';
import { Store } from '../store.ts';
import { transcriptPage } from '../transcript-page.ts';

function event(store: Store, seq: number, body: Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>): void {
  store.appendEvent({
    ...body,
    seq,
    sessionId: 'chat',
    at: new Date(seq * 1000).toISOString(),
  } as WbpEvent);
}

describe('paged transcript storage', () => {
  it('reads only the newest row window and pages backward without replaying the log', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'atelier-page-')), 'workbench.db'));
    let seq = 0;
    for (let i = 0; i < 75; i++) {
      event(store, ++seq, { type: 'message.started', messageId: `m-${i}`, role: 'assistant' });
      event(store, ++seq, { type: 'text.delta', messageId: `m-${i}`, text: `answer ${i}` });
      event(store, ++seq, { type: 'message.completed', messageId: `m-${i}` });
    }

    const newest = store.transcriptWindow('chat', null, 40);
    expect(newest.events).toHaveLength(120);
    expect(newest.events[0]).toMatchObject({ type: 'message.started', messageId: 'm-35' });
    expect(newest.hasOlder).toBe(true);

    const older = store.transcriptWindow('chat', newest.cursor, 40);
    expect(older.events[0]).toMatchObject({ type: 'message.started', messageId: 'm-0' });
    expect(older.hasOlder).toBe(false);
  });

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
    expect(messages).toHaveLength(40);
    expect(messages[0]).toMatchObject({ id: 'm-1', role: 'assistant' });
    expect(messages.filter((item) => item.role === 'user')).toHaveLength(20);
    expect(newest.items.filter((item) => item.kind === 'thinking')).toHaveLength(40);
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
