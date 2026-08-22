/**
 * The mark on a chat, drawn the same wherever the reader meets it.
 *
 * Two faults the manager photographed, side by side on one screen: the marks on
 * a list row stood shorter than the same marks on the open chat's own line — one
 * point of air around the word against four — so the row read as crammed and
 * sitting high (bw-jaoz.1); and every count of seconds ran past a thousand
 * instead of turning into minutes (bw-jaoz.6).
 *
 * The height is asserted through the size the badge is asked for, because that
 * is the whole of the fault: one screen asked for a smaller badge than the
 * other, and nothing said they had to agree.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatState } from '@/workbench/chat-state';
import { ChatStateChip, ExternalBadge } from '@/workbench/chat-state-chip';

/** The app's own chip height, from the badge's `sm`: 1.25rem of it. */
const NORMAL = 'h-5';
/** And the one step down the rail was drawing, which nothing else uses. */
const SHORTER = 'h-4';

/** A fixed instant, so the seconds a case asserts are the seconds it set. */
const NOW = 1_787_138_400_000;

const working = (since: number): ChatState => ({
  word: 'Working',
  working: true,
  waiting: false,
  doing: 'working',
  detail: null,
  told: false,
  mark: 'working',
  since,
  external: null,
});

/**
 * The chip, that many seconds into a turn.
 *
 * Every chip on a page counts off one clock that speaks once a second, and it
 * has not spoken yet at the moment a case renders: the time is set a second
 * short and the clock let tick, which lands it exactly on `NOW`.
 */
function chipCounting(secondsIn: number): HTMLElement {
  vi.setSystemTime(NOW - 1_000);
  render(<ChatStateChip state={working(NOW - secondsIn * 1_000)} />);
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
  return screen.getByTestId('chat-state');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the marks on a chat row', () => {
  it('stand at the height every other chip in the app stands at', () => {
    render(<ChatStateChip state={working(NOW)} />);
    const chip = screen.getByTestId('chat-state');
    expect(chip.className, 'the rail’s chip is a size of its own again').toContain(NORMAL);
    expect(chip.className).not.toContain(SHORTER);
  });

  it('and so does the badge that says somebody else has the chat', () => {
    render(<ExternalBadge holder="terminal" />);
    const badge = screen.getByTestId('chat-external');
    expect(badge.className).toContain(NORMAL);
    expect(badge.className).not.toContain(SHORTER);
  });
});

describe('how long a chat has been working, on the chip', () => {
  it('turns into minutes rather than counting past a hundred seconds', () => {
    // The number on his screen: a chat one minute forty-nine into a turn.
    const chip = chipCounting(109);
    expect(chip.textContent).toContain('1m 49s');
    expect(chip.textContent, 'the raw count is still there').not.toContain('109s');
  });

  it('says plain seconds while it is still seconds', () => {
    expect(chipCounting(14).textContent).toContain('14s');
  });

  it('drops the seconds once it is hours, where they are noise', () => {
    expect(chipCounting(3_661).textContent).toContain('1h 1m');
  });

  it('counts nothing at all for a chat that is not working', () => {
    render(<ChatStateChip state={{ word: 'Idle', working: false, waiting: false, doing: 'idle', detail: null, told: true, mark: 'ready', since: null, external: null }} />);
    expect(screen.getByTestId('chat-state').textContent).toBe('Idle');
  });
});
