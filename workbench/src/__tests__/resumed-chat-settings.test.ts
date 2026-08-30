/** @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({}));

import type { SessionSummary } from '../../../src/workbench/protocol';
import { Sessions } from '../sessions';
import { Store } from '../store';

describe('settings picked before a resumed chat wakes', () => {
  it('stores every choice without attaching an agent', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'atelier-resumed-settings-'));
    try {
      const store = new Store(join(folder, 'workbench.db'));
      const summary: SessionSummary = {
        id: 'sleeping', brand: 'codex', externalId: 'thread', projectId: 'p', projectPath: '/p', cwd: '/p',
        model: 'old-model', permissionMode: 'on-request', effort: 'low', collaborationMode: 'default',
        title: 'Sleeping chat', state: 'dormant',
        createdAt: '2026-08-30T00:00:00.000Z', lastActiveAt: '2026-08-30T00:00:00.000Z',
      };
      store.createSession({ ...summary, origin: 'app' });
      const sessions = new Sessions(store);

      await sessions.pin('sleeping', { mode: 'never', model: 'new-model', effort: 'high', collaborationMode: 'plan' });

      expect(store.getSession('sleeping')).toMatchObject({
        state: 'dormant', permissionMode: 'never', model: 'new-model', effort: 'high', collaborationMode: 'plan',
      });
      store.close();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
