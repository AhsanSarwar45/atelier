/**
 * @vitest-environment node
 *
 * Opening a chat another program is driving, twice.
 *
 * Such a chat is never finished being read — the other program is still
 * writing to its record — so it fell through every "already read" test and was
 * read from its first byte on every single click: the whole record parsed, the
 * drawing thrown away, the conversation published again. On the manager's own
 * machine that is several seconds, every click, on exactly the chats he watches
 * most (bw-uiyz.19).
 *
 * Its follower already stops at a byte. That byte is remembered, and a second
 * open carries on from it — so the rule that decides is here, and the store
 * that keeps the byte is checked below it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '@/workbench/protocol';

import { Store } from '../../../workbench/src/store';
import { carryOnAt, IMPORT_RECIPE } from '../imported-history';

describe('where a second open of a live chat starts', () => {
  it('carries on from where its follower left off', () => {
    const left = { at: 4_096, drawn: 0 };
    expect(carryOnAt({ readBy: IMPORT_RECIPE, followedTo: left, recordNow: 8_192 })).toEqual(left);
  });

  it('carries on even when nothing has arrived since', () => {
    const left = { at: 4_096, drawn: 0 };
    expect(carryOnAt({ readBy: IMPORT_RECIPE, followedTo: left, recordNow: 4_096 })).toEqual(left);
  });

  it('carries the rows already drawn from that byte, so a busy chat says none of them twice', () => {
    const left = { at: 4_096, drawn: 3 };
    expect(carryOnAt({ readBy: IMPORT_RECIPE, followedTo: left, recordNow: 9_000 })).toEqual(left);
  });

  it('reads the whole record the first time, when no follower has left a mark', () => {
    expect(carryOnAt({ readBy: IMPORT_RECIPE, followedTo: null, recordNow: 8_192 })).toBeNull();
  });

  it('reads the whole record when what is drawn came from an older reading', () => {
    const left = { at: 4_096, drawn: 0 };
    expect(carryOnAt({ readBy: IMPORT_RECIPE - 1, followedTo: left, recordNow: 8_192 })).toBeNull();
    expect(carryOnAt({ readBy: null, followedTo: left, recordNow: 8_192 })).toBeNull();
  });

  it('reads the whole record again when it has been compacted shorter than that byte', () => {
    expect(carryOnAt({ readBy: IMPORT_RECIPE, followedTo: { at: 8_192, drawn: 0 }, recordNow: 900 })).toBeNull();
  });

  it('reads the whole record when there is no record on this machine to measure', () => {
    expect(carryOnAt({ readBy: IMPORT_RECIPE, followedTo: { at: 8_192, drawn: 0 }, recordNow: null })).toBeNull();
  });
});

const CHAT: SessionSummary & { origin: string } = {
  id: 'chat-live',
  brand: 'claude',
  externalId: 'outside-live',
  projectId: 'p',
  projectPath: '/tmp/p',
  cwd: '/tmp/p',
  model: null,
  permissionMode: 'default',
  title: null,
  state: 'dormant',
  createdAt: '2026-08-20T00:00:00.000Z',
  lastActiveAt: '2026-08-20T00:00:00.000Z',
  origin: 'terminal',
};

function aStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), 'workbench-')), 'workbench.db'));
}

describe('the byte a chat has been read up to', () => {
  it('is nothing until a follower says so, and is that byte afterwards', () => {
    const store = aStore();
    store.createSession(CHAT);
    expect(store.followedTo(CHAT.id)).toBeNull();
    store.rememberFollowed(CHAT.id, 12_345, 2, IMPORT_RECIPE);
    expect(store.followedTo(CHAT.id)).toEqual({ at: 12_345, drawn: 2 });
  });

  it('is dropped when the whole record is read again, so no line is drawn twice', () => {
    const store = aStore();
    store.createSession(CHAT);
    store.rememberFollowed(CHAT.id, 12_345, 0, IMPORT_RECIPE);
    store.markImported(CHAT.id, IMPORT_RECIPE);
    expect(store.followedTo(CHAT.id)).toBeNull();
  });

  it('is dropped when the drawing is thrown away', () => {
    const store = aStore();
    store.createSession(CHAT);
    store.rememberFollowed(CHAT.id, 12_345, 0, IMPORT_RECIPE);
    store.forgetImported(CHAT.id);
    expect(store.followedTo(CHAT.id)).toBeNull();
  });

  it('counts as having read the record, which a chat being written never settles enough to say', () => {
    const store = aStore();
    store.createSession(CHAT);
    expect(store.importedBy(CHAT.id)).toBeNull();
    store.rememberFollowed(CHAT.id, 12_345, 2, IMPORT_RECIPE);
    expect(store.importedBy(CHAT.id)).toBe(IMPORT_RECIPE);
  });

  it('is dropped when this app takes the chat over, whose turns bypass the record', () => {
    const store = aStore();
    store.createSession(CHAT);
    store.rememberFollowed(CHAT.id, 12_345, 0, IMPORT_RECIPE);
    store.forgetFollowed(CHAT.id);
    expect(store.followedTo(CHAT.id)).toBeNull();
  });
});
