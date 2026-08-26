/** @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import type { SessionSummary, WbpEvent } from '../../../src/workbench/protocol';
import { ClaudeDriver } from '../drivers/claude';
import { CodexDriver } from '../drivers/codex';
import { Store } from '../store';

type BareEvent = Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>;

describe('provider-neutral effort', () => {
  it('applies effort through both provider drivers and publishes the active value', async () => {
    for (const driver of [new CodexDriver(), new ClaudeDriver()]) {
      const events: BareEvent[] = [];
      (driver as any).emit = (event: BareEvent) => events.push(event);
      if (driver instanceof ClaudeDriver) {
        (driver as any).q = { setEffort: vi.fn().mockResolvedValue(undefined) };
      }

      await driver.setEffort('high');

      expect(events.at(-1)).toMatchObject({
        type: 'session.pinned', permissionMode: null, model: null, effort: 'high',
      });
    }
  });

  it('sends the selected Codex effort on the next turn', async () => {
    const driver = new CodexDriver() as any;
    driver.threadId = 'thread';
    driver.emit = () => {};
    driver.call = vi.fn().mockResolvedValue({ turn: { id: 'turn' } });
    await driver.setEffort('xhigh');

    await driver.send({ text: 'Think carefully', images: [] });

    expect(driver.call).toHaveBeenCalledWith('turn/start', expect.objectContaining({ effort: 'xhigh' }));
  });

  it('persists effort with the session instead of treating it as page state', () => {
    const folder = mkdtempSync(join(tmpdir(), 'atelier-effort-'));
    try {
      const store = new Store(join(folder, 'workbench.db'));
      const summary: SessionSummary = {
        id: 'chat', brand: 'codex', externalId: null, projectId: 'p', projectPath: '/p', cwd: '/p',
        model: null, permissionMode: 'on-request', effort: 'medium', title: null, state: 'idle',
        createdAt: '2026-08-26T00:00:00.000Z', lastActiveAt: '2026-08-26T00:00:00.000Z',
      };
      store.createSession({ ...summary, origin: 'app' });
      expect(store.getSession('chat')?.effort).toBe('medium');

      store.updateSession('chat', { effort: 'high' }, false);
      expect(store.getSession('chat')?.effort).toBe('high');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
