/** @vitest-environment node */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Brand, ProviderEventIdentity, WbpEvent } from '../../../src/workbench/protocol.ts';
import { Store } from '../store.ts';

function identity(
  provider: Brand,
  eventId: string,
  delivery: ProviderEventIdentity['delivery'],
): ProviderEventIdentity {
  return { provider, threadId: `${provider}-thread`, eventId, delivery };
}

function event(
  seq: number,
  providerEvent: ProviderEventIdentity,
  text = 'the same logical answer',
): WbpEvent {
  return {
    seq,
    sessionId: `${providerEvent.provider}-chat`,
    at: new Date(seq * 1_000).toISOString(),
    providerEvent,
    type: 'text.delta',
    messageId: 'answer',
    text,
  };
}

describe('durable provider event identity', () => {
  for (const provider of ['claude', 'codex'] as const) {
    it(`stores overlapping live and replayed ${provider} history once across a restart`, () => {
      const path = join(mkdtempSync(join(tmpdir(), `${provider}-identity-`)), 'workbench.db');
      let store = new Store(path);

      expect(store.appendEvent(event(1, identity(provider, 'message:answer:text:0', 'live')))).toBe(true);
      expect(store.appendEvent(event(2, identity(provider, 'message:answer:text:0', 'replay')))).toBe(false);
      expect(store.appendEvent(event(2, identity(provider, 'message:answer:completed', 'replay'), ''))).toBe(true);
      expect(store.eventsSince(`${provider}-chat`, 0)).toHaveLength(2);
      store.close();

      store = new Store(path);
      expect(store.appendEvent(event(3, identity(provider, 'message:answer:text:0', 'snapshot')))).toBe(false);
      expect(store.appendEvent(event(3, identity(provider, 'message:answer:completed', 'snapshot'), ''))).toBe(false);
      expect(store.eventsSince(`${provider}-chat`, 0).map((row) => row.providerEvent?.eventId)).toEqual([
        'message:answer:text:0',
        'message:answer:completed',
      ]);
      store.close();
    });
  }

  it('keeps legacy and Atelier-owned events append-only while providers migrate', () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), 'local-event-')), 'workbench.db'));
    const first = { ...event(1, identity('codex', 'unused', 'live')), providerEvent: undefined } as WbpEvent;
    const second = { ...first, seq: 2 };

    expect(store.appendEvent(first)).toBe(true);
    expect(store.appendEvent(second)).toBe(true);
    expect(store.eventsSince('codex-chat', 0)).toHaveLength(2);
    store.close();
  });
});
