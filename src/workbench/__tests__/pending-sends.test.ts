import { describe, expect, it } from 'vitest';

import { drawnAsSent, stillPending, transcriptMark, worthDrawing, type PendingSend } from '@/workbench/pending-sends';
import type { TranscriptItem } from '@/workbench/fold';

function said(id: string, role: 'user' | 'assistant'): TranscriptItem {
  return { kind: 'message', id, role, text: id, images: [], done: true, parentId: null };
}

const SENT: PendingSend[] = [
  { key: 'sending-0', text: 'first', images: [] },
  { key: 'sending-1', text: 'second', images: [] },
];

describe('a line drawn before the server has spoken it back', () => {
  it('stands while the transcript has gained nothing', () => {
    const before = [said('older-answer', 'assistant')];
    expect(stillPending(SENT, before, transcriptMark(before))).toEqual(SENT);
  });

  it('goes as soon as the server sends its own copy', () => {
    const before = [said('older-answer', 'assistant')];
    const mark = transcriptMark(before);
    const after = [...before, said('from-the-server', 'user')];
    expect(stillPending(SENT, after, mark)).toEqual([SENT[1]]);
  });

  /**
   * The reply that names the sent line usually arrives AFTER the stream has
   * already carried the line itself, so matching on the id would leave two
   * copies on the page for the length of a round trip. Counting does not care
   * which arrived first.
   */
  it('is matched by count, not by the id it was drawn under', () => {
    const before = [said('older-prompt', 'user')];
    const mark = transcriptMark(before);
    const after = [...before, said('first-back', 'user'), said('second-back', 'user')];
    expect(stillPending(SENT, after, mark)).toEqual([]);
  });

  /** An answer arriving is not the line coming back, and must not retire it. */
  it('is not spoken for by anything the agent says', () => {
    const before: TranscriptItem[] = [];
    const after = [said('an-answer', 'assistant'), { kind: 'tool', id: 'a-tool' } as TranscriptItem];
    expect(stillPending(SENT, after, transcriptMark(before))).toEqual(SENT);
  });

  /**
   * The reader scrolls up mid-send. Older pages are prepended, every one of
   * them full of their own past messages — and each of those used to be counted
   * as the echo of the line still on its way, so the line they had just sent
   * disappeared from under them (bw-ad3r.11).
   */
  it('is not spoken for by older history arriving above it', () => {
    const before = [said('older-prompt', 'user'), said('older-answer', 'assistant')];
    const mark = transcriptMark(before);
    const older = [said('page-back-1', 'user'), said('page-back-2', 'user'), said('page-back-3', 'user')];
    expect(stillPending(SENT, [...older, ...before], mark)).toEqual(SENT);
  });

  /** And the echo still retires it once the older pages are sitting above. */
  it('still goes when its own copy arrives below prepended history', () => {
    const before = [said('older-answer', 'assistant')];
    const mark = transcriptMark(before);
    const older = [said('page-back-1', 'user'), said('page-back-2', 'user')];
    const after = [...older, ...before, said('from-the-server', 'user')];
    expect(stillPending(SENT, after, mark)).toEqual([SENT[1]]);
  });

  /** Nothing sent, nothing drawn — the ordinary state of a chat being read. */
  it('draws nothing when nothing is outstanding', () => {
    const items = [said('older-prompt', 'user'), said('an-answer', 'assistant')];
    expect(stillPending([], items, transcriptMark([]))).toEqual([]);
  });

  it('is drawn exactly as the server’s copy will be, so the swap shows nothing', () => {
    const row = drawnAsSent({ key: 'sending-0', text: 'hello', images: [] });
    // The same shape a folded user message has, under this page's own name for
    // it: anything the drawing keys on must already be here, or the row would
    // change appearance the moment the server's copy took its place.
    expect(row).toEqual({ ...said('sending-0', 'user'), text: 'hello' });
  });
});

/**
 * The swap, frame by frame, in the order the sidecar actually writes.
 *
 * `record_user_for_transport` appends `message.started`, then any pictures,
 * then `text.delta`, then `message.completed`, each its own row in the store
 * and so each its own frame on the wire. The fold builds the row on the first
 * of those with `text: ''` and fills it on the third. Retiring the drawn line
 * on the first left the reader's own words gone from the screen until the
 * third arrived — read on the running app as a blink (bw-w29l).
 */
describe('the swap from the drawn line to the server’s own', () => {
  const SENT: PendingSend[] = [{ key: 'sending-0', text: 'what the reader wrote', images: [] }];
  const started: TranscriptItem = {
    kind: 'message', id: 'from-the-server', role: 'user',
    text: '', images: [], done: false, parentId: null,
  };
  const filled = { ...started, text: 'what the reader wrote' } as TranscriptItem;
  const completed = { ...filled, done: true } as TranscriptItem;

  /** What the transcript would read, drawn line included, at one moment. */
  function onScreen(items: TranscriptItem[]): string[] {
    return [...items.filter(worthDrawing), ...stillPending(SENT, items, new Set()).map(drawnAsSent)]
      .filter((item): item is typeof filled & { text: string } => item.kind === 'message')
      .map((item) => item.text);
  }

  it('never loses the words, on any frame of the sequence', () => {
    for (const frame of [[], [started], [started], [filled], [completed]]) {
      expect(onScreen(frame as TranscriptItem[])).toEqual(['what the reader wrote']);
    }
  });

  it('keeps exactly one copy once the server’s carries the words', () => {
    expect(stillPending(SENT, [filled], new Set())).toEqual([]);
  });

  /** An empty row that completes anyway is still the server speaking. */
  it('is retired by a completed message even if it says nothing', () => {
    expect(stillPending(SENT, [{ ...started, done: true }], new Set())).toEqual([]);
  });
});

describe('a row with nothing in it yet', () => {
  const bare = {
    kind: 'message', id: 'm', role: 'user', text: '', images: [], done: false, parentId: null,
  } as TranscriptItem;

  it('is held back while it is the reader’s and says nothing', () => {
    expect(worthDrawing(bare)).toBe(false);
  });

  it('is drawn once it has words, pictures, or has finished', () => {
    expect(worthDrawing({ ...bare, text: 'said' } as TranscriptItem)).toBe(true);
    expect(worthDrawing({
      ...bare, images: [{ mime: 'image/png', dataUrl: 'data:image/png;base64,x', alt: 'a shot' }],
    } as TranscriptItem)).toBe(true);
    expect(worthDrawing({ ...bare, done: true } as TranscriptItem)).toBe(true);
  });

  /** The agent's own empty opening is the thing the reader watches fill. */
  it('is drawn anyway when the agent is the one speaking', () => {
    expect(worthDrawing({ ...bare, role: 'assistant' } as TranscriptItem)).toBe(true);
  });

  it('leaves every other kind of row alone', () => {
    expect(worthDrawing({ kind: 'tool', id: 't' } as TranscriptItem)).toBe(true);
  });
});
