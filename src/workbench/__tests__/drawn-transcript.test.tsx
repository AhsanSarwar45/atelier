/**
 * How much of a conversation a chat puts on the page.
 *
 * All of it, was the answer: two thousand messages is forty thousand pieces of
 * screen and just under three seconds before the first word can be read, paid
 * on every open, for a reader who is looking at the last screenful (bw-2lzj.2).
 *
 * The window is anchored at the END, because that is what a chat is: it opens
 * at the newest thing said, and history is reached by scrolling up.
 */
import { act, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import { DrawnTranscript, SCREENFUL, TURNFUL } from '@/workbench/drawn-transcript';
import { drawnRows, type DrawnRow } from '@/workbench/machine-lines';
import type { LookableImage, WbpEvent } from '@/workbench/protocol';
import { EMPTY, reduce, type SessionView } from '@/workbench/use-session';

/** Every watcher of the head of the conversation, newest last. */
let heads: FakeHead[] = [];

/**
 * jsdom has no layout, so it has no way of knowing what is on screen. This one
 * reaches the older messages only when the case says the reader scrolled up to
 * them — a watcher that fired on its own could not tell a chat that draws a
 * screenful from one that draws the lot.
 */
class FakeHead {
  constructor(private readonly tell: (entries: { isIntersecting: boolean }[]) => void) {
    heads.push(this);
  }

  observe(): void {}
  disconnect(): void {}

  /** The reader scrolls up and asks for the older messages. */
  reached(): void {
    this.tell([{ isIntersecting: true }]);
  }

  /** The reader leaves the history head, permitting a later deliberate page. */
  left(): void {
    this.tell([{ isIntersecting: false }]);
  }
}

const MENTIONS: Mentions = { split: (text) => [{ kind: 'text', text }], card: (id) => id };
const LOOK = (_image: LookableImage) => {};

/** One event without the envelope the wire wraps it in. */
type Said<T> = T extends unknown ? Omit<T, 'seq' | 'sessionId' | 'at'> : never;

let seq = 0;
function fold(view: SessionView, event: Said<WbpEvent>): SessionView {
  seq += 1;
  return reduce(view, { ...event, seq, sessionId: 's', at: '' } as WbpEvent);
}

/** A conversation of `held` finished messages, folded the way the wire folds it. */
function conversation(held: number): SessionView {
  let view = EMPTY;
  for (let i = 0; i < held; i += 1) {
    const messageId = `m${i}`;
    view = fold(view, { type: 'message.started', messageId, role: i % 2 ? 'assistant' : 'user' });
    view = fold(view, { type: 'text.delta', messageId, text: `message ${i}` });
    view = fold(view, { type: 'message.completed', messageId });
  }
  return view;
}

const HELD = 201;

function chat(
  sessionId = 's',
  held = HELD,
  onOlder: (() => Promise<{ added: number; hasOlder: boolean }>) | null = null,
  givenRows?: DrawnRow[],
) {
  const pane = createRef<HTMLDivElement>();
  const rows = givenRows ?? drawnRows(conversation(held).items);
  const shows = (what: { rows: DrawnRow[]; sessionId: string; watching: boolean }) => (
    <div ref={pane}>
      <DrawnTranscript
        rows={what.rows}
        sessionId={what.sessionId}
        mentions={MENTIONS}
        onLook={LOOK}
        pane={pane}
        held={what.watching}
        onOlder={onOlder}
      />
    </div>
  );
  const drawn = render(shows({ rows, sessionId, watching: true }));
  /** The chat drawn again: another conversation, more of this one, or both. */
  const again = (what: { rows?: DrawnRow[]; sessionId?: string; watching?: boolean }) =>
    drawn.rerender(shows({ rows: what.rows ?? rows, sessionId: what.sessionId ?? sessionId, watching: what.watching ?? true }));
  return { ...drawn, pane, rows, again };
}

/** The same conversation with more said since. */
function grownTo(many: number) {
  return drawnRows(conversation(many).items);
}

function toolHeavyConversation(): DrawnRow[] {
  let view = EMPTY;
  for (let turn = 0; turn < 25; turn += 1) {
    const prompt = `prompt-${turn}`;
    view = fold(view, { type: 'message.started', messageId: prompt, role: 'user' });
    view = fold(view, { type: 'text.delta', messageId: prompt, text: `prompt ${turn}` });
    view = fold(view, { type: 'message.completed', messageId: prompt });
    if (turn === 24) {
      for (let tool = 0; tool < 500; tool += 1) {
        view = fold(view, {
          type: 'tool.started', toolCallId: `tool-${tool}`, name: 'Read',
          input: { file_path: `file-${tool}.ts` }, title: `Read file ${tool}`,
          parentToolCallId: null,
        });
        view = fold(view, { type: 'tool.completed', toolCallId: `tool-${tool}`, ok: true, output: '' });
      }
    }
    const answer = `answer-${turn}`;
    view = fold(view, { type: 'message.started', messageId: answer, role: 'assistant' });
    view = fold(view, { type: 'text.delta', messageId: answer, text: `answer ${turn}` });
    view = fold(view, { type: 'message.completed', messageId: answer });
  }
  return drawnRows(view.items);
}

const messages = () => screen.queryAllByTestId(/-message$/);
const INITIAL_MESSAGES = TURNFUL * 2 - 1;

beforeEach(() => {
  heads = [];
  seq = 0;
  vi.stubGlobal('IntersectionObserver', FakeHead);
});

describe('what a chat puts on the page', () => {
  it('draws a screenful of a long conversation, not all of it', () => {
    chat();
    expect(messages()).toHaveLength(INITIAL_MESSAGES);
  });

  it('draws the newest messages, because that is where the reader is', () => {
    chat();
    const drawn = messages().map((row) => row.textContent);
    expect(drawn[drawn.length - 1]).toContain(`message ${HELD - 1}`);
    expect(drawn[0]).toContain(`message ${HELD - INITIAL_MESSAGES}`);
  });

  it('draws another screenful when the reader scrolls up to the older ones', () => {
    chat();
    act(() => heads[heads.length - 1]!.reached());
    expect(messages()).toHaveLength(TURNFUL * 4 - 1);
  });

  it('crosses a tool-heavy turn by prompts instead of expanding hundreds of operation rows', () => {
    chat('tool-heavy', 0, null, toolHeavyConversation());

    expect(screen.getByText('prompt 5')).toBeVisible();
    expect(screen.queryByText('prompt 0')).toBeNull();
    expect(screen.getAllByTestId('tool-row').length).toBeLessThanOrEqual(SCREENFUL - 1);
    expect(screen.getByTestId('hidden-turn-rows')).toHaveTextContent('earlier operations in this turn');

    act(() => heads[heads.length - 1]!.reached());
    expect(screen.getByText('prompt 0')).toBeVisible();
    expect(screen.getAllByTestId('tool-row').length).toBeLessThanOrEqual(SCREENFUL - 1);
  });

  it('stops asking for more once the whole conversation is on the page', () => {
    chat('s', 10);
    expect(messages()).toHaveLength(10);
    // Nothing is watching: there is nothing older to reach.
    expect(screen.queryByTestId('older-messages')).toBeNull();
  });

  it('starts watching when a later snapshot says older history exists', async () => {
    const pane = createRef<HTMLDivElement>();
    const rows = drawnRows(conversation(10).items);
    const older = vi.fn().mockResolvedValue({ added: SCREENFUL, hasOlder: true });
    const view = (onOlder: (() => Promise<{ added: number; hasOlder: boolean }>) | null) => (
      <div ref={pane}>
        <DrawnTranscript
          rows={rows}
          sessionId="late-history"
          mentions={MENTIONS}
          onLook={LOOK}
          pane={pane}
          held={true}
          onOlder={onOlder}
        />
      </div>
    );
    const drawn = render(view(null));
    expect(heads).toHaveLength(0);

    drawn.rerender(view(older));
    expect(heads).toHaveLength(1);
    await act(async () => { heads[0]!.reached(); });

    expect(older).toHaveBeenCalledTimes(1);
  });

  it('opens another chat at its own end, not where the last one had been read to', () => {
    const { again } = chat();
    act(() => heads[heads.length - 1]!.reached());
    expect(messages()).toHaveLength(TURNFUL * 4 - 1);

    again({ sessionId: 'another' });
    expect(messages()).toHaveLength(INITIAL_MESSAGES);
  });

  it('asks for one server page while the history head remains visible', async () => {
    const older = vi.fn().mockResolvedValue({ added: SCREENFUL, hasOlder: true });
    chat('paged', 10, older);
    const head = heads[heads.length - 1]!;

    await act(async () => {
      head.reached();
      head.reached();
    });

    expect(older).toHaveBeenCalledTimes(1);
  });

  it('asks for another page only after the reader leaves and reaches the head again', async () => {
    const older = vi.fn().mockResolvedValue({ added: SCREENFUL, hasOlder: true });
    chat('paged-again', 10, older);
    const head = heads[heads.length - 1]!;

    await act(async () => { head.reached(); });
    head.left();
    await act(async () => { head.reached(); });

    expect(older).toHaveBeenCalledTimes(2);
  });

  it('fills one useful batch when cursor pages contain only a few items', async () => {
    const older = vi.fn()
      .mockResolvedValueOnce({ added: 6, hasOlder: true })
      .mockResolvedValueOnce({ added: 8, hasOlder: true })
      .mockResolvedValueOnce({ added: 26, hasOlder: true });
    chat('small-pages', 10, older);

    await act(async () => { heads[heads.length - 1]!.reached(); });

    expect(older).toHaveBeenCalledTimes(3);
  });

  it('holds the same viewport place when older rows are prepended', () => {
    const { pane } = chat();
    const box = pane.current!;
    Object.defineProperty(box, 'scrollHeight', {
      configurable: true,
      get: () => messages().length * 10,
    });
    box.scrollTop = 120;

    act(() => heads[heads.length - 1]!.reached());

    expect(messages()).toHaveLength(TURNFUL * 4 - 1);
    expect(box.scrollTop).toBe(520);
  });

  it('keeps the row the reader is reading when messages arrive behind him', () => {
    // The window is the last N rows, so every message that joins the bottom
    // pushes one off the top. Invisible to a reader at the end; to a reader up
    // in the history it is the paragraph he is reading being deleted, with the
    // pane never moving to show it (bw-n6yh.7).
    const { again } = chat();
    const top = messages()[0]!.textContent;
    expect(top).toContain(`message ${HELD - INITIAL_MESSAGES}`);

    again({ rows: grownTo(HELD + 20), watching: false });
    expect(messages()[0]!.textContent).toBe(top);
    expect(messages()).toHaveLength(INITIAL_MESSAGES + 20);
  });

  it('starts sliding again once he is back at the end', () => {
    const { again } = chat();
    again({ rows: grownTo(HELD + 20), watching: false });
    expect(messages()).toHaveLength(INITIAL_MESSAGES + 20);

    again({ rows: grownTo(HELD + 40), watching: true });
    expect(messages()).toHaveLength(INITIAL_MESSAGES + 20);
    expect(messages()[messages().length - 1]!.textContent).toContain(`message ${HELD + 39}`);
  });
});
