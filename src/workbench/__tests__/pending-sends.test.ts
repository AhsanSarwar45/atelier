import { describe, expect, it } from 'vitest';

import { drawnAsSent, stillPending, userMessageIds, type PendingSend } from '@/workbench/pending-sends';
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
    expect(stillPending(SENT, before, userMessageIds(before))).toEqual(SENT);
  });

  it('goes as soon as the server sends its own copy', () => {
    const before = [said('older-answer', 'assistant')];
    const mark = userMessageIds(before);
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
    const mark = userMessageIds(before);
    const after = [...before, said('first-back', 'user'), said('second-back', 'user')];
    expect(stillPending(SENT, after, mark)).toEqual([]);
  });

  /** An answer arriving is not the line coming back, and must not retire it. */
  it('is not spoken for by anything the agent says', () => {
    const before: TranscriptItem[] = [];
    const after = [said('an-answer', 'assistant'), { kind: 'tool', id: 'a-tool' } as TranscriptItem];
    expect(stillPending(SENT, after, userMessageIds(before))).toEqual(SENT);
  });

  /** Nothing sent, nothing drawn — the ordinary state of a chat being read. */
  it('draws nothing when nothing is outstanding', () => {
    const items = [said('older-prompt', 'user'), said('an-answer', 'assistant')];
    expect(stillPending([], items, userMessageIds([]))).toEqual([]);
  });

  it('is drawn exactly as the server’s copy will be, so the swap shows nothing', () => {
    const row = drawnAsSent({ key: 'sending-0', text: 'hello', images: [] });
    // The same shape a folded user message has, under this page's own name for
    // it: anything the drawing keys on must already be here, or the row would
    // change appearance the moment the server's copy took its place.
    expect(row).toEqual({ ...said('sending-0', 'user'), text: 'hello' });
  });
});
