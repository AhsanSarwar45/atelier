/**
 * What the line above a conversation says the chat is running (bw-ja9l.1).
 *
 * It said it in the tool's own spelling — `claude · claude-opus-5 · permission
 * mode: bypassPermissions`, as one run of grey text — an inch from a picker
 * that calls that same setting "Skip all checks". A reader cannot be asked to
 * hold two names for one thing, and the one name here that MUST be read is the
 * mode: a chat that has quietly stopped asking before it runs things is a trap
 * and grey text an inch long is how it hid (docs/agent-workbench.md §8.2.4).
 *
 * So: the words come off the same table the picker reads, a mode the kit
 * invents after this release still arrives in English, the mode that stops
 * asking is loud, and a chat whose record says nothing draws nothing rather
 * than a badge guessing on its behalf.
 *
 * The last case is about width and not about words. This group is the one thing
 * on that line allowed to give way, and the folder chip beside it is the one
 * thing that must not: left to itself the group kept its full width and the
 * chips inside shrank under their own words, so what the chat was running
 * printed straight across the folder's name (bw-7ks.22.15).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ModelChoice } from '@/workbench/protocol';
import { CHIP_GAP, modelKey, modelName, WhatItRuns } from '@/workbench/what-it-runs';

/** The picker's own list, as a chat this app drives announces it. */
const MENU: ModelChoice[] = [
  { value: 'default', displayName: 'Default (recommended)' },
  { value: 'opus', displayName: 'Opus 5', description: 'The heavy one' },
  { value: 'sonnet', displayName: 'Sonnet 5' },
];

/** A chat nothing here is driving announces no list at all. */
const NO_MENU: ModelChoice[] = [];

const draw = (model: string | null, mode: string | null, models = MENU) =>
  render(<WhatItRuns model={model} permissionMode={mode} models={models} />);

const modeChip = () => screen.queryByTestId('chat-mode-chip');
const modelChip = () => screen.queryByTestId('chat-model-chip');

/**
 * Everything a reader can actually see: the words on the line and the words a
 * hover produces. The `data-` attributes are how the screen tests name a mode
 * without reading English at it, and nobody sees them.
 */
function readable(): string {
  const group = screen.getByTestId('session-meta');
  const titles = Array.from(group.querySelectorAll('[title]'), (el) => el.getAttribute('title') ?? '');
  return [group.textContent ?? '', ...titles].join(' | ');
}

