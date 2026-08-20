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
import { DrawnTranscript, SCREENFUL } from '@/workbench/drawn-transcript';
import { drawnRows } from '@/workbench/machine-lines';
import type { ImagePayload, WbpEvent } from '@/workbench/protocol';
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
}

const MENTIONS: Mentions = { split: (text) => [{ kind: 'text', text }], card: (id) => id, report: (slug) => slug };
const LOOK = (_image: ImagePayload) => {};

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

function chat(sessionId = 's', held = HELD) {
  const pane = createRef<HTMLDivElement>();
  const rows = drawnRows(conversation(held).items);
  const drawn = render(
    <div ref={pane}>
      <DrawnTranscript rows={rows} sessionId={sessionId} mentions={MENTIONS} onLook={LOOK} pane={pane} />
    </div>,
  );
  return { ...drawn, pane, rows };
}

const messages = () => screen.queryAllByTestId(/-message$/);

beforeEach(() => {
  heads = [];
  seq = 0;
  vi.stubGlobal('IntersectionObserver', FakeHead);
});

describe('what a chat puts on the page', () => {
  it('draws a screenful of a long conversation, not all of it', () => {
    chat();
    expect(messages()).toHaveLength(SCREENFUL);
  });

  it('draws the newest messages, because that is where the reader is', () => {
    chat();
    const drawn = messages().map((row) => row.textContent);
    expect(drawn[drawn.length - 1]).toContain(`message ${HELD - 1}`);
    expect(drawn[0]).toContain(`message ${HELD - SCREENFUL}`);
  });

  it('draws another screenful when the reader scrolls up to the older ones', () => {
    chat();
    act(() => heads[heads.length - 1]!.reached());
    expect(messages()).toHaveLength(SCREENFUL * 2);
  });

  it('stops asking for more once the whole conversation is on the page', () => {
    chat('s', 10);
    expect(messages()).toHaveLength(10);
    // Nothing is watching: there is nothing older to reach.
    expect(screen.queryByTestId('older-messages')).toBeNull();
  });

  it('opens another chat at its own end, not where the last one had been read to', () => {
    const { rerender, pane, rows } = chat();
    act(() => heads[heads.length - 1]!.reached());
    expect(messages()).toHaveLength(SCREENFUL * 2);

    rerender(
      <div ref={pane}>
        <DrawnTranscript rows={rows} sessionId="another" mentions={MENTIONS} onLook={LOOK} pane={pane} />
      </div>,
    );
    expect(messages()).toHaveLength(SCREENFUL);
  });
});
