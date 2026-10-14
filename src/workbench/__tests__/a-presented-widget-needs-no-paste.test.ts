import { describe, expect, it } from 'vitest';
import type { ChatWidget } from '@/workbench/chat-widgets';
import { EMPTY, foldAll, reduce, type TranscriptItem, type TranscriptMessage, type TranscriptTool } from '@/workbench/fold';
import type { WbpEvent } from '@/workbench/protocol';
import { presentedId, withPresented } from '@/workbench/presented';

const image: ChatWidget = { type: 'image', asset: `${'a'.repeat(64)}.png`, alt: 'Login screen' };
const table: ChatWidget = { type: 'table', columns: ['Choice', 'Cost'], rows: [['A', '$2']] };

const tool = (id: string, command: string, presented?: ChatWidget[]): TranscriptTool => ({
  kind: 'tool', id, name: 'Bash', title: command, status: 'ok', seconds: 0, summary: null,
  parentId: null, diff: null, input: { command }, output: '', ...(presented ? { presented } : {}),
});
const reply = (id: string, widgets: ChatWidget[] = [], role: 'user' | 'assistant' = 'assistant'): TranscriptMessage => ({
  kind: 'message', id, role, text: '', images: [], widgets, done: true, parentId: null,
});
const presentedRows = (items: TranscriptItem[]) =>
  items.filter((item): item is TranscriptMessage => item.kind === 'message' && item.presentedBy !== undefined);

describe('a presented widget needs no paste (bw-yh4nu)', () => {
  it('draws what the presenter printed right after the call when no reply carried it', () => {
    const items = withPresented([
      tool('t1', 'atelier tool present image --file shot.png --alt "Login screen"', [image]),
      reply('m1'),
    ]);
    expect(items.map((item) => item.id)).toEqual(['t1', presentedId('t1'), 'm1']);
    const [row] = presentedRows(items);
    expect(row).toMatchObject({ role: 'assistant', presentedBy: 't1', widgets: [image] });
    expect(row!.text).toContain('```atelier-widget');
  });

  it('leaves a widget to the reply that pasted it, wherever that reply is', () => {
    const items = withPresented([
      tool('t1', 'atelier tool present image --file shot.png', [image, table]),
      reply('note', [], 'user'),
      reply('m1', [{ ...image }]),
    ]);
    expect(presentedRows(items).map((row) => row.widgets)).toEqual([[table]]);
  });

  it('does not count a paste from before the call', () => {
    const items = withPresented([
      reply('m0', [image]),
      tool('t1', 'atelier tool present image --file shot.png', [image]),
    ]);
    expect(presentedRows(items)).toHaveLength(1);
  });

  it('ignores blocks a call printed without running the presenter', () => {
    const items = [tool('t1', 'cat tests/e2e/presentation-media.spec.ts', [image])];
    expect(withPresented(items)).toBe(items);
    expect(presentedRows(withPresented(items))).toHaveLength(0);
  });

  it('keeps the widgets a completed presenter call carries on its row, live and folded at once', () => {
    const at = '2026-10-14T10:00:00Z';
    const events = [
      { type: 'tool.started', sessionId: 's', seq: 1, at, toolCallId: 't1', name: 'Bash', title: 'atelier tool present image', input: { command: 'atelier tool present image --file shot.png' } },
      { type: 'tool.completed', sessionId: 's', seq: 2, at, toolCallId: 't1', ok: true, output: '', presented: [image] },
    ] as unknown as WbpEvent[];
    const live = events.reduce(reduce, EMPTY);
    for (const view of [live, foldAll(events)]) {
      const row = view.items.find((item) => item.kind === 'tool') as TranscriptTool;
      expect(row.presented).toEqual([image]);
    }
  });
});