describe('what the chat is running, on its own line', () => {
  it('names the mode in the picker’s words and never in the setting’s', () => {
    draw('opus', 'bypassPermissions');

    expect(modeChip()?.textContent).toBe('Skip all checks');
    // The whole point: the wire word is nowhere a reader can see it.
    expect(readable()).not.toContain('bypassPermissions');
  });

  it('draws every mode the kit ships today in words', () => {
    for (const [wire, said] of [
      ['default', 'Ask first'],
      ['acceptEdits', 'Edit freely'],
      ['plan', 'Plan only'],
      ['dontAsk', 'Do not ask'],
      ['auto', 'Automatic'],
      ['bypassPermissions', 'Skip all checks'],
    ] as const) {
      const { unmount } = draw('opus', wire);
      expect(modeChip()?.textContent, `${wire} is drawn as itself`).toBe(said);
      unmount();
    }
  });

  it('draws a mode invented after this release in English rather than in camel case', () => {
    // The kit adds modes between our releases. The choice is the wire word, or
    // nothing, or the same word with its seams opened up (machine-words.ts).
    draw('opus', 'askAboutEverythingTwice');

    expect(modeChip()?.textContent).toBe('Ask about everything twice');
    expect(readable()).not.toContain('askAboutEverythingTwice');
  });

  it('says loudly that a chat has stopped asking, and quietly that it still does', () => {
    const { unmount } = draw('opus', 'bypassPermissions');
    expect(modeChip()?.getAttribute('data-tone')).toBe('destructive');
    unmount();

    draw('opus', 'default');
    expect(modeChip()?.getAttribute('data-tone')).toBe('secondary');
  });

  it('names the model the way the picker beside it names it', () => {
    draw('opus', 'default');

    expect(modelChip()?.textContent).toBe('Opus 5');
  });

  it('still names the model of a chat that announced no picker list', () => {
    // A chat begun in a terminal has nothing driving it, so nothing published a
    // list of models; its own record answers with the wire id (bw-ja9l.2).
    draw('claude-opus-5', 'bypassPermissions', NO_MENU);

    expect(modelChip()?.textContent).toBe('Opus 5');
    expect(modeChip()?.textContent).toBe('Skip all checks');
  });

  it('names the long-context build the way the terminal names it', () => {
    // The chip said `Claude opus 5[1m]` and the picker an inch below it said
    // `claude-opus-5[1m]`: two spellings of one build, neither of them the name
    // the reader's own terminal prints (bw-ja9l.11).
    draw('claude-opus-5[1m]', 'bypassPermissions', NO_MENU);

    expect(modelChip()?.textContent).toBe('Opus 5 (1M context)');
    // The id is still one hover away, which is where it belongs.
    expect(modelChip()?.getAttribute('title')).toContain('claude-opus-5[1m]');
  });

  it('names every model the kit hands it, and defers where it cannot', () => {
    for (const [wire, said] of [
      ['claude-opus-5[1m]', 'Opus 5 (1M context)'],
      ['claude-opus-5', 'Opus 5'],
      ['claude-sonnet-5', 'Sonnet 5'],
      ['claude-fable-5', 'Fable 5'],
      ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
      ['claude-opus-4-5-20251101', 'Opus 4.5'],
      ['claude-sonnet-5-latest', 'Sonnet 5'],
      ['default', 'Default model'],
      // No family it knows: the id opened up is better than the id.
      ['some-new-thing', 'Some new thing'],
    ] as const) {
      expect(modelName(wire), wire).toBe(said);
    }

    // A bare family key carries no version, so the list's own word wins — and
    // an id this CAN read never defers to the list, which is the correction:
    // that list is where `claude-opus-5[1m]` came from.
    expect(modelName('opus', 'Opus 5')).toBe('Opus 5');
    expect(modelName('opus')).toBe('Opus');
    expect(modelName('claude-opus-5[1m]', 'claude-opus-5[1m]')).toBe('Opus 5 (1M context)');
    expect(modelName('opusplan', 'Opus, planning first')).toBe('Opus, planning first');
    expect(modelName(null)).toBeNull();
  });

  it('gives the picker under the writing box the same name as the chip', () => {
    // Both read one function. The picker's button prints whatever the list said
    // only where this cannot parse the id (chat-tab.tsx).
    const tab = readFileSync(resolve(__dirname, '../chat-tab.tsx'), 'utf8');
    const picker = tab.slice(tab.indexOf('testid="model-picker"'));
    const opening = picker.slice(0, picker.indexOf('/>'));

    expect(opening, 'the list is named by the shared function').toContain('modelName(m.value, m.displayName)');
    expect(opening, 'and so is a model the list has no row for').toContain('currentLabel={modelName(');
  });

  it('says the brand’s default only where there is a picker to mean it', () => {
    const { unmount } = draw(null, 'default');
    expect(modelChip()?.textContent).toBe('Default model');
    unmount();

    // Nothing is driving this one and its record has not answered yet: an
    // empty line, because the only guess available is about this machine's
    // settings and not about the terminal that chat is running in.
    draw(null, null, NO_MENU);
    expect(modelChip()).toBeNull();
    expect(modeChip()).toBeNull();
  });

  it('gives one model one colour, whoever started the chat', () => {
    // The colour is hashed off the data, and the same model arrives here under
    // three spellings: the picker's key from the store on a chat this app
    // drives, and the id the kit resolved to on one read off its record. Hashed
    // raw, each of them was a different colour for the same model (bw-ja9l.6).
    const hue = (model: string, models = MENU): string => {
      const { unmount } = draw(model, 'default', models);
      const said = (modelChip() as HTMLElement).style.getPropertyValue('--tag-h');
      unmount();
      return said;
    };

    const driven = hue('opus');
    expect(driven, 'the chip must carry a hue at all').not.toBe('');
    expect(hue('claude-opus-5', NO_MENU), 'read off a record').toBe(driven);
    expect(hue('claude-opus-5[1m]', NO_MENU), 'the long-context build').toBe(driven);
    expect(hue('claude-opus-4-5-20251101', NO_MENU), 'an older build').toBe(driven);

    // And a different model is still a different colour: one colour for
    // everything would close this card and lose the point of it.
    expect(hue('claude-sonnet-5', NO_MENU)).not.toBe(driven);
  });

  it('reads one family name out of every spelling of a model', () => {
    for (const [wire, family] of [
      ['opus', 'opus'],
      ['claude-opus-5', 'opus'],
      ['claude-opus-5[1m]', 'opus'],
      ['claude-opus-4-5-20251101', 'opus'],
      ['claude-haiku-4-5-20251001', 'haiku'],
      ['claude-sonnet-5-latest', 'sonnet'],
      ['default', 'default'],
    ] as const) {
      expect(modelKey(wire), wire).toBe(family);
    }
  });

  it('spaces its two chips the way the line spaces everything else', () => {
    // The group is a shrinking device and not a grouping anybody is meant to
    // see. Holding its pair half a step closer than the line held the rest drew
    // the four chips on that row as two pairs — 12px, 6px, 12px (bw-ja9l.10).
    draw('opus', 'bypassPermissions');
    const group = screen.getByTestId('session-meta');

    const gaps = group.className.split(/\s+/).filter((c) => /^gap(-|$)/.test(c));
    expect(gaps, 'the group spaces its chips once, and by the shared value').toEqual([CHIP_GAP]);

    // And the line it sits in reads that same value rather than writing its
    // own: two numbers is how they drifted apart in the first place.
    const header = readFileSync(resolve(__dirname, '../chat-tab.tsx'), 'utf8');
    const line = header.slice(header.indexOf('data-testid="chat-status-line"'));
    const opening = line.slice(0, line.indexOf('>'));
    expect(opening, 'the line spaces its chips by the shared value').toContain('CHIP_GAP');
    expect(opening, 'and never by a number of its own').not.toMatch(/\bgap-[\d.]+/);
  });

  it('gives every tag on the line a mark of its own', () => {
    // Three of the four chips on that line were words in a coloured pill and
    // nothing else, next to a state chip that only had a mark while it moved.
    // A row of pills that differ by reading alone is a row nobody scans
    // (bw-ja9l.12).
    draw('claude-opus-5[1m]', 'bypassPermissions', NO_MENU);

    expect(modelChip()?.querySelector('svg'), 'the model wears one').not.toBeNull();
    expect(modeChip()?.querySelector('svg'), 'so does the mode').not.toBeNull();
    // And the model's words are still the model's words, not the mark's.
    expect(modelChip()?.textContent).toBe('Opus 5 (1M context)');
    expect(modeChip()?.textContent).toBe('Skip all checks');

    // The folder chip is the fourth, and the header draws it a few lines below
    // the group this file renders.
    const header = readFileSync(resolve(__dirname, '../chat-tab.tsx'), 'utf8');
    const folder = header.slice(header.indexOf('data-testid="chat-folder-chip"'));
    expect(folder.slice(0, folder.indexOf('</Badge>')), 'the folder wears one too').toContain('<Folder');
  });

  it('changes the mode’s mark with the mode, so it is never read as safe', () => {
    // The shield says how far this chat goes before it asks, ahead of the
    // words: whole for one that asks, struck through for one that does not.
    const marks = new Map<string, string>();
    for (const wire of ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto', 'bypassPermissions']) {
      const { unmount } = draw('opus', wire);
      marks.set(wire, modeChip()?.querySelector('svg')?.getAttribute('class') ?? '');
      unmount();
    }

    // lucide names its own class after the icon, which is how a case tells one
    // shield from another without reading the path data.
    expect(marks.get('bypassPermissions')).not.toBe(marks.get('default'));
    expect(marks.get('acceptEdits')).not.toBe(marks.get('default'));
    expect(marks.get('acceptEdits')).not.toBe(marks.get('bypassPermissions'));

    // A mode invented after this release still gets a shield rather than none.
    draw('opus', 'askAboutEverythingTwice');
    expect(modeChip()?.querySelector('svg')).not.toBeNull();
  });

  it('gives way before the folder chip does', () => {
    draw('opus', 'bypassPermissions');
    const group = screen.getByTestId('session-meta');

    expect(group.className).toContain('min-w-0');
    expect(group.className).toContain('shrink');
    expect(group.className.split(/\s+/)).not.toContain('shrink-0');

    // And the chip it must give way to holds its width whatever happens: the
    // header draws it a few lines further down the same row.
    const header = readFileSync(resolve(__dirname, '../chat-tab.tsx'), 'utf8');
    const folder = header.slice(header.indexOf('data-testid="chat-folder-chip"'));
    const className = /className="([^"]*)"/.exec(folder)?.[1] ?? '';
    expect(className.split(/\s+/), 'the folder chip must never give way').toContain('shrink-0');
  });
});
