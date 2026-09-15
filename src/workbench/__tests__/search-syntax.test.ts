import { describe, expect, it } from 'vitest';

import { controlsOf, suggestionsFor, taking, tokens, withFilter, withScopes } from '@/workbench/search-syntax';

describe('the search box and the controls beside it', () => {
  it('reads the words a control owns, and only those', () => {
    expect(controlsOf('in:title,me project:"beads web" provider:codex from:terminal after:7d loader')).toEqual({
      scopes: ['title', 'me'],
      project: 'beads web',
      provider: 'codex',
      from: 'terminal',
      after: '7d',
    });
    // A left-out project is a word about what to leave out, not the project.
    expect(controlsOf('-project:aspen std::fs').project).toBeNull();
  });

  it('writes a control ahead of the words, so the word being typed stays last', () => {
    expect(withFilter('loader cra', 'provider', 'claude')).toBe('provider:claude loader cra');
    expect(withFilter('provider:claude loader cra', 'provider', 'codex')).toBe('provider:codex loader cra');
    expect(withFilter('provider:claude loader ', 'provider', null)).toBe('loader ');
    expect(withFilter('', 'project', 'beads web')).toBe('project:"beads web" ');
    expect(withScopes('in:tool loader', ['title', 'agent'])).toBe('in:title,agent loader');
    expect(withScopes('in:tool loader', [])).toBe('loader');
  });

  it('keeps a quoted phrase in one piece', () => {
    expect(tokens('title:"two words" -x').map((t) => [t.key, t.value, t.negated])).toEqual([
      ['title', 'two words', false],
      [null, 'x', true],
    ]);
  });

  it('offers the keys a word starts, and the values a key takes', () => {
    expect(suggestionsFor('loader ti', [])?.items.map((s) => s.label)).toEqual(['title:']);
    expect(suggestionsFor('provider:c', [])?.items.map((s) => s.label)).toEqual(['claude', 'codex']);
    expect(suggestionsFor('project:be', ['beads web', 'aspen'])?.items.map((s) => s.insert)).toEqual([
      'project:"beads web"',
    ]);
    expect(suggestionsFor('loader ', [])).toBeNull();
    const at = suggestionsFor('-from:t', [])!;
    expect(taking('-from:t', at, at.items[0]!)).toBe('-from:terminal ');
  });
});
