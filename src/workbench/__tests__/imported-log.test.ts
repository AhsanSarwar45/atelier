/**
 * @vitest-environment node
 *
 * The sidecar's own store, opened for real: it is built on `node:sqlite`, which
 * a browser-shaped test environment cannot load.
 *
 * What survives a chat being read again.
 *
 * A chat imported by an older reading of the record is re-read to gain its
 * commands. The first attempt threw the drawn history away FIRST and read the
 * record second, so a record that had been moved, pruned, or belonged to a
 * worktree that no longer exists left the chat permanently blank — having
 * destroyed the only copy the app had (bw-1u1.26). And emptying the log restarts
 * the numbering the browser resumes from, which strands a reader mid-chat
 * (bw-1u1.27).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SessionSummary, WbpEvent } from '@/workbench/protocol';

import { Store } from '../../../workbench/src/store';

function aStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'workbench-')), 'workbench.db'));
}

const CHAT: SessionSummary & { origin: string } = {
  id: 'chat-1',
  brand: 'claude',
  externalId: 'outside-1',
  projectId: 'p',
  projectPath: '/tmp/p',
  cwd: '/tmp/p',
  model: null,
  permissionMode: 'default',
  title: null,
  state: 'dormant',
  createdAt: '2026-08-17T00:00:00.000Z',
  lastActiveAt: '2026-08-17T00:00:00.000Z',
  origin: 'terminal',
};

/** One drawn message, as the import writes it. */
function drawnInto(store: Store, seq: number, messageId: string, text: string): void {
  const started = { type: 'message.started', messageId, role: 'assistant', sessionId: CHAT.id, seq, at: CHAT.createdAt };
  store.appendEvent(started as unknown as WbpEvent);
  store.openMessage(CHAT.id, messageId, 'assistant', CHAT.createdAt);
  const delta = { type: 'text.delta', messageId, text, sessionId: CHAT.id, seq: seq + 1, at: CHAT.createdAt };
  store.appendEvent(delta as unknown as WbpEvent);
  store.growMessage(CHAT.id, messageId, text);
}

describe('a chat read in again', () => {
  it('keeps every line it has already drawn', () => {
    const store = aStore();
    store.createSession(CHAT);
    drawnInto(store, 1, 'm1', 'what it said before');

    store.forgetImported(CHAT.id);

    expect(store.eventsSince(CHAT.id, 0)).toHaveLength(2);
  });

  it('goes on numbering where it left off, so a reader mid-chat is not stranded', () => {
    const store = aStore();
    store.createSession(CHAT);
    drawnInto(store, 1, 'm1', 'what it said before');

    store.forgetImported(CHAT.id);

    expect(store.nextSeq(CHAT.id)).toBe(3);
  });

  it('drops the searchable copy, so the replacement is not found twice', () => {
    const store = aStore();
    store.createSession(CHAT);
    drawnInto(store, 1, 'm1', 'a sentence worth finding');
    expect(store.search('worth finding')).toHaveLength(1);

    store.forgetImported(CHAT.id);

    expect(store.search('worth finding')).toHaveLength(0);
    expect(store.messageCount(CHAT.id)).toBe(0);
  });
});
