import { describe, expect, it } from 'vitest';

import { beadTags, matchesTags, parseLabel, tagFor, tagHue, tagValues } from '@/lib/bead-labels';

const bead = (...labels: string[]) => ({ labels });

describe('parseLabel', () => {
  it('reads a namespaced tag', () => {
    expect(parseLabel('area:board')).toEqual({ namespace: 'area', value: 'board', raw: 'area:board' });
  });

  it('refuses bookkeeping labels and malformed ones', () => {
    for (const label of ['job', 'of:cor-41l', 'step:build', 'area:', ':board', 'size:medium']) {
      expect(parseLabel(label)).toBeNull();
    }
  });
});

describe('beadTags', () => {
  it('returns the system first, then the kind', () => {
    expect(beadTags(bead('kind:bug', 'of:cor-1', 'area:board')).map((t) => t.raw))
      .toEqual(['area:board', 'kind:bug']);
  });

  it('keeps one tag per namespace', () => {
    expect(beadTags(bead('area:board', 'area:camera')).map((t) => t.value)).toEqual(['board']);
  });

  it('is empty for a card with no tags', () => {
    expect(beadTags({})).toEqual([]);
    expect(beadTags(bead('find'))).toEqual([]);
  });
});

describe('tagFor', () => {
  it('answers per namespace', () => {
    expect(tagFor(bead('area:board', 'kind:bug'), 'kind')?.value).toBe('bug');
    expect(tagFor(bead('area:board'), 'kind')).toBeNull();
  });
});

describe('tagValues', () => {
  it('collects the values seen for one namespace, sorted and deduplicated', () => {
    const beads = [bead('area:board', 'kind:bug'), bead('area:camera'), bead('area:board')];
    expect(tagValues(beads, 'area')).toEqual(['board', 'camera']);
    expect(tagValues(beads, 'kind')).toEqual(['bug']);
  });
});

describe('matchesTags', () => {
  const card = bead('area:board', 'kind:bug');

  it('passes everything when nothing is picked', () => {
    expect(matchesTags(bead(), [])).toBe(true);
  });

  it('widens inside one namespace', () => {
    expect(matchesTags(card, ['area:board', 'area:camera'])).toBe(true);
    expect(matchesTags(card, ['area:camera', 'area:sky'])).toBe(false);
  });

  it('narrows across namespaces', () => {
    expect(matchesTags(card, ['area:board', 'kind:bug'])).toBe(true);
    expect(matchesTags(card, ['area:board', 'kind:feature'])).toBe(false);
  });

  it('drops a card that carries no tag at all', () => {
    expect(matchesTags(bead('find'), ['area:board'])).toBe(false);
  });

  it('ignores a picked label that is not a drawn tag', () => {
    expect(matchesTags(card, ['job'])).toBe(true);
  });
});

describe('tagHue', () => {
  const tag = (raw: string) => parseLabel(raw)!;

  it('gives one system the same hue every time', () => {
    expect(tagHue(tag('area:board'))).toBe(tagHue(tag('area:board')));
  });

  it('tells the kinds apart', () => {
    const hues = ['kind:bug', 'kind:feature', 'kind:chore'].map((raw) => tagHue(tag(raw)));
    expect(new Set(hues).size).toBe(3);
  });

  it('stays inside the colour wheel for a system it has never seen', () => {
    const hue = tagHue(tag('area:a-system-invented-here'));
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });
});
