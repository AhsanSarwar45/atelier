/**
 * The searching and the reading of times, which are the whole of what this
 * panel decides for itself. What it does with a command once one is picked is
 * the terminal's, and is proved in a browser against a real shell
 * (`tests/e2e/terminal.spec.ts`).
 */
import { describe, expect, it } from 'vitest';

import { found, matches, whenAgo, type Ran } from '../terminal-history';

const ran = (command: string, at: number | null = null): Ran => ({ command, at });

describe('searching what has been run before', () => {
  it('wants every word, in any order and anywhere in the line', () => {
    expect(matches('git branch -a', 'git br')).toBe(true);
    expect(matches('git branch -a', 'br git')).toBe(true);
    expect(matches('git branch -a', 'branch')).toBe(true);
    expect(matches('git branch -a', 'git tag')).toBe(false);
  });

  it('ignores case, because nobody searches with the shift key', () => {
    expect(matches('CARGO_LOG=debug cargo test', 'cargo LOG')).toBe(true);
  });

  it('finds everything when nothing has been typed yet', () => {
    // The panel opens showing the most recent commands rather than an empty
    // box: what you ran an hour ago is the likeliest thing you are after.
    expect(matches('anything at all', '')).toBe(true);
    expect(matches('anything at all', '   ')).toBe(true);
  });

  it('matches on the whole word and not on its letters scattered through', () => {
    // The reason this is substring and not fuzzy: a list that answered `rm`
    // with `cargo remove` is a list that puts the wrong line on a prompt.
    expect(matches('cargo remove serde', 'rm')).toBe(false);
    expect(matches('rm -rf build', 'rm')).toBe(true);
  });

  it('keeps the order it was given, which is newest first', () => {
    const rows = found([ran('git push'), ran('git status'), ran('git log')], 'git');
    expect(rows.map((row) => row.command)).toEqual(['git push', 'git status', 'git log']);
  });

  it('draws no more than fifty, however many match', () => {
    const many = Array.from({ length: 500 }, (_, index) => ran(`echo ${index}`));
    expect(found(many, 'echo')).toHaveLength(50);
    // And the fifty are the first fifty, which are the newest fifty.
    expect(found(many, 'echo')[0].command).toBe('echo 0');
  });
});

describe('how long ago a command was run', () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const secondsAgo = (seconds: number) => Math.round(now / 1000) - seconds;

  it('says nothing at all when the shell did not write a time down', () => {
    // bash only records times if the person asked for them, so this is the
    // common case and not the odd one.
    expect(whenAgo(null, now)).toBeNull();
  });

  it('climbs through the units as it goes back', () => {
    expect(whenAgo(secondsAgo(5), now)).toBe('just now');
    expect(whenAgo(secondsAgo(120), now)).toBe('2m ago');
    expect(whenAgo(secondsAgo(3 * 3600), now)).toBe('3h ago');
    expect(whenAgo(secondsAgo(4 * 86400), now)).toBe('4d ago');
    expect(whenAgo(secondsAgo(800 * 86400), now)).toBe('2y ago');
  });

  it('does not report a command from the future as a time gone by', () => {
    // A history file written by a machine whose clock has since been put back
    // is a real thing, and "-3m ago" is not something to draw on a screen.
    expect(whenAgo(secondsAgo(-600), now)).toBe('just now');
  });
});
