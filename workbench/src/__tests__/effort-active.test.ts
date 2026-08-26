/** @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({}));

import type { SessionSummary } from '../../../src/workbench/protocol';
import { codexEffortMenu, codexResolvedEffort } from '../drivers/codex';
import { Sessions } from '../sessions';
import { Store } from '../store';

describe('the active effort shown by a chat', () => {
  it('uses the active Codex model’s stated default instead of leaving effort blank', () => {
    const menu = codexEffortMenu([
      { model: 'small', supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low' },
      {
        model: 'active', isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
        defaultReasoningEffort: 'high',
      },
    ], 'active');

    expect(menu.defaultEffort).toBe('high');
    expect(menu.efforts.map((choice) => choice.value)).toEqual(['medium', 'high']);
  });

  it('fills a resumed Codex chat whose stored effort is unset', () => {
    expect(codexResolvedEffort(undefined, 'high')).toBe('high');
  });

  it('keeps the effort already stored by a resumed Codex chat', () => {
    expect(codexResolvedEffort('low', 'high')).toBe('low');
  });

  it('stores a provider-resolved default so waking the chat and its top badge keep it', () => {
    const folder = mkdtempSync(join(tmpdir(), 'atelier-active-effort-'));
    try {
      const store = new Store(join(folder, 'workbench.db'));
      const summary: SessionSummary = {
        id: 'chat', brand: 'codex', externalId: null, projectId: 'p', projectPath: '/p', cwd: '/p',
        model: 'active', permissionMode: 'on-request', effort: null, title: null, state: 'idle',
        createdAt: '2026-08-26T00:00:00.000Z', lastActiveAt: '2026-08-26T00:00:00.000Z',
      };
      store.createSession({ ...summary, origin: 'app' });
      const sessions = new Sessions(store);

      (sessions as any).publish('chat', {
        type: 'session.pinned', permissionMode: null, model: null, effort: 'high',
      });

      expect(store.getSession('chat')?.effort).toBe('high');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
