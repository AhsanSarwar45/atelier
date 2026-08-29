import { describe, expect, it } from 'vitest';

import { CLAUDE_MODEL_CATALOG, claudeModelMenu, claudeModelRows } from '../drivers/claude-models.ts';
import { claudeEffortMenu, type ClaudeModelRow } from '../drivers/claude.ts';

/**
 * What `supportedModels()` actually answers on a current install, copied from
 * the answer itself: six rows, all of them aliases pinned to the latest
 * release. Every numbered version the same install still answers to is missing,
 * which is the whole fault (bw-xtic.2).
 */
const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
const ANNOUNCED: ClaudeModelRow[] = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: FIVE },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: FIVE },
  { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable', description: 'Fable 5 · Most capable for your hardest and longest-running tasks', supportsEffort: true, supportedEffortLevels: FIVE },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks', supportsEffort: true, supportedEffortLevels: FIVE },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
  { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus', description: 'Opus 5 · Best for everyday, complex tasks', supportsEffort: true, supportedEffortLevels: FIVE },
];

describe('the models a Claude chat can be switched to', () => {
  it('offers the aliases the install named before any numbered version', () => {
    const menu = claudeModelMenu(ANNOUNCED);

    expect(menu.slice(0, ANNOUNCED.length).map((row) => row.value)).toEqual(ANNOUNCED.map((row) => row.value));
    expect(menu.slice(0, ANNOUNCED.length).every((row) => row.group === 'alias')).toBe(true);
    expect(menu.slice(ANNOUNCED.length).every((row) => row.group === 'version')).toBe(true);
  });

  it('offers the past Opus versions the install answers to but never advertised', () => {
    const offered = claudeModelMenu(ANNOUNCED).map((row) => row.value);

    for (const version of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5']) {
      expect(offered).toContain(version);
    }
    // The fault, stated as a test: none of them are in what the install said.
    expect(ANNOUNCED.map((row) => row.value)).not.toContain('claude-opus-4-8');
  });

  it('names every version once, however the install spelled its aliases', () => {
    const offered = claudeModelMenu(ANNOUNCED).map((row) => row.value);

    expect(new Set(offered).size).toBe(offered.length);
  });

  it('drops a catalogued version the install named for itself', () => {
    const menu = claudeModelMenu([...ANNOUNCED, { value: 'claude-opus-4-6', displayName: 'Opus 4.6' }]);

    expect(menu.filter((row) => row.value === 'claude-opus-4-6')).toHaveLength(1);
    expect(menu.find((row) => row.value === 'claude-opus-4-6')?.group).toBe('alias');
  });

  it('still lists a model it cannot run, and says why', () => {
    const menu = claudeModelMenu(ANNOUNCED, new Date('2026-08-30T00:00:00Z'));

    expect(menu.find((row) => row.value === 'claude-opus-4-1')?.unavailable).toBe(
      'Reached end of life on 5 August 2026',
    );
    expect(menu.find((row) => row.value === 'claude-mythos-5')?.unavailable).toBe('Project Glasswing only');
  });

  it('leaves every model it can run unmarked', () => {
    const menu = claudeModelMenu(ANNOUNCED, new Date('2026-08-30T00:00:00Z'));
    const runnable = menu.filter((row) => row.unavailable === undefined);

    expect(runnable.map((row) => row.value)).toContain('claude-opus-4-8');
    expect(runnable.map((row) => row.value)).not.toContain('claude-opus-4-1');
  });

  /**
   * The fault: Opus 4 and Sonnet 4 both reached end of life on 15 June 2026 and
   * were still offered as though they worked, because the marking was a
   * sentence somebody typed rather than the date the install itself keeps
   * (bw-xtic.3). Picking either sent the install a model it would refuse.
   */
  describe('a model with a last day', () => {
    const eve = new Date('2026-06-14T23:59:59Z');
    const after = new Date('2026-06-15T00:00:00Z');
    const dated = ['claude-opus-4-0', 'claude-sonnet-4-0'];
    const reason = (at: Date, id: string) =>
      claudeModelMenu(ANNOUNCED, at).find((row) => row.value === id)?.unavailable;

    it('is offered right up to it', () => {
      for (const id of dated) expect(reason(eve, id), id).toBeUndefined();
    });

    it('is shut on the day itself, and says which day that was', () => {
      for (const id of dated) {
        expect(reason(after, id), id).toBe('Reached end of life on 15 June 2026');
      }
    });

    it('stays shut long afterwards, without anyone editing the list', () => {
      for (const id of dated) {
        expect(reason(new Date('2027-03-01T00:00:00Z'), id), id).toBe(
          'Reached end of life on 15 June 2026',
        );
      }
    });

    /** A date still ahead is not a reason: the model answers until it arrives. */
    it('does not shut a model whose day has not come', () => {
      expect(reason(new Date('2026-01-01T00:00:00Z'), 'claude-opus-4-1')).toBeUndefined();
    });
  });

  it('gives a version picked from the lower band its own reasoning levels', () => {
    const rows = claudeModelRows(ANNOUNCED);

    const levels = (id: string) => claudeEffortMenu(rows, id).map((level) => level.value);

    // Read off the install's own register, which refuses `xhigh` before Opus
    // 4.7, `max` before Opus 4.6, and every level to Opus 4.1 and older. Opus
    // 4.5 is refused the top two and keeps the other three (bw-xtic.3).
    expect(levels('claude-opus-4-8')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(levels('claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max']);
    expect(levels('claude-opus-4-5')).toEqual(['low', 'medium', 'high']);
    expect(levels('claude-opus-4-1')).toEqual([]);
  });

  it('would otherwise hand a picked version the first row\'s levels, which is the wrong answer', () => {
    // Without a row of its own, the lookup falls through to `models[0]` — and
    // offers Opus 4.5 the two levels it is the one Opus refused.
    expect(claudeEffortMenu(ANNOUNCED, 'claude-opus-4-5').map((level) => level.value))
      .not.toEqual(['low', 'medium', 'high']);
  });

  it('describes every model it lists', () => {
    for (const entry of CLAUDE_MODEL_CATALOG) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.displayName.length).toBeGreaterThan(0);
    }
  });
});
