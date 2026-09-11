/**
 * The transcript is two independent windows: storage retains every loaded
 * forty-item page, while the DOM contains only what is on screen plus
 * overscan. History moves only when the reader moves upward near its head.
 */
import { createRef } from 'react';

import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import { DrawnTranscript, OVERSCAN, SCREENFUL } from '@/workbench/drawn-transcript';
import type { DrawnRow } from '@/workbench/machine-lines';
import type { LookableImage } from '@/workbench/protocol';

const MENTIONS: Mentions = { split: (text) => [{ kind: 'text', text }], card: (id) => id };
const LOOK = (_image: LookableImage) => {};

function rows(many: number, prefix = 'm'): DrawnRow[] {
  return Array.from({ length: many }, (_, index) => ({
    row: 'other' as const,
    item: {
      kind: 'message' as const,
      id: `${prefix}-${index}`,
      role: index % 2 ? 'assistant' as const : 'user' as const,
      text: `message ${index}`,
      images: [],
      done: true,
      parentId: null,
    },
  }));
}

function chat(given: {
  rows?: DrawnRow[];
  loadedItems?: number;
  sessionId?: string;
  onOlder?: (() => Promise<{ added: number; hasOlder: boolean }>) | null;
} = {}) {
  const pane = createRef<HTMLDivElement>();
  let currentRows = given.rows ?? rows(400);
  let currentLoaded = given.loadedItems ?? currentRows.length;
  let currentSession = given.sessionId ?? 's';
  const show = () => (
    <div ref={pane} data-testid="pane">
      <DrawnTranscript
        rows={currentRows}
        loadedItems={currentLoaded}
        sessionId={currentSession}
        mentions={MENTIONS}
        onLook={LOOK}
        pane={pane}
        onOlder={given.onOlder}
      />
    </div>
  );
  // The production pane exists while the loading shell is visible, before the
  // transcript mounts. Model that ref lifecycle explicitly.
  const drawn = render(<div ref={pane} data-testid="pane" />);
  drawn.rerender(show());
  const again = (next: { rows?: DrawnRow[]; loadedItems?: number; sessionId?: string }) => {
    currentRows = next.rows ?? currentRows;
    currentLoaded = next.loadedItems ?? next.rows?.length ?? currentLoaded;
    currentSession = next.sessionId ?? currentSession;
    drawn.rerender(show());
  };
  return { ...drawn, pane, again };
}

/**
 * Gives the pane the scroll height the browser would give it: the height of the
 * one box inside it, which React writes at the moment it commits the added rows
 * and not a moment before. A height a test moves by hand ahead of the render is
 * a height the pane could never have had at that point, and code that reads it
 * before the commit — which is the only place the growth can be measured from —
 * reads the answer to a question nobody had asked yet.
 */
function growsWithTheTranscript(box: HTMLElement): void {
  Object.defineProperty(box, 'scrollHeight', {
    configurable: true,
    get: () => {
      const drawn = box.querySelector('[data-testid="virtual-transcript"]') as HTMLElement | null;
      return drawn ? parseFloat(drawn.style.height || '0') : 0;
    },
  });
}

function scroll(box: HTMLElement, top: number): void {
  box.scrollTop = top;
  box.dispatchEvent(new Event('scroll'));
}

function wheel(box: HTMLElement, deltaY: number): void {
  box.dispatchEvent(new WheelEvent('wheel', { deltaY }));
}

beforeEach(() => {
  // TanStack Virtual reads real element geometry. jsdom has none, so give the
  // scroll pane one ten-row viewport and measured transcript wrappers their
  // estimated height. This exercises the real virtualizer, not a test double.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.hasAttribute('data-index') ? 52 : 520;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(520);
});

