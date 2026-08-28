/** @vitest-environment node */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import type { WbpEvent } from '../../../src/workbench/protocol.ts';
import { Store } from '../store.ts';

describe('provider identity schema upgrades', () => {
  it('repairs a current-version database whose event table lacks the named capability', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'provider-schema-upgrade-')), 'workbench.db');
    const source: WbpEvent = {
      type: 'text.delta',
      sessionId: 'existing-chat',
      seq: 1,
      at: '2026-08-28T00:00:00.000Z',
      messageId: 'existing-answer',
      text: 'kept exactly',
    };
    const fixture = new DatabaseSync(path);
    fixture.exec(`
      CREATE TABLE schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (10);
      CREATE TABLE event (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX event_by_session ON event(session_id, seq);
    `);
    fixture.prepare('INSERT INTO event VALUES (?, ?, ?, ?, ?)').run(
      source.sessionId, source.seq, source.at, source.type, JSON.stringify(source),
    );
    fixture.close();

    const store = new Store(path);
    expect(store.eventsSince('existing-chat', 0)).toEqual([source]);

    const delivered: WbpEvent = {
      ...source,
      sessionId: 'new-chat',
      messageId: 'new-answer',
      providerEvent: {
        provider: 'codex',
        threadId: 'native-thread',
        eventId: 'message:new-answer:text:0',
        delivery: 'live',
      },
    };
    expect(store.appendEvent(delivered)).toBe(true);
    expect(store.appendEvent({
      ...delivered,
      seq: 2,
      providerEvent: { ...delivered.providerEvent!, delivery: 'replay' },
    })).toBe(false);
    store.close();

    const inspected = new DatabaseSync(path, { readOnly: true });
    expect(
      (inspected.prepare('PRAGMA table_info(event)').all() as Array<{ name: string }>).map((row) => row.name),
    ).toEqual(expect.arrayContaining(['provider', 'provider_thread_id', 'provider_event_id']));
    expect(inspected.prepare('SELECT json FROM event WHERE session_id = ?').get('existing-chat')).toEqual({
      json: JSON.stringify(source),
    });
    expect(inspected.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'event_by_provider_identity'",
    ).get()).toEqual({ name: 'event_by_provider_identity' });
    inspected.close();
  });
});
