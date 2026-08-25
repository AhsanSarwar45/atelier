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
  turnSince: null,
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
    render(<ChatStateChip state={{ word: 'Idle', working: false, waiting: false, doing: 'idle', detail: null, told: true, mark: 'ready', since: null, turnSince: null, external: null }} />);
    expect(screen.getByTestId('chat-state').textContent).toBe('Idle');
  });
});

/**
 * What the chat is on, when it is longer than the line it has.
 *
 * The manager, 2026-08-25, photographing the list down the side: "ing for
 * NothingShowing|KindFilter in workbench/chat-". Both ends of it gone, because
 * the browser only ever cuts at the end and everything else on that line
 * refused to give way. What he asked for was a cut in the middle, with the mark
 * and the counter always on screen (bw-gnzl).
 */
describe('what a chat is on, when it runs longer than the line', () => {
  /** The clause itself, off a chip carrying that detail and nothing unusual. */
  function clauseOn(detail: string): HTMLElement {
    render(<ChatStateChip state={{ ...working(NOW), detail }} testId="chip" />);
    return screen.getByTestId('chip').querySelector('[data-testid="chat-state-detail"]')!;
  }

  it('cuts in the middle, and pins the end of the path', () => {
    const pieces = Array.from(clauseOn('for NothingShowing|KindFilter in workbench/chat-sidebar.tsx').children);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].textContent).toBe('· for NothingShowing|KindFilter in workbench');
    expect(pieces[1].textContent, 'the file being searched went over the edge').toBe('/chat-sidebar.tsx');
  });

  it('pins the last word where there is no path in it', () => {
    const pieces = Array.from(clauseOn('waiting on the five-hour limit to lift').children);
    expect(pieces).toHaveLength(2);
    expect(pieces[1].textContent, 'the space at the seam was thrown away with it').toBe(' lift');
  });

  it('leaves a short one whole, in one piece', () => {
    const clause = clauseOn('auto');
    expect(clause.children, 'a clause that already fits was split for nothing').toHaveLength(1);
    expect(clause.textContent).toBe('· auto');
  });

  it('loses nothing on the way: the two halves are what came in', () => {
    const said = 'for NothingShowing|KindFilter in workbench/chat-sidebar.tsx';
    expect(clauseOn(said).textContent).toBe(`· ${said}`);
  });

  it('leaves the one piece that gives way as the only one that can', () => {
    render(<ChatStateChip state={{ ...working(NOW), detail: 'for a name in a folder/deep/inside.tsx' }} testId="chip" />);
    const chip = screen.getByTestId('chip');

    // The mark, the word and the counter hold their room whatever happens to
    // the line; the head of the clause is the whole of what shrinks. That is
    // what stops the chip overflowing an edge that hides whatever crosses it.
    const classes = (el: Element) => el.getAttribute('class') ?? '';
    expect(classes(chip.querySelector('[data-testid="chat-state-mark"]')!)).toContain('shrink-0');
    expect(classes(chip.querySelector('[data-testid="chat-state-count"]')!)).toContain('shrink-0');
    const clause = chip.querySelector('[data-testid="chat-state-detail"]')!;
    expect(classes(clause)).toContain('min-w-0');
    expect(classes(clause.children[0])).toContain('truncate');
    // Nearly pinned rather than pinned: a tail that cannot give way at all is a
    // fixed width the rest of the line must find room for, and it was the head
    // that went to nothing when it could not.
    expect(classes(clause.children[1])).toContain('shrink-[0.12]');
    // And clipped, so a tail with nowhere left to go cannot be drawn over the
    // counter beside it.
    expect(classes(clause)).toContain('overflow-hidden');
  });

  it('packs the chip to its front, so nothing that will not fit goes off it', () => {
    render(<ChatStateChip state={{ ...working(NOW), detail: 'for a name in a folder/deep/inside.tsx' }} testId="chip" />);
    // The whole of the both-ends cut the manager photographed: a centred box
    // spreads what will not fit over BOTH its edges, so the mark went off the
    // front and the counter off the back, and the row's `overflow-hidden` hid
    // them. Packed to the start, an overflow can only ever go off the end.
    expect(screen.getByTestId('chip').getAttribute('class') ?? '').toContain('justify-start');
  });
});
