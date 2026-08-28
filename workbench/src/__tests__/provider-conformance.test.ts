/** @vitest-environment node */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Brand, WbpEvent } from '../../../src/workbench/protocol.ts';
import { IMPORT_RECIPE } from '../../../src/workbench/imported-history.ts';
import { completeHistoryChoice } from '../provider-reconciliation.ts';
import { Store } from '../store.ts';

function append(store: Store, sessionId: string, seq: number, event: object): void {
  store.appendEvent({
    ...event,
    sessionId,
    seq,
    at: new Date(seq * 1_000).toISOString(),
  } as WbpEvent);
}

describe('provider history conformance', () => {
  for (const provider of ['claude', 'codex'] as const satisfies readonly Brand[]) {
    it(`${provider} cannot append a complete replay below locally-driven command and helper rows`, () => {
      const store = new Store(join(mkdtempSync(join(tmpdir(), `${provider}-history-`)), 'workbench.db'));
      const sessionId = `${provider}-chat`;
      append(store, sessionId, 1, {
        type: 'session.started', brand: provider, externalId: `${provider}-thread`,
        model: null, cwd: '/work', permissionMode: 'on-request',
      });
      append(store, sessionId, 2, {
        type: 'tool.started', toolCallId: 'command', name: 'Bash', input: {},
        title: 'Ran a command', parentToolCallId: null,
      });
      append(store, sessionId, 3, {
        type: 'agent.started', agentId: 'helper', toolCallId: 'spawn', kind: 'helper',
        what: 'Inspect it', agentType: 'researcher', model: null,
      });

      expect(store.messageCount(sessionId)).toBe(0);
      expect(store.timelineCount(sessionId)).toBe(2);
      expect(completeHistoryChoice(store, sessionId, null, false)).toBe('keep-what-it-has');
      store.close();
    });

    it(`${provider} seeds an actually empty external chat and leaves current history alone`, () => {
      const store = new Store(join(mkdtempSync(join(tmpdir(), `${provider}-seed-`)), 'workbench.db'));
      expect(completeHistoryChoice(store, `${provider}-external`, null, false)).toBe('read-it');
      expect(completeHistoryChoice(store, `${provider}-external`, IMPORT_RECIPE, false)).toBe('leave-it');
      store.close();
    });

    it(`${provider} rebuilds a replaced external record but preserves locally-driven history`, () => {
      const store = new Store(join(mkdtempSync(join(tmpdir(), `${provider}-generation-`)), 'workbench.db'));
      const external = `${provider}-external`;
      expect(completeHistoryChoice(store, external, IMPORT_RECIPE, false, true)).toBe('read-it');

      const local = `${provider}-local`;
      append(store, local, 1, {
        type: 'session.started', brand: provider, externalId: `${provider}-thread`,
        model: null, cwd: '/work', permissionMode: 'on-request',
      });
      append(store, local, 2, {
        type: 'message.started', messageId: 'local-turn', role: 'assistant',
      });
      expect(completeHistoryChoice(store, local, IMPORT_RECIPE, false, true)).toBe('keep-what-it-has');
      store.close();
    });
  }
});
