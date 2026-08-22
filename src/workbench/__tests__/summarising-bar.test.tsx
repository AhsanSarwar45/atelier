/**
 * The bar a summarising chat draws (bw-jaoz.14.5).
 *
 * The manager's photograph again: a chat two minutes into summarising itself,
 * drawing a stale command card and a clock counting up, with nothing on the
 * screen saying how much of it was left. Summarising is the only state whose
 * length we can predict — 453 runs recorded on this machine — so it is the only
 * state that gets a bar, and the bar must be honest about the half of runs that
 * are longer than the middle one.
 *
 * Both halves are pinned: the arithmetic, and the bar the arithmetic draws,
 * because "drawn" and "not drawn" are facts about the screen.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { chatState } from '@/workbench/chat-state';
import type { Doing } from '@/workbench/chat-state';
import { SUMMARY_HELD_AT, SUMMARY_TYPICAL_MS, summaryFill, summaryOverrun } from '@/workbench/summarising';
import { WorkingLine } from '@/workbench/transcript-rows';
import { workingLine } from '@/workbench/working-line';

describe('how full the bar is', () => {
  it('starts empty, so the first look says nothing has happened yet', () => {
    expect(summaryFill(0)).toBe(0);
    expect(summaryFill(-1_000), 'a clock read backwards is not progress').toBe(0);
  });

  it('fills against the middle of the runs measured on this machine', () => {
    expect(summaryFill(SUMMARY_TYPICAL_MS / 2)).toBeCloseTo(SUMMARY_HELD_AT / 2, 5);
  });

  it('arrives at its hold exactly when a typical run would finish', () => {
    expect(summaryFill(SUMMARY_TYPICAL_MS)).toBe(SUMMARY_HELD_AT);
  });

  it('never claims the last of it, however long the run goes on', () => {
    // Half of all runs are longer than the median. A bar that reached the end
    // and sat there would say finished while the work went on.
    expect(summaryFill(SUMMARY_TYPICAL_MS * 10)).toBe(SUMMARY_HELD_AT);
    expect(summaryFill(SUMMARY_TYPICAL_MS * 10)).toBeLessThan(1);
    expect(summaryOverrun(SUMMARY_TYPICAL_MS - 1)).toBe(false);
    expect(summaryOverrun(SUMMARY_TYPICAL_MS)).toBe(true);
  });

  it('takes a measured length from a caller that has one', () => {
    // A slower machine, or a longer conversation: same shape, different scale.
    expect(summaryFill(30_000, 60_000)).toBeCloseTo(SUMMARY_HELD_AT / 2, 5);
    // And an estimate of nothing holds rather than dividing by zero.
    expect(summaryFill(1_000, 0)).toBe(SUMMARY_HELD_AT);
  });
});

/** The foot of a chat a terminal holds, doing whatever the case says. */
function foot(doing: Doing, sinceMs: number) {
  const now = Date.now();
  const read = chatState({
    state: 'dormant',
    held: { id: 'ef56704b', holder: 'terminal', doing, since: now - sinceMs, turnSince: null },
  });
  const line = workingLine({ busy: false, label: 'Ready', since: null, waiting: false, thought: 0, state: read, running: null });
  render(<div>{line && <WorkingLine {...line} />}</div>);
  return screen.queryByTestId('summarising-bar');
}

describe('the bar on the screen', () => {
  it('is there from the start of a summarising run, and reads as barely begun', () => {
    const bar = foot('summarising', 2_000);
    expect(bar, 'the one state with nothing else to look at').not.toBeNull();
    expect(Number(bar?.getAttribute('data-fill'))).toBeLessThan(5);
    expect(bar?.getAttribute('data-held')).toBe('false');
  });

  it('is most of the way across in the middle of one', () => {
    const bar = foot('summarising', SUMMARY_TYPICAL_MS / 2);
    expect(Number(bar?.getAttribute('data-fill'))).toBe(48);
  });

  it('holds at ninety-five past the estimate, and says it is holding', () => {
    const bar = foot('summarising', SUMMARY_TYPICAL_MS * 3);
    expect(bar?.getAttribute('data-fill')).toBe('95');
    expect(bar?.getAttribute('data-held'), 'the last of it belongs to the finish').toBe('true');
  });

  it('is gone the moment the run finishes, because the state it belongs to has', () => {
    // The finish is not the bar reaching the end — it is a different state, and
    // this one takes its bar with it.
    expect(foot('thinking', SUMMARY_TYPICAL_MS), 'a think has no predictable length to fill against').toBeNull();
    expect(foot('idle', 0), 'and a finished chat draws no line at all').toBeNull();
  });

  it('leaves the clock beside the word alone: the bar is the second thing said', () => {
    foot('summarising', 40_000);
    expect(screen.getByTestId('working-line').textContent).toContain('Summarising');
    expect(screen.getByTestId('working-elapsed').textContent).toBe('40s');
  });
});
