/**
 * The panel's own arithmetic: what a number reads as, how the bar is cut, and
 * the sentence that tells the two figures apart.
 *
 * The trap the last two guard is the whole reason the panel exists: a share
 * rounded down to "0%" says a row does not matter, and a reader who takes the
 * window gauge for the task's cost is out by three orders of magnitude
 * (bw-3ug7.4).
 */
import { describe, expect, it } from 'vitest';

import { SPENT_NOTHING, type TaskSpend } from '@/workbench/token-picture';
import { big, pct, resetLine, splitRows, stripesOf } from '@/workbench/token-view';
import type { WindowNow } from '@/workbench/window-now';

const window = (over: Partial<WindowNow> = {}): WindowNow => ({
  model: 'claude-opus-5',
  used: 128_000,
  window: 200_000,
  free: 72_000,
  percent: 64,
  forgetsAt: 160_000,
  pieces: [
    { name: 'Messages', tokens: 100_000, share: 0.5 },
    { name: 'System tools', tokens: 28_000, share: 0.14 },
  ],
  spare: [],
  waiting: [],
  inside: null,
  memory: [],
  servers: [],
  ...over,
});

describe('reading a number out loud', () => {
  it('shortens to the scale a reader compares at', () => {
    expect([big(0), big(940), big(128_000), big(1_200_000), big(531_313_155)]).toEqual([
      '0',
      '940',
      '128k',
      '1.2M',
      '531M',
    ]);
  });

  it('never rounds a real share down to nothing', () => {
    // 0% beside 4,000 tokens is a different claim from "small", and the memory
    // files this panel exists to point at are exactly that size.
    expect(pct(400, 200_000)).toBe('<1%');
    expect(pct(0, 200_000)).toBe('0%');
    expect(pct(100_000, 200_000)).toBe('50%');
    expect(pct(5, 0)).toBe('—');
  });
});

describe('the window as one bar', () => {
  it('draws every filled band and then the room left', () => {
    expect(stripesOf(window()).map((s) => [s.name, s.tokens, Math.round(s.width), s.room])).toEqual([
      ['Messages', 100_000, 50, false],
      ['System tools', 28_000, 14, false],
      ['Room left', 72_000, 36, true],
    ]);
  });

  it('adds to the whole window, so the bar is never short of its own end', () => {
    const bar = stripesOf(window());
    expect(bar.reduce((sum, s) => sum + s.width, 0)).toBeCloseTo(100, 5);
  });

  it('has no room segment at all when the window is full', () => {
    const bar = stripesOf(window({ used: 200_000, free: 0 }));
    expect(bar.some((s) => s.room)).toBe(false);
  });
});

describe('what a turn is billed for', () => {
  it('leads on the read-back, which is what a long task actually costs', () => {
    const rows = splitRows({ input: 1, cacheWrite: 2, cacheRead: 3, output: 4, thinking: 1, total: 10 });
    expect(rows.map((r) => [r.key, r.tokens])).toEqual([
      ['read', 3],
      ['kept', 2],
      ['sent', 1],
      ['written', 4],
    ]);
  });
});

describe('saying which number resets', () => {
  const spent = (forgettings: number): TaskSpend => ({ ...SPENT_NOTHING, forgettings });

  it('names the times this chat has forgotten itself', () => {
    expect(resetLine(spent(12))).toContain('12 times');
    expect(resetLine(spent(1))).toContain('once');
    expect(resetLine(spent(0))).toContain('has not yet');
  });

  it('still says which of the two resets when there is no record to count', () => {
    expect(resetLine(null)).toContain('never resets');
  });

  it('points at no window when there is no window drawn above it', () => {
    expect(resetLine(spent(0), false)).not.toContain('above');
    expect(resetLine(spent(0), false)).toContain('never resets');
    expect(resetLine(spent(0), true)).toContain('The window above');
  });
});
