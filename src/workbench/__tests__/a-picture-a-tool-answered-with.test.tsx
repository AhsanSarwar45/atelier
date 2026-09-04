/**
 * A tool that answers with a picture rather than with words.
 *
 * A screenshot tool, a chart renderer, a page fetcher: ACP carries the answer
 * as an image content block, and every reader here took the four content kinds
 * that are WORDS and dropped the rest. The row said "ok" and showed nothing,
 * which is the same as the call never having run (bw-t26l.20).
 *
 * Both folds are checked on the same events, because the live tail and the
 * replay are two paths to one conversation and a difference between them is a
 * chat that changes when you reload it.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EMPTY, foldAll, reduce, type TranscriptTool } from '@/workbench/fold';
import { ToolRow } from '@/workbench/transcript-rows';
import type { WbpEvent } from '@/workbench/protocol';

let stamped = 0;
type Said<T> = T extends unknown ? Omit<T, 'seq' | 'sessionId' | 'at'> : never;
function said(e: Said<WbpEvent>): WbpEvent {
  stamped += 1;
  return { ...e, seq: stamped, sessionId: 'chat-1', at: '2026-08-20T00:00:00.000Z' } as WbpEvent;
}

const SHOT = 'data:image/png;base64,iVBORw0KGgo=';

const took = (): WbpEvent[] => [
  said({
    type: 'tool.started',
    toolCallId: 'call-1',
    name: 'screenshot',
    input: { url: 'http://localhost/board' },
    title: 'Screenshot the board',
    parentToolCallId: null,
  }),
  said({
    type: 'image',
    messageId: null,
    toolCallId: 'call-1',
    image: { mime: 'image/png', dataUrl: SHOT, alt: 'the board' },
  }),
  said({ type: 'tool.completed', toolCallId: 'call-1', ok: true, output: '' }),
];

describe('a picture a tool answered with', () => {
  it('hangs off the call that took it, on both folds', () => {
    const live = took().reduce((view, event) => reduce(view, event), EMPTY);
    const replayed = foldAll(took());
    for (const view of [live, replayed]) {
      const call = view.items.find((it): it is TranscriptTool => it.kind === 'tool');
      expect(call?.images).toEqual([{ mime: 'image/png', dataUrl: SHOT, alt: 'the board' }]);
    }
    // And it did not also invent a message to hang it off.
    expect(replayed.items.filter((it) => it.kind === 'message')).toHaveLength(0);
  });

  it('is drawn on the row without anyone opening it', () => {
    const call = foldAll(took()).items.find((it): it is TranscriptTool => it.kind === 'tool')!;
    render(<ToolRow item={call} nested={false} />);
    // Not behind the row's click: a screenshot IS the answer.
    expect(screen.getByTestId('picture-grid')).toBeInTheDocument();
    expect(screen.getByAltText('the board')).toBeInTheDocument();
  });
});