describe('the virtual transcript window', () => {
  it('retains every loaded item while mounting only the viewport and overscan', async () => {
    const { findByTestId } = chat();
    const transcript = await findByTestId('virtual-transcript');
    expect(transcript).toHaveAttribute('data-total-items', '400');
    await waitFor(() => expect(Number(transcript.getAttribute('data-mounted-items'))).toBeGreaterThan(0));
    const mounted = Number(transcript.getAttribute('data-mounted-items'));
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThanOrEqual(10 + OVERSCAN * 2);
    expect(transcript.querySelectorAll('[data-transcript-key]')).toHaveLength(mounted);
  });

  it('asks for exactly one forty-item page on upward travel within one viewport of the head', async () => {
    const older = vi.fn().mockResolvedValue({ added: SCREENFUL, hasOlder: true });
    const { pane } = chat({ onOlder: older });
    await act(async () => {
      scroll(pane.current!, 900);
      scroll(pane.current!, 500);
    });
    expect(older).toHaveBeenCalledTimes(1);
  });

  it('asks for older history when upward wheel intent cannot move a pane already at its top', async () => {
    const older = vi.fn().mockResolvedValue({ added: SCREENFUL, hasOlder: true });
    const { pane } = chat({ rows: rows(4), onOlder: older });
    await act(async () => {
      wheel(pane.current!, -120);
      wheel(pane.current!, -120);
    });
    expect(pane.current!.scrollTop).toBe(0);
    expect(older).toHaveBeenCalledTimes(1);
  });

  it('does not treat a downward wheel at the top as a request for older history', async () => {
    const older = vi.fn().mockResolvedValue({ added: SCREENFUL, hasOlder: true });
    const { pane } = chat({ rows: rows(4), onOlder: older });
    await act(async () => wheel(pane.current!, 120));
    expect(older).not.toHaveBeenCalled();
  });

  it('can load again after older parents make the drawn projection smaller', async () => {
    const older = vi.fn().mockResolvedValue({ added: SCREENFUL, hasOlder: true });
    const { pane, again } = chat({ rows: rows(80), onOlder: older });
    await act(async () => wheel(pane.current!, -120));
    await act(async () => again({ rows: rows(10, 'refolded') }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    await act(async () => wheel(pane.current!, -120));
    expect(older).toHaveBeenCalledTimes(2);
  });

  it('can load again when older parents replace drawn rows one for one', async () => {
    const older = vi.fn().mockResolvedValue({ added: SCREENFUL, hasOlder: true });
    const sameRows = rows(80);
    const { pane, again } = chat({ rows: sameRows, loadedItems: 80, onOlder: older });
    await act(async () => wheel(pane.current!, -120));
    await act(async () => again({ rows: sameRows, loadedItems: 120 }));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 60)));
    await act(async () => wheel(pane.current!, -120));
    expect(older).toHaveBeenCalledTimes(2);
  });

  it('does not load merely because the chat opened, on downward travel, or far from the head', async () => {
    const older = vi.fn().mockResolvedValue({ added: SCREENFUL, hasOlder: true });
    const { pane } = chat({ onOlder: older });
    await act(async () => {
      scroll(pane.current!, 2_000);
      scroll(pane.current!, 1_000);
    });
    expect(older).not.toHaveBeenCalled();
  });

  it('keeps only one history request in flight', async () => {
    let finish!: (page: { added: number; hasOlder: boolean }) => void;
    const older = vi.fn(() => new Promise<{ added: number; hasOlder: boolean }>((resolve) => { finish = resolve; }));
    const { pane } = chat({ onOlder: older });
    act(() => {
      scroll(pane.current!, 900);
      scroll(pane.current!, 500);
      scroll(pane.current!, 400);
      scroll(pane.current!, 300);
    });
    expect(older).toHaveBeenCalledTimes(1);
    await act(async () => finish({ added: SCREENFUL, hasOlder: true }));
  });

  /**
   * Scrolling back through a long chat is meant to read as one continuous
   * transcript. Announcing every page turned it into a banner blinking on and
   * off at each flick, which on a phone read as a 'load more' control the
   * reader kept having to get past (bw-ad3r.14).
   */
  it('says nothing at all about a page that arrives quickly', async () => {
    let finish!: (page: { added: number; hasOlder: boolean }) => void;
    const older = vi.fn(() => new Promise<{ added: number; hasOlder: boolean }>((resolve) => { finish = resolve; }));
    const { pane, queryByTestId } = chat({ onOlder: older });

    act(() => {
      scroll(pane.current!, 900);
      scroll(pane.current!, 500);
    });
    expect(older).toHaveBeenCalledTimes(1);
    expect(queryByTestId('older-loading')).toBeNull();

    await act(async () => finish({ added: SCREENFUL, hasOlder: true }));
    await act(async () => { await new Promise((done) => setTimeout(done, 500)); });
    expect(queryByTestId('older-loading')).toBeNull();
  });

  it('drops an older-history loader and ignores its stale completion when the chat changes', async () => {
    let finish!: (page: { added: number; hasOlder: boolean }) => void;
    const older = vi.fn(() => new Promise<{ added: number; hasOlder: boolean }>((resolve) => { finish = resolve; }));
    const { pane, again, queryByTestId } = chat({ onOlder: older });
    act(() => {
      scroll(pane.current!, 900);
      scroll(pane.current!, 500);
    });
    // The notice holds back until the page is slow enough to be worth
    // mentioning, so waiting for it is what proves a load is in flight
    // (bw-ad3r.14).
    expect(queryByTestId('older-loading')).toBeNull();
    await act(async () => { await new Promise((done) => setTimeout(done, 500)); });
    expect(queryByTestId('older-loading')).not.toBeNull();

    act(() => again({ sessionId: 'another', rows: rows(40, 'another') }));
    expect(queryByTestId('older-loading')).toBeNull();

    await act(async () => finish({ added: SCREENFUL, hasOlder: true }));
    expect(queryByTestId('older-loading')).toBeNull();
  });

  it('preserves the visible position when older items are prepended', async () => {
    let finish!: (page: { added: number; hasOlder: boolean }) => void;
    const older = vi.fn(() => new Promise<{ added: number; hasOlder: boolean }>((resolve) => { finish = resolve; }));
    const initial = rows(80, 'new');
    const { pane, again } = chat({ rows: initial, onOlder: older });
    growsWithTheTranscript(pane.current!);

    act(() => {
      scroll(pane.current!, 900);
      scroll(pane.current!, 500);
    });
    const before = pane.current!.scrollHeight;
    await act(async () => {
      again({ rows: [...rows(40, 'old'), ...initial] });
      finish({ added: SCREENFUL, hasOlder: true });
    });

    // Down by exactly what was put above him, which is what leaves the words
    // he was reading where they were.
    expect(pane.current!.scrollTop).toBe(500 + (pane.current!.scrollHeight - before));
  });

  /**
   * The reader does not stop scrolling while he waits.
   *
   * A page takes a while to come back, and the wheel goes on turning the whole
   * time. What is put back afterwards has to be measured from where he is by
   * then — measured from where he was when he asked, it throws away every pixel
   * he travelled in between, and that is the jump he sees (bw-cdav.1).
   */
  it('keeps the scrolling the reader did while the page was on its way', async () => {
    let finish!: (page: { added: number; hasOlder: boolean }) => void;
    const older = vi.fn(() => new Promise<{ added: number; hasOlder: boolean }>((resolve) => { finish = resolve; }));
    const initial = rows(80, 'new');
    const { pane, again } = chat({ rows: initial, onOlder: older });
    growsWithTheTranscript(pane.current!);

    act(() => {
      scroll(pane.current!, 900);
      scroll(pane.current!, 500);
    });
    // Still travelling: two hundred more pixels of it before the page lands.
    act(() => scroll(pane.current!, 300));
    const before = pane.current!.scrollHeight;
    await act(async () => {
      again({ rows: [...rows(40, 'old'), ...initial] });
      finish({ added: SCREENFUL, hasOlder: true });
    });

    // From 300, where he had got to — not from the 500 he was at when he asked.
    expect(pane.current!.scrollTop).toBe(300 + (pane.current!.scrollHeight - before));
  });

  it('does not apply an exhausted-page anchor to a later live item', async () => {
    const older = vi.fn().mockResolvedValue({ added: 0, hasOlder: false });
    const initial = rows(80);
    const { pane, again } = chat({ rows: initial, onOlder: older });
    let height = initial.length * 52;
    Object.defineProperty(pane.current!, 'scrollHeight', { configurable: true, get: () => height });
    await act(async () => {
      scroll(pane.current!, 900);
      scroll(pane.current!, 500);
    });
    height += 52;
    again({ rows: [...initial, ...rows(1, 'live')] });
    expect(pane.current!.scrollTop).toBe(500);
  });
});
