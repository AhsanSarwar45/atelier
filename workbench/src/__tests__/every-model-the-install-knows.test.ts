import { describe, expect, it } from 'vitest';

import {
  CLAUDE_MODEL_CATALOG,
  claudeModelMenu,
  claudeModelRows,
  describeModel,
  perMtok,
} from '../drivers/claude-models.ts';
import { claudeEffortMenu, type ClaudeModelRow } from '../drivers/claude.ts';

/**
 * What `supportedModels()` actually answers on a current install — four rows,
 * every one an alias pinned to the latest release, copied from the menu a real
 * 2.1.250 session published (`tests/e2e` writes it into `workbench.db`).
 * Every numbered version the same install still answers to is missing, which is
 * the whole fault (bw-xtic.2).
 *
 * The descriptions carry their own rate, run into the end of the sentence after
 * a `·`. That is the install's doing, not ours: 2.1.250 prices its aliases
 * before it hands them over. An earlier version of this fixture left the rate
 * off and so tested a row no install ever sends — the menu on screen disagreed
 * with a green suite until it was copied honestly (bw-xtic.10).
 */
const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
const ANNOUNCED: ClaudeModelRow[] = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5 (1M context)) · $5/$25 per Mtok', supportsEffort: true, supportedEffortLevels: FIVE },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5 with 1M context · Best for everyday, complex tasks · $5/$25 per Mtok', supportsEffort: true, supportedEffortLevels: FIVE },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks · $2/$10 per Mtok', supportsEffort: true, supportedEffortLevels: FIVE },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok' },
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

  /**
   * The fault: every version's line was prose somebody wrote — 'The Opus before
   * 4.8', 'Older Opus, still served' — and the install's register holds no
   * description text at all, so none of it was sourced from anything. The line
   * is now composed from the three facts the register does keep, which is also
   * where the price asked for comes from (bw-xtic.5).
   */
  describe('what a version says about itself', () => {
    const hint = (id: string) =>
      claudeModelMenu(ANNOUNCED).find((row) => row.value === id)?.description;

    it('is the register\'s own window, rate and cutoff, and nothing else', () => {
      expect(hint('claude-opus-4-8')).toBe('1M context · Knowledge to January 2026\n$5/$25 per Mtok');
      expect(hint('claude-opus-4-5')).toBe('200K context · Knowledge to May 2025\n$5/$25 per Mtok');
      expect(hint('claude-haiku-4-5')).toBe('200K context · Knowledge to February 2025\n$1/$5 per Mtok');
    });

    /**
     * The rate is broken onto its own line rather than left to wrap there, so
     * no row opens a line on the separator it happened to break at
     * (bw-xtic.10). Nothing before the break may carry one either.
     */
    it('gives the rate a line of its own, and breaks nowhere else', () => {
      for (const entry of CLAUDE_MODEL_CATALOG) {
        const lines = describeModel(entry).split('\n');

        expect(lines, entry.id).toHaveLength(2);
        expect(lines[1], entry.id).toBe(perMtok(entry));
        expect(lines[1].startsWith('·'), entry.id).toBe(false);
      }
    });

    it('is written the same way for every model, so none can carry an opinion', () => {
      const shape = /^(1M|200K) context · Knowledge to [A-Z][a-z]+ \d{4}\n\$[\d.]+\/\$[\d.]+ per Mtok$/;

      for (const entry of CLAUDE_MODEL_CATALOG) {
        expect(describeModel(entry), entry.id).toMatch(shape);
        expect(entry.displayName.length, entry.id).toBeGreaterThan(0);
      }
    });

    /**
     * The dearest and the cheapest the install serves, so a tier written into
     * the wrong row is caught rather than averaged away.
     */
    it('charges what the register charges', () => {
      const rate = (id: string) => perMtok(CLAUDE_MODEL_CATALOG.find((e) => e.id === id)!);

      expect(rate('claude-opus-4-1')).toBe('$15/$75 per Mtok');
      expect(rate('claude-fable-5')).toBe('$10/$50 per Mtok');
      expect(rate('claude-sonnet-5')).toBe('$2/$10 per Mtok');
      expect(rate('claude-haiku-4-5')).toBe('$1/$5 per Mtok');
    });
  });

  /**
   * An alias is the install's own row, so its words stay. Its rate is the
   * install's too — written into the end of the sentence — and all we do is
   * give it the line of its own the versions have, so the two bands read alike.
   */
  describe('what an alias says about itself', () => {
    const hint = (value: string) =>
      claudeModelMenu(ANNOUNCED).find((row) => row.value === value)?.description;

    it('keeps the install\'s words and lifts its rate onto a line of its own', () => {
      expect(hint('opus[1m]')).toBe(
        'Opus 5 with 1M context · Best for everyday, complex tasks\n$5/$25 per Mtok',
      );
      expect(hint('haiku')).toBe('Haiku 4.5 · Fastest for quick answers\n$1/$5 per Mtok');
    });

    it('gives every alias a rate, on its own line, exactly once', () => {
      for (const row of ANNOUNCED) {
        const said = hint(row.value) ?? '';

        expect(said, row.value).toMatch(/\n\$[\d.]+\/\$[\d.]+ per Mtok$/);
        expect(said.match(/per Mtok/g)?.length, row.value).toBe(1);
        // Lifted, not restated: the sentence no longer runs into its own rate.
        expect(said, row.value).not.toMatch(/ · \$[\d.]+\/\$/);
      }
    });

    /**
     * An install that stops pricing its aliases — or prices them only for some
     * accounts, which 2.1.250 does behind a flag — still gets a rate, from the
     * catalogue, in the same place.
     */
    it('prices an alias the install left unpriced', () => {
      const menu = claudeModelMenu([
        // `claude-haiku-4-5-20251001` — a dated build, which is not a catalogue id.
        { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
      ]);

      expect(menu[0].description).toBe('Haiku 4.5 · Fastest for quick answers\n$1/$5 per Mtok');
    });

    it('leaves an alias alone rather than pricing it from nothing', () => {
      const menu = claudeModelMenu([
        { value: 'sonnet', resolvedModel: 'claude-sonnet-9', displayName: 'Sonnet', description: 'Something new' },
      ]);

      expect(menu[0].description).toBe('Something new');
    });
  });
});
