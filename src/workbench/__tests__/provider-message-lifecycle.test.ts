import { describe, expect, it } from 'vitest';
import { foldAll } from '@/workbench/fold';
import { drawnRows } from '@/workbench/machine-lines';
import { providerMessageIsCurrent, type ProviderMessageSignal } from '@/workbench/provider-messages';
import type { WbpEvent } from '@/workbench/protocol';

const signal = (phase: 'active' | 'resolved', extra: Partial<ProviderMessageSignal> = {}): ProviderMessageSignal => ({
  id: 'usage:session', kind: 'usage_limit', phase, severity: 'blocking', scope: 'session', ...extra,
});
const event = (seq: number, value: ProviderMessageSignal): WbpEvent => ({
  type: 'provider.message', signal: value, seq, sessionId: 'chat', at: `2026-08-30T08:00:0${seq}Z`,
});

describe('provider message lifecycle', () => {
  it('replaces a condition by stable identity and removes it on recovery', () => {
    const view = foldAll([
      event(1, signal('active', { detail: 'first observation' })),
      event(2, signal('active', { detail: 'new observation' })),
      event(3, signal('resolved')),
    ]);
    expect(view.items.filter((item) => item.kind === 'provider_message')).toEqual([]);
  });

  it('removes answer-shaped provider prose without deleting ordinary transcript content', () => {
    const view = foldAll([
      { type: 'message.started', messageId: 'ordinary', role: 'assistant', seq: 1, sessionId: 'chat', at: '2026-08-30T08:00:01Z' },
      { type: 'text.delta', messageId: 'ordinary', text: 'Your files are ready.', seq: 2, sessionId: 'chat', at: '2026-08-30T08:00:02Z' },
      { type: 'message.completed', messageId: 'ordinary', seq: 3, sessionId: 'chat', at: '2026-08-30T08:00:03Z' },
      { type: 'message.started', messageId: 'vendor-error', role: 'assistant', seq: 4, sessionId: 'chat', at: '2026-08-30T08:00:04Z' },
      { type: 'text.delta', messageId: 'vendor-error', text: "You've hit your limit", seq: 5, sessionId: 'chat', at: '2026-08-30T08:00:05Z' },
      event(6, signal('active', { sourceMessageId: 'vendor-error' })),
    ]);
    expect(view.items).toMatchObject([{ kind: 'message', id: 'ordinary' }, { kind: 'provider_message', id: 'usage:session' }]);
  });

  it('expires a timed condition and keeps untimed durable conditions', () => {
    expect(providerMessageIsCurrent(signal('active', { retryAt: '2026-08-30T08:00:00Z' }), Date.parse('2026-08-30T08:00:01Z'))).toBe(false);
    expect(providerMessageIsCurrent(signal('active', { retryAt: null }), Date.parse('2036-08-30T08:00:01Z'))).toBe(true);
    expect(drawnRows(foldAll([event(1, signal('resolved'))]).items)).toEqual([]);
  });

  it('clears a generic transient error when the session recovers', () => {
    const view = foldAll([
      { type: 'error', message: 'A temporary provider error', fatal: false, seq: 1, sessionId: 'chat', at: '2026-08-30T08:00:01Z' },
      { type: 'session.state', state: 'idle', label: 'Ready', seq: 2, sessionId: 'chat', at: '2026-08-30T08:00:02Z' },
    ]);
    expect(view.error).toBeNull();
  });
});
