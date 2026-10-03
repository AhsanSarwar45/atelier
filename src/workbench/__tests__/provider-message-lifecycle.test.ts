import { describe, expect, it } from 'vitest';
import { foldAll } from '@/workbench/fold';
import { drawnRows } from '@/workbench/machine-lines';
import { currentProviderMessages, type ProviderMessageSignal } from '@/workbench/provider-messages';
import type { WbpEvent } from '@/workbench/protocol';

const signal = (phase: 'active' | 'resolved', extra: Partial<ProviderMessageSignal> = {}): ProviderMessageSignal => ({
  id: 'usage:session', kind: 'usage_limit', phase, severity: 'blocking', scope: 'session', ...extra,
});
const event = (seq: number, value: ProviderMessageSignal): WbpEvent => ({
  type: 'provider.message', signal: value, seq, sessionId: 'chat', at: `2026-08-30T08:00:0${seq}Z`,
});

describe('provider message lifecycle', () => {
  // A notice is a line of the transcript like any other. Saying the same
  // condition again, or saying it cleared, never takes an earlier line away,
  // so a reload draws what the live chat drew.
  it('keeps every notice where it happened, and only the newest is current', () => {
    const view = foldAll([
      event(1, signal('active', { detail: 'first observation' })),
      event(2, signal('active', { detail: 'new observation' })),
      event(3, signal('resolved')),
      event(4, signal('active', { detail: 'again' })),
    ]);
    expect(view.items.map((item) => item.id)).toEqual([
      'provider-message-1', 'provider-message-2', 'provider-message-3', 'provider-message-4',
    ]);
    expect([...currentProviderMessages(view.items)]).toEqual(['provider-message-4']);
    // One run of one kind, folded as any run is, ending on the current one.
    expect(drawnRows(view.items)).toMatchObject([
      { row: 'machine', current: true, lines: [{ body: 'first observation' }, { body: 'new observation' }, { body: 'again' }] },
    ]);
  });

  it('leaves a cleared notice on the page, no longer current', () => {
    const view = foldAll([event(1, signal('active')), event(2, signal('resolved'))]);
    expect(currentProviderMessages(view.items).size).toBe(0);
    expect(drawnRows(view.items)).toMatchObject([{ row: 'machine', current: false }]);
  });

  // A signal never deletes a message, however confidently it names one. It
  // used to, so a condition filed against the wrong message took a real answer
  // off the page — and off every reload, because the projection is what a
  // reload is served from. Then the next clean turn resolved the condition and
  // removed the notice as well, leaving a gap with nothing to explain it. A
  // limit said twice costs a duplicated sentence; this cost the sentence
  // (bw-by3w).
  it('draws a condition beside the message it names and never in place of it', () => {
    const view = foldAll([
      { type: 'message.started', messageId: 'ordinary', role: 'assistant', seq: 1, sessionId: 'chat', at: '2026-08-30T08:00:01Z' },
      { type: 'text.delta', messageId: 'ordinary', text: 'Your files are ready.', seq: 2, sessionId: 'chat', at: '2026-08-30T08:00:02Z' },
      { type: 'message.completed', messageId: 'ordinary', seq: 3, sessionId: 'chat', at: '2026-08-30T08:00:03Z' },
      { type: 'message.started', messageId: 'vendor-error', role: 'assistant', seq: 4, sessionId: 'chat', at: '2026-08-30T08:00:04Z' },
      { type: 'text.delta', messageId: 'vendor-error', text: "You've hit your limit", seq: 5, sessionId: 'chat', at: '2026-08-30T08:00:05Z' },
      event(6, signal('active', { sourceMessageId: 'vendor-error' })),
    ]);
    expect(view.items).toMatchObject([
      { kind: 'message', id: 'ordinary' },
      { kind: 'message', id: 'vendor-error' },
      { kind: 'provider_message', id: 'provider-message-6' },
    ]);
  });

  // A chat recorded before every clean turn said so still clears: the agent
  // answering after the notice is the turn having gone through.
  it('a reply after a notice means its condition no longer stands', () => {
    const view = foldAll([
      event(1, signal('active')),
      { type: 'message.started', messageId: 'later', role: 'assistant', seq: 2, sessionId: 'chat', at: '2026-08-30T08:00:02Z' },
      { type: 'message.completed', messageId: 'later', seq: 3, sessionId: 'chat', at: '2026-08-30T08:00:03Z' },
    ]);
    expect(currentProviderMessages(view.items).size).toBe(0);
    expect(drawnRows(view.items)[0]).toMatchObject({ row: 'machine', current: false });
  });

  // A reset time passing is not the condition clearing: the notice keeps
  // saying when it lifted, and the next turn says whether it did.
  it('does not hide a notice when its reset time passes', () => {
    const view = foldAll([event(1, signal('active', { retryAt: '2020-08-30T08:00:00Z' }))]);
    expect(drawnRows(view.items)).toMatchObject([{ row: 'machine', current: true }]);
  });

  it('clears a generic transient error when the session recovers', () => {
    const view = foldAll([
      { type: 'error', message: 'A temporary provider error', fatal: false, seq: 1, sessionId: 'chat', at: '2026-08-30T08:00:01Z' },
      { type: 'session.state', state: 'idle', label: 'Ready', seq: 2, sessionId: 'chat', at: '2026-08-30T08:00:02Z' },
    ]);
    expect(view.error).toBeNull();
  });
});
