/**
 * The transcript is two independent windows: storage retains every loaded
 * forty-item page, while the DOM contains only what is on screen plus
 * overscan. History moves only when the reader moves upward near its head.
 */
import { act, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
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
  sessionId?: string;
  onOlder?: (() => Promise<{ added: number; hasOlder: boolean }>) | null;
} = {}) {
  const pane = createRef<HTMLDivElement>();
  let currentRows = given.rows ?? rows(400);
  let currentSession = given.sessionId ?? 's';
  const show = () => (
    <div ref={pane} data-testid="pane">
      <DrawnTranscript
        rows={currentRows}
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
  const again = (next: { rows?: DrawnRow[]; sessionId?: string }) => {
    currentRows = next.rows ?? currentRows;
    currentSession = next.sessionId ?? currentSession;
    drawn.rerender(show());
  };
  return { ...drawn, pane, again };
}

function scroll(box: HTMLElement, top: number): void {
  box.scrollTop = top;
  box.dispatchEvent(new Event('scroll'));
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

  it('drops an older-history loader and ignores its stale completion when the chat changes', async () => {
    let finish!: (page: { added: number; hasOlder: boolean }) => void;
    const older = vi.fn(() => new Promise<{ added: number; hasOlder: boolean }>((resolve) => { finish = resolve; }));
    const { pane, again, queryByTestId } = chat({ onOlder: older });
    act(() => {
      scroll(pane.current!, 900);
      scroll(pane.current!, 500);
    });
    expect(queryByTestId('older-loading')).not.toBeNull();

    act(() => again({ sessionId: 'another', rows: rows(40, 'another') }));
    expect(queryByTestId('older-loading')).toBeNull();

    await act(async () => finish({ added: SCREENFUL, hasOlder: true }));
    expect(queryByTestId('older-loading')).toBeNull();
  });

  it('preserves the visible position when older items are prepended', async () => {
    let height = 80 * 52;
    let finish!: (page: { added: number; hasOlder: boolean }) => void;
    const older = vi.fn(() => new Promise<{ added: number; hasOlder: boolean }>((resolve) => { finish = resolve; }));
    const initial = rows(80, 'new');
    const { pane, again } = chat({ rows: initial, onOlder: older });
    Object.defineProperty(pane.current!, 'scrollHeight', { configurable: true, get: () => height });

    act(() => {
      scroll(pane.current!, 900);
      scroll(pane.current!, 500);
    });
    height = 120 * 52;
    await act(async () => {
      again({ rows: [...rows(40, 'old'), ...initial] });
      finish({ added: SCREENFUL, hasOlder: true });
    });

    expect(pane.current!.scrollTop).toBe(500 + 40 * 52);
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
