import { describe, expect, it } from 'vitest';

import { carried, split } from '@/search/syntax';
import { CHAT_GRAMMAR } from '@/workbench/search-syntax';

describe('a question for the AI and the filters it is held to', () => {
  it('splits the box into the keys it sets and the words it asks', () => {
    expect(split('project:"beads web" the loader -provider:codex in:title,me crash std::fs', CHAT_GRAMMAR)).toEqual({
      filters: 'project:"beads web" -provider:codex in:title,me',
      words: 'the loader crash std::fs',
    });
    expect(split('where we fixed it', CHAT_GRAMMAR)).toEqual({ filters: '', words: 'where we fixed it' });
  });

  it('carries the filters across a switch of box, and keeps the other box its own words', () => {
    expect(carried('project:web loader', '', CHAT_GRAMMAR)).toBe('project:web ');
    expect(carried('provider:claude why it broke', 'project:web loader', CHAT_GRAMMAR)).toBe('provider:claude loader');
    expect(carried('why it broke', 'project:web loader', CHAT_GRAMMAR)).toBe('loader');
  });
});
