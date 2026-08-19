/**
 * How full the conversation is, and where that figure comes from.
 *
 * The trap is the cache: most of a long conversation arrives as
 * `cache_read_input_tokens`, and a reading that counted only `input_tokens`
 * would show a 180k conversation as 3k right up to the moment the kit compacted
 * it (bw-4wcd.4).
 */
import { describe, expect, it } from 'vitest';

import { fullness, latest, reads, TIGHT, windowOf, WINDOW } from '@/workbench/context-window';

describe('what a turn used', () => {
  it('counts the cached prompt, which is most of a long conversation', () => {
    expect(fullness({ input_tokens: 4, cache_read_input_tokens: 150_000, output_tokens: 900 })).toBe(150_904);
  });

  it('counts what is being written into the cache this turn', () => {
    expect(fullness({ input_tokens: 10, cache_creation_input_tokens: 2_000 })).toBe(2_010);
  });

  it('says nothing when the turn reported nothing', () => {
    expect(fullness({})).toBeNull();
    expect(fullness(null)).toBeNull();
    expect(fullness({ input_tokens: 0 })).toBeNull();
  });
});

describe('the window that turn had', () => {
  it('is the ordinary one unless the model says otherwise', () => {
    expect(windowOf('claude-opus-5')).toBe(WINDOW);
    expect(windowOf(null)).toBe(WINDOW);
  });

  it('is the wide one when the kit spelled it into the name', () => {
    expect(windowOf('claude-sonnet-4-5-20250929[1m]')).toBe(1_000_000);
  });
});

describe('reading it off a chat’s own record', () => {
  const said = (usage: object | null, model = 'claude-opus-5') => ({ message: { usage, model } });

  it('takes the last turn that was answered, not the last line', () => {
    const record = [
      said({ input_tokens: 10, cache_read_input_tokens: 20_000 }),
      said({ input_tokens: 10, cache_read_input_tokens: 90_000 }),
      said(null), // his own words, which spend nothing
    ];
    expect(latest(record)).toEqual({ used: 90_010, window: WINDOW });
  });

  it('says nothing about a conversation nobody has answered yet', () => {
    expect(latest([said(null), said({})])).toBeNull();
    expect(latest([])).toBeNull();
  });

  it('carries the wide window through from the turn that had it', () => {
    expect(latest([said({ input_tokens: 500 }, 'claude-sonnet-4-5[1M]')])).toEqual({
      used: 500,
      window: 1_000_000,
    });
  });
});

describe('how it reads on the line', () => {
  it('is whole thousands, so it does not flicker', () => {
    expect(reads(128_412, 200_000)).toBe('128k/200k');
  });

  it('warns while there is still room to act on the warning', () => {
    expect(TIGHT).toBeLessThan(1);
    expect(160_000 / 200_000).toBeGreaterThanOrEqual(TIGHT);
  });
});
