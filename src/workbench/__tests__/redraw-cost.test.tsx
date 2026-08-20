/**
 * A conversation costs what changed, not what it holds.
 *
 * Every row of a chat was built inline in the chat itself, so one arriving word
 * parsed the markdown of all two hundred messages again, coloured every diff
 * again, and did it once a second on top of that for as long as the agent was
 * busy. The rows are their own remembered components now, and the busy clock
 * lives in the one line that shows it — so the price of a word is one row
 * (bw-uiyz.5).
 *
 * The two probes are the two expensive things themselves: the markdown renderer
 * and the syntax colourer. Nothing else can tell you a row was rebuilt.
 */
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import type { ImagePayload, WbpEvent } from '@/workbench/protocol';
import { TranscriptRow, WorkingLine } from '@/workbench/transcript-rows';
import { EMPTY, reduce, type SessionView } from '@/workbench/use-session';

/** Every message body written out, in order. */
const written: string[] = [];
vi.mock('@/components/markdown-body', () => ({
  MarkdownBody: ({ children }: { children: string }) => {
    written.push(children);
    return <div data-testid="markdown">{children}</div>;
  },
}));

/** Every piece of text put through the colourer. */
const painted: string[] = [];
vi.mock('@/workbench/colouring', async (real) => {
  const kit = await real<typeof import('@/workbench/colouring')>();
  return {
    ...kit,
    paint: (text: string, language: string | null) => {
      painted.push(text);
      return kit.paint(text, language);
    },
    paintLines: (text: string, language: string | null) => {
      painted.push(text);
      return kit.paintLines(text, language);
    },
  };
});

const HELD = 200;

const MENTIONS: Mentions = { split: (text) => [{ kind: 'text', text }], card: (id) => id, report: (slug) => slug };
const LOOK = (_image: ImagePayload) => {};

/** One event without the envelope the wire wraps it in. */
type Said<T> = T extends unknown ? Omit<T, 'seq' | 'sessionId' | 'at'> : never;

let seq = 0;
function fold(view: SessionView, event: Said<WbpEvent>): SessionView {
  seq += 1;
  return reduce(view, { ...event, seq, sessionId: 's', at: '' } as WbpEvent);
}

/** A conversation of `HELD` finished messages, folded the way the wire folds it. */
function conversation(): SessionView {
  let view = EMPTY;
  for (let i = 0; i < HELD; i += 1) {
    const messageId = `m${i}`;
    view = fold(view, { type: 'message.started', messageId, role: i % 2 ? 'assistant' : 'user' });
    view = fold(view, { type: 'text.delta', messageId, text: `message ${i}` });
    view = fold(view, { type: 'message.completed', messageId });
  }
  return view;
}

/** How many times the chat around the rows was built. */
let chatDraws = 0;

/** The same shape the chat draws: the rows, and the working line under them. */
function Chat({ view, busy, since }: { view: SessionView; busy: boolean; since: number | null }) {
  chatDraws += 1;
  return (
    <div>
      {view.items.map((item) => (
        <TranscriptRow key={item.id} item={item} sessionId="s" mentions={MENTIONS} onLook={LOOK} />
      ))}
      {busy && <WorkingLine label="Thinking" since={since} reported={0} waiting={false} thought={0} />}
    </div>
  );
}

beforeEach(() => {
  written.length = 0;
  painted.length = 0;
  chatDraws = 0;
  seq = 0;
});

describe('what one arriving word costs', () => {
  it('draws one message row, not the whole conversation', () => {
    let view = conversation();
    const { rerender } = render(<Chat view={view} busy={false} since={null} />);
    expect(written).toHaveLength(HELD);

    written.length = 0;
    view = fold(view, { type: 'text.delta', messageId: `m${HELD - 1}`, text: ' more' });
    rerender(<Chat view={view} busy={false} since={null} />);

    expect(written).toEqual([`message ${HELD - 1} more`]);
  });

  it('colours only the diff that arrived', () => {
    let view = conversation();
    for (let i = 0; i < 20; i += 1) {
      const toolCallId = `t${i}`;
      view = fold(view, {
        type: 'tool.started',
        toolCallId,
        name: 'Edit',
        input: { file_path: `a${i}.ts` },
        title: `Edit a${i}.ts`,
        parentToolCallId: null,
      });
      view = fold(view, { type: 'diff', toolCallId, path: `a${i}.ts`, before: 'const a = 1;', after: 'const a = 2;' });
    }
    const { rerender } = render(<Chat view={view} busy={false} since={null} />);
    expect(painted.length).toBeGreaterThan(0);

    painted.length = 0;
    view = fold(view, {
      type: 'tool.started',
      toolCallId: 'fresh',
      name: 'Edit',
      input: { file_path: 'fresh.ts' },
      title: 'Edit fresh.ts',
      parentToolCallId: null,
    });
    view = fold(view, { type: 'diff', toolCallId: 'fresh', path: 'fresh.ts', before: 'let x = 1;', after: 'let x = 2;' });
    rerender(<Chat view={view} busy={false} since={null} />);

    // One diff, painted whole on each side, and nothing else on the page.
    expect(painted).toEqual(['let x = 1;', 'let x = 2;']);
  });
});

describe('what the busy clock costs', () => {
  it('moves its own count and draws no message at all', () => {
    vi.useFakeTimers();
    try {
      const view = conversation();
      render(<Chat view={view} busy since={Date.now()} />);
      written.length = 0;
      painted.length = 0;

      act(() => {
        vi.advanceTimersByTime(5000);
      });

      expect(screen.getByTestId('working-elapsed').textContent).toBe('5s');
      // The count moved and nothing above the line was built again: the beat
      // belongs to the line, not to the conversation around it.
      expect(chatDraws).toBe(1);
      expect(written).toHaveLength(0);
      expect(painted).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
