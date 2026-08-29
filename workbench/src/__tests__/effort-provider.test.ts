/** @vitest-environment node */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

import type { SessionSummary, WbpEvent } from '../../../src/workbench/protocol';
import { ClaudeDriver, claudeEffortMenu } from '../drivers/claude';
import { CodexDriver } from '../drivers/codex';
import { Store } from '../store';

type BareEvent = Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>;

describe('provider-neutral effort', () => {
  it('applies effort through both provider drivers and publishes the active value', async () => {
    for (const driver of [new CodexDriver(), new ClaudeDriver()]) {
      const events: BareEvent[] = [];
      (driver as any).emit = (event: BareEvent) => events.push(event);
      if (driver instanceof ClaudeDriver) {
        (driver as any).q = { applyFlagSettings: vi.fn().mockResolvedValue(undefined) };
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

  it('stores older session shapes that have no effort field', () => {
    const folder = mkdtempSync(join(tmpdir(), 'atelier-effort-legacy-'));
    try {
      const store = new Store(join(folder, 'workbench.db'));
      const summary: SessionSummary = {
        id: 'legacy', brand: 'claude', externalId: null, projectId: 'p', projectPath: '/p', cwd: '/p',
        model: null, permissionMode: 'default', title: null, state: 'idle',
        createdAt: '2026-08-26T00:00:00.000Z', lastActiveAt: '2026-08-26T00:00:00.000Z',
      };
      store.createSession({ ...summary, origin: 'imported' });
      expect(store.getSession('legacy')?.effort).toBeNull();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe('the effort levels a Claude chat offers', () => {
  const rows = [
    {
      value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus',
      supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    { value: 'haiku', displayName: 'Haiku', supportsEffort: false },
  ];

  it('offers every level the running model announces, the deepest one included', () => {
    const menu = claudeEffortMenu(rows, 'opus');

    expect(menu.map((choice) => choice.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(menu.map((choice) => choice.displayName)).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max']);
  });

  it('offers nothing for a model that states it does not think', () => {
    expect(claudeEffortMenu(rows, 'haiku')).toEqual([]);
  });

  it('offers nothing when an older kit describes its models without saying', () => {
    expect(claudeEffortMenu([{ value: 'opus', displayName: 'Opus' }], 'opus')).toEqual([]);
  });

  it('reads a chat pinned to the real model behind a short name', () => {
    expect(claudeEffortMenu(rows, 'claude-opus-5').map((choice) => choice.value))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('applies the picked level as a settings change, the only route the kit listens on', async () => {
    const driver = new ClaudeDriver() as any;
    const applyFlagSettings = vi.fn().mockResolvedValue(undefined);
    driver.q = { applyFlagSettings };
    driver.emit = () => {};

    await driver.setEffort('xhigh');

    expect(applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'xhigh' });
  });

  it('redraws the levels for the model just chosen instead of the one before it', async () => {
    const driver = new ClaudeDriver() as any;
    const events: BareEvent[] = [];
    driver.emit = (event: BareEvent) => events.push(event);
    driver.q = { setModel: vi.fn().mockResolvedValue(undefined) };
    driver.modelRows = rows;
    driver.model = 'opus';

    await driver.setModel('haiku');

    const menu = events.filter((event) => event.type === 'session.menu').at(-1) as any;
    expect(menu).toBeTruthy();
    expect(menu.efforts).toEqual([]);
  });
});
