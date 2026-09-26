import { describe, expect, it } from 'vitest';

import { linesInFlight, worthDrawing, type PendingSend } from '@/workbench/pending-sends';
import type { TranscriptItem } from '@/workbench/fold';
import type { HeldMessage } from '@/workbench/protocol';

function said(id: string, role: 'user' | 'assistant', text = id): TranscriptItem {
  return { kind: 'message', id, role, text, images: [], done: true, parentId: null };
}

function held(id: string, pushed = false): HeldMessage {
  return { id, sessionId: 'chat', text: id, images: [], parts: null, heldAt: '2026-09-26T00:00:00Z', pushed };
}

const SENT: PendingSend[] = [
  { id: 'line-1', text: 'first', images: [] },
  { id: 'line-2', text: 'second', images: [] },
];

/** Where each line is on one frame: in the transcript (drawn or recorded) or in the queue. */
function onScreen(pending: PendingSend[], items: TranscriptItem[], queue: HeldMessage[]) {
  const lines = linesInFlight(pending, items, queue);
  return {
    transcript: [...items.filter(worthDrawing), ...lines.sent].map((item) => item.id),
    queue: lines.waiting.map((line) => line.id),
  };
}

describe('a line drawn before the server has spoken it back', () => {
  it('stands while the transcript has gained nothing', () => {
    expect(linesInFlight(SENT, [said('older-answer', 'assistant')], []).outstanding).toEqual(SENT);
  });

  it('goes when the server records it under the same id, and only that one', () => {
    const lines = linesInFlight(SENT, [said('line-1', 'user')], []);
    expect(lines.outstanding).toEqual([SENT[1]]);
    expect(lines.sent.map((row) => row.id)).toEqual(['line-2']);
  });

  /** Older history prepended while a send is in flight names none of its lines. */
  it('is not spoken for by other messages of the reader’s arriving', () => {
    const history = [said('page-back-1', 'user'), said('page-back-2', 'user')];
    expect(linesInFlight(SENT, history, []).outstanding).toEqual(SENT);
  });

  it('is drawn exactly as the server’s copy will be, so the swap shows nothing', () => {
    const [row] = linesInFlight([{ id: 'line-1', text: 'hello', images: [] }], [], []).sent;
    // `composedHere` among the fields: the server's copy carries it, and a row
    // drawn without it would be filed as a machine line (bw-oamr.1).
    expect(row).toEqual({ ...said('line-1', 'user'), text: 'hello', composedHere: true });
  });
});

/**
 * Ctrl+Enter mid-turn, frame by frame in the order the server writes: the line
 * is held already pushed, the turn is interrupted, the turn's end records the
 * message, and only then is the held row released. It used to be drawn, then
 * shown waiting, then drawn again.
 */
describe('a line sent into a turn', () => {
  const pending = [SENT[0]!];
  it('stays in the transcript, once, on every frame', () => {
    const frames: Array<[TranscriptItem[], HeldMessage[]]> = [
      [[], []],
      [[], [held('line-1', true)]],
      [[{ ...said('line-1', 'user', ''), done: false } as TranscriptItem], [held('line-1', true)]],
      [[said('line-1', 'user', 'first')], [held('line-1', true)]],
      [[said('line-1', 'user', 'first')], []],
    ];
    for (const [items, queue] of frames) {
      expect(onScreen(pending, items, queue)).toEqual({ transcript: ['line-1'], queue: [] });
    }
  });

  it('is drawn as sent in another window, from the pushed row alone', () => {
    expect(onScreen([], [], [held('line-1', true)])).toEqual({ transcript: ['line-1'], queue: [] });
  });

  /** Stopped before its turn ended: back to waiting, where it can be sent, edited or dropped. */
  it('goes back to the queue when the turn is stopped instead', () => {
    const lines = linesInFlight(pending, [], [held('line-1', false)]);
    expect(lines.sent).toEqual([]);
    expect(lines.waiting.map((line) => line.id)).toEqual(['line-1']);
    expect(lines.outstanding).toEqual([]);
  });
});

describe('a line held to wait', () => {
  it('is in the queue until it is recorded, and never in both', () => {
    expect(onScreen([], [], [held('line-3')])).toEqual({ transcript: [], queue: ['line-3'] });
    expect(onScreen([], [said('line-3', 'user')], [held('line-3')])).toEqual({ transcript: ['line-3'], queue: [] });
  });
});

/** The recorded row is built empty and filled a frame later (bw-w29l). */
describe('the swap from the drawn line to the server’s own', () => {
  const pending: PendingSend[] = [{ id: 'line-1', text: 'what the reader wrote', images: [] }];
  const started: TranscriptItem = { kind: 'message', id: 'line-1', role: 'user', text: '', images: [], done: false, parentId: null };
  const filled = { ...started, text: 'what the reader wrote' } as TranscriptItem;

  it('never loses the words, on any frame of the sequence', () => {
    for (const frame of [[], [started], [filled], [{ ...filled, done: true } as TranscriptItem]]) {
      const lines = linesInFlight(pending, frame, []);
      const texts = [...frame.filter(worthDrawing), ...lines.sent]
        .map((item) => (item.kind === 'message' ? item.text : ''));
      expect(texts).toEqual(['what the reader wrote']);
    }
  });

  it('is retired by a completed message even if it says nothing', () => {
    expect(linesInFlight(pending, [{ ...started, done: true }], []).outstanding).toEqual([]);
  });
});
