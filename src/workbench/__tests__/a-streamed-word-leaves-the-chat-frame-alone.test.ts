/**
 * The frame around a chat — its bar, its list of chats, its composer — is
 * drawn from the chat's shape, which only moves when something other than
 * the words of a growing answer changed (bw-j29w).
 */
import { describe, expect, it } from 'vitest';

import { EMPTY, type SessionView, type TranscriptItem } from '@/workbench/fold';
import { onlyWordsGrew } from '@/workbench/use-session';

// The fold carries every other field over as it was, so the answers here share them too.
const NONE: never[] = [];
const answer = (text: string, extra: Partial<TranscriptItem> = {}): TranscriptItem => ({
  kind: 'message', id: 'a', role: 'assistant', text, images: NONE, done: false, parentId: null, ...extra,
} as TranscriptItem);
const asked = (text: string): TranscriptItem => ({
  kind: 'message', id: 'u', role: 'user', text, images: NONE, done: true, parentId: null,
});
const thought = (text: string): TranscriptItem => ({ kind: 'thinking', id: 't', text, done: false, parentId: null });
const view = (items: TranscriptItem[], more: Partial<SessionView> = {}): SessionView => ({ ...EMPTY, items, ...more });

describe('a chat keeps its shape while an answer streams in', () => {
  it('holds when only an answer or a thought grew', () => {
    const q = asked('hi');
    expect(onlyWordsGrew(view([q, answer('Hello')]), view([q, answer('Hello there')]))).toBe(true);
    expect(onlyWordsGrew(view([thought('Let me')]), view([thought('Let me look')]))).toBe(true);
  });

  it('moves when a row comes or goes', () => {
    expect(onlyWordsGrew(view([answer('Hello')]), view([answer('Hello'), asked('more')]))).toBe(false);
  });

  it('moves when a user message changes, because the sent line is matched against it', () => {
    expect(onlyWordsGrew(view([asked('hi')]), view([asked('hi there')]))).toBe(false);
  });

  it('moves when an answer finishes', () => {
    expect(onlyWordsGrew(view([answer('Hello')]), view([answer('Hello', { done: true })]))).toBe(false);
  });

  it('moves when an answer starts from nothing, since an empty one is not drawn', () => {
    expect(onlyWordsGrew(view([answer('')]), view([answer('Hi')]))).toBe(false);
  });

  it('moves when the words become the kit speaking', () => {
    expect(onlyWordsGrew(view([answer('You')]), view([answer("You've hit your limit")]))).toBe(false);
  });

  it('moves when anything beside the transcript changed', () => {
    const items = [answer('Hello')];
    expect(onlyWordsGrew(view(items), view(items, { model: 'other' } as Partial<SessionView>))).toBe(false);
  });
});
