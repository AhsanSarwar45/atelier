import { describe, expect, it } from 'vitest';
import { EMPTY, foldAll, reduce } from '@/workbench/fold';
import type { WbpEvent } from '@/workbench/protocol';

const started = (seq: number, brand: string) =>
  ({ type: 'session.started', sessionId: 's', seq, at: 'now', brand, externalId: null, model: null, cwd: '/p', permissionMode: 'default' }) as unknown as WbpEvent;
const menu = (seq: number) =>
  ({ type: 'session.menu', sessionId: 's', seq, at: 'now', models: [{ id: 'opus', label: 'Opus' }] }) as unknown as WbpEvent;

describe('a chat switched to another provider', () => {
  const events = [started(1, 'claude'), menu(2), started(3, 'codex')];

  it('stops offering the old provider’s models, live and on reload', () => {
    const live = events.reduce(reduce, EMPTY);
    expect(live.brand).toBe('codex');
    expect(live.menu.models).toEqual([]);
    expect(foldAll(events).menu.models).toEqual([]);
  });

  it('keeps the menu when the same provider starts again', () => {
    const again = [started(1, 'claude'), menu(2), started(3, 'claude')];
    expect(again.reduce(reduce, EMPTY).menu.models).toHaveLength(1);
    expect(foldAll(again).menu.models).toHaveLength(1);
  });
});
