/**
 * The one line of git's that goes under a toast's label (bw-8qrr.3).
 *
 * git's answer is several lines long and its first one is regularly the least
 * useful: a failed push opens with where it was going and says what actually
 * went wrong underneath. A toast has room for one line, so picking the wrong
 * one means a toast that says "Push failed" and then tells the reader the
 * address they already knew.
 */
import { describe, expect, it } from 'vitest';

import { howManyFiles, theShortOfIt } from '@/workbench/git-deeds';

describe('the one line of git worth putting in a toast', () => {
  it('skips the address a rejected push opens with and takes the rejection', () => {
    expect(
      theShortOfIt(
        [
          'To github.com:someone/project.git',
          ' ! [rejected]        main -> main (fetch first)',
          "error: failed to push some refs to 'github.com:someone/project.git'",
        ].join('\n'),
      ),
    ).toBe('[rejected]        main -> main (fetch first)');
  });

  it('takes a fatal over the lines above it', () => {
    expect(
      theShortOfIt('Warming up\nfatal: Could not read from remote repository.\nand more'),
    ).toBe('Could not read from remote repository.');
  });

  it('falls back to the first line when git marked nothing', () => {
    expect(theShortOfIt('\n\nEverything up-to-date\n')).toBe('Everything up-to-date');
  });

  it('says something rather than nothing when git said nothing at all', () => {
    expect(theShortOfIt('   \n \n')).toBe('git gave no reason');
  });

  it('cuts a line too long to be a label', () => {
    const said = `fatal: ${'x'.repeat(400)}`;
    const short = theShortOfIt(said);
    expect(short.length).toBeLessThanOrEqual(140);
    expect(short.endsWith('…')).toBe(true);
  });

  it('counts files the way a label does', () => {
    expect(howManyFiles(1)).toBe('1 file');
    expect(howManyFiles(3)).toBe('3 files');
    expect(howManyFiles(0)).toBe('0 files');
  });
});
