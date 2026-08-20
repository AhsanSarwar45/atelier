/**
 * A sent-off agent's own words, kept with the call that sent them.
 *
 * The kit forwards a helper's tool calls by default and nothing else, so a chat
 * that delegated its work drew a column of commands with no reasoning anywhere
 * near them. With the words arriving, they have to arrive ATTACHED: a helper's
 * sentence loose in the transcript reads as the agent you are talking to saying
 * it, which is worse than not showing it at all (bw-7ks.22.2).
 *
 * Both folds are checked on the same events, because the live tail and the
 * replay are two paths to one conversation and a difference between them is a
 * chat that changes when you reload it (§4).
 */
import { describe, expect, it } from 'vitest';

import { EMPTY, foldAll, reduce, type SessionView, type TranscriptTool } from '@/workbench/fold';
import { showing, type KindId } from '@/workbench/message-filter';
import type { WbpEvent } from '@/workbench/protocol';

let stamped = 0;
type Said<T> = T extends unknown ? Omit<T, 'seq' | 'sessionId' | 'at'> : never;
function said(e: Said<WbpEvent>): WbpEvent {
  stamped += 1;
  return { ...e, seq: stamped, sessionId: 'chat-1', at: '2026-08-20T00:00:00.000Z' } as WbpEvent;
}

/** A turn that sends one helper away, hears it think, work and answer. */
function delegated(): WbpEvent[] {
  return [
    said({ type: 'message.started', messageId: 'own', role: 'assistant' }),
    said({ type: 'text.delta', messageId: 'own', text: 'Handing this to a helper.' }),
    said({ type: 'message.completed', messageId: 'own' }),
    said({
      type: 'tool.started',
      toolCallId: 'call-1',
      name: 'Agent',
      input: { description: 'find the callers' },
      title: 'Agent: find the callers',
      parentToolCallId: null,
    }),
    said({ type: 'tool.progress', toolCallId: 'call-1', seconds: 31, summary: 'Reading the router' }),
    said({ type: 'thinking.delta', messageId: 'help-t', text: 'Two places call it.', parentToolCallId: 'call-1' }),
    said({ type: 'message.completed', messageId: 'help-t' }),
    said({ type: 'message.started', messageId: 'help-a', role: 'assistant', parentToolCallId: 'call-1' }),
    said({ type: 'text.delta', messageId: 'help-a', text: 'Both callers are in the router.' }),
    said({ type: 'message.completed', messageId: 'help-a' }),
    said({
      type: 'tool.started',
      toolCallId: 'call-2',
      name: 'Grep',
      input: { pattern: 'route' },
      title: 'Grep route',
      parentToolCallId: 'call-1',
    }),
  ];
}

/** The same events down the live tail, one at a time. */
function live(events: WbpEvent[]): SessionView {
  return events.reduce(reduce, EMPTY);
}

const bothWays: [string, (events: WbpEvent[]) => SessionView][] = [
  ['the live tail', live],
  ['a replay', (events) => foldAll(events)],
];

describe.each(bothWays)('a helper’s words, down %s', (_name, build) => {
  const view = build(delegated());
  const at = (id: string) => view.items.find((it) => it.id === id)!;

  it('names the call that sent them', () => {
    expect(at('help-a')).toMatchObject({ kind: 'message', parentId: 'call-1' });
    expect(at('help-t')).toMatchObject({ kind: 'thinking', parentId: 'call-1' });
  });

  it('leaves the words of the agent you are talking to unattached', () => {
    expect(at('own')).toMatchObject({ kind: 'message', parentId: null });
  });

  it('says what the helper is doing now, on the row that sent it', () => {
    expect(at('call-1')).toMatchObject({ kind: 'tool', summary: 'Reading the router', seconds: 31 });
  });

  it('keeps the last thing it said when a later beat says nothing new', () => {
    const later = build([...delegated(), said({ type: 'tool.progress', toolCallId: 'call-1', seconds: 62 })]);
    const row = later.items.find((it) => it.id === 'call-1') as TranscriptTool;
    expect(row).toMatchObject({ summary: 'Reading the router', seconds: 62 });
  });

  it('says nothing about work nobody delegated', () => {
    expect(at('call-2')).toMatchObject({ kind: 'tool', parentId: 'call-1', summary: null });
  });
});

describe('hiding the call that sent a helper away', () => {
  it('takes everything the helper produced with it', () => {
    const items = foldAll(delegated()).items;
    const off = new Set<KindId>(['tool:Agent']);
    const left = showing(items, off).map((it) => it.id);

    expect(left, 'the helper’s call is still drawn').not.toContain('call-1');
    expect(left, 'the helper’s answer was left standing loose').not.toContain('help-a');
    expect(left, 'the helper’s thinking was left standing loose').not.toContain('help-t');
    expect(left, 'the helper’s own command was left standing loose').not.toContain('call-2');
    expect(left, 'the chat’s own words went with it').toContain('own');
  });
});
