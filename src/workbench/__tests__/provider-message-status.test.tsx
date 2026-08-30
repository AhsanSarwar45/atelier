import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_MESSAGE_KINDS, providerMessageStatus, type ProviderMessageSignal } from '@/workbench/provider-messages';
import type { WatchFrame } from '@/workbench/protocol';
import { tagged } from './tagged';

let opened: FakeStream[] = [];
class FakeStream {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) { opened.push(this); }
  close() {}
  says(frame: WatchFrame) { this.onmessage?.(tagged('workbench', JSON.stringify(frame))); }
}

const signal = (phase: 'active' | 'resolved', extra: Partial<ProviderMessageSignal> = {}): ProviderMessageSignal => ({
  id: 'usage:session', kind: 'usage_limit', phase, severity: 'blocking', scope: 'session', ...extra,
});
const frame = (type: string, over: Record<string, unknown> = {}): WatchFrame => ({
  kind: 'event', event: { seq: 1, sessionId: 's1', at: '2026-08-30T08:00:00Z', type, ...over },
} as WatchFrame);
const snapshot = (): WatchFrame => ({ kind: 'snapshot', sessions: [{
  id: 's1', brand: 'codex', externalId: 'x1', projectId: 'p1', projectPath: '/p', cwd: '/p', model: null,
  permissionMode: 'default', title: 'Chat', state: 'idle', createdAt: '2026-08-30T07:00:00Z',
  lastActiveAt: '2026-08-30T08:00:00Z', lastSpokeAt: null, activity: 'Ready', beads: [],
}] } as WatchFrame);

beforeEach(() => { opened = []; vi.stubGlobal('WebSocket', FakeStream); });
afterEach(() => vi.unstubAllGlobals());

describe('provider condition in sidebar status', () => {
  it('overrides Idle, survives a later generic state packet, and restores it when resolved', async () => {
    vi.resetModules();
    const { useLiveSessions } = await import('@/workbench/live');
    const { result } = renderHook(() => useLiveSessions());
    act(() => opened[0]!.says(snapshot()));
    act(() => opened[0]!.says(frame('provider.message', { signal: signal('active') })));
    expect(result.current[0]).toMatchObject({ state: 'stopped', activity: 'Limit reached' });

    act(() => opened[0]!.says(frame('session.state', { state: 'idle', label: 'Ready' })));
    expect(result.current[0]).toMatchObject({ state: 'stopped', activity: 'Limit reached' });

    act(() => opened[0]!.says(frame('provider.message', { signal: signal('resolved') })));
    expect(result.current[0]).toMatchObject({ state: 'idle', activity: 'Ready' });
  });

  it('has compact user-facing status words for every future-provider category', () => {
    for (const kind of PROVIDER_MESSAGE_KINDS) {
      expect(providerMessageStatus(signal('active', { kind })).label).not.toMatch(/claude|codex/i);
      expect(providerMessageStatus(signal('active', { kind })).label.length).toBeGreaterThan(0);
    }
  });
});
