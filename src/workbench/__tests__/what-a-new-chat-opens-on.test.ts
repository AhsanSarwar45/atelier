/**
 * The provider default moved out of the browser and into the app, so that the
 * star that sets it behaves like the model and effort stars beside it and so
 * that the phone and the desk agree. These cover the crossing: the one browser
 * that still holds the old key hands it over and forgets it, and a browser
 * that never had one asks the app like any other.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  loadNewChatDefaults,
  NEW_CHAT_DEFAULT,
  saveNewChatProfile,
  saveNewChatProvider,
} from '../new-chat-defaults';

/** Every read this module made, in the order it made them. */
const asked: { path: string; method: string; body: unknown }[] = [];

/** What the fake app answers next, or an error to throw instead. */
let answers: unknown = { provider: null, profiles: {}, migrated: false };
let refuse: Error | null = null;

vi.mock('@/lib/api', () => ({
  request: async (path: string, options?: RequestInit) => {
    if (refuse) throw refuse;
    asked.push({
      path,
      method: options?.method ?? 'GET',
      body: options?.body ? JSON.parse(String(options.body)) : undefined,
    });
    return new Response(JSON.stringify(answers), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  },
}));

describe('what a new chat opens on', () => {
  beforeEach(() => {
    asked.length = 0;
    refuse = null;
    answers = { provider: null, profiles: {}, migrated: false };
    localStorage.clear();
  });

  it('hands the browser’s old default to the app and forgets it', async () => {
    localStorage.setItem(NEW_CHAT_DEFAULT, 'codex');
    answers = { provider: 'codex', profiles: {}, migrated: true };

    const now = await loadNewChatDefaults();

    expect(asked).toEqual([
      {
        path: '/api/settings/new-chat/migration',
        method: 'POST',
        body: { provider: 'codex' },
      },
    ]);
    expect(now.provider).toBe('codex');
    expect(localStorage.getItem(NEW_CHAT_DEFAULT)).toBeNull();
  });

  it('hands “ask” over too, so the app can record that the crossing happened', async () => {
    // Carried rather than dropped here: if this end decided that "ask" meant
    // nothing to say, the next browser to open would carry its own stale value
    // across on top of a choice made since.
    localStorage.setItem(NEW_CHAT_DEFAULT, 'ask');

    await loadNewChatDefaults();

    expect(asked).toHaveLength(1);
    expect(asked[0].body).toEqual({ provider: 'ask' });
    expect(localStorage.getItem(NEW_CHAT_DEFAULT)).toBeNull();
  });

  it('asks the app plainly when the browser holds nothing to carry', async () => {
    answers = { provider: 'claude', profiles: { claude: 'work' }, migrated: true };

    const now = await loadNewChatDefaults();

    expect(asked).toEqual([{ path: '/api/settings/new-chat', method: 'GET', body: undefined }]);
    expect(now.provider).toBe('claude');
    expect(now.profiles.claude).toBe('work');
  });

  it('keeps the old key when the app is not running, rather than losing the choice', async () => {
    localStorage.setItem(NEW_CHAT_DEFAULT, 'claude');
    refuse = new Error('no answer from the app in 10s — it may be stopped, or busy');

    await expect(loadNewChatDefaults()).rejects.toThrow('no answer from the app');
    expect(localStorage.getItem(NEW_CHAT_DEFAULT)).toBe('claude');
  });

  it('drops a value this app never wrote without asking the app about it', async () => {
    localStorage.setItem(NEW_CHAT_DEFAULT, 'gemini');

    await loadNewChatDefaults();

    expect(asked).toEqual([{ path: '/api/settings/new-chat', method: 'GET', body: undefined }]);
    expect(localStorage.getItem(NEW_CHAT_DEFAULT)).toBeNull();
  });

  it('says which of the two choices a pressed star is about', async () => {
    await saveNewChatProvider('claude');
    await saveNewChatProvider(null);
    await saveNewChatProfile('codex', 'work');

    expect(asked.map((one) => one.body)).toEqual([
      { set: 'provider', brand: 'claude' },
      { set: 'provider', brand: null },
      { set: 'profile', brand: 'codex', profile: 'work' },
    ]);
    expect(asked.every((one) => one.method === 'PUT')).toBe(true);
  });

  it('writes nothing to the browser once the app holds the choice', async () => {
    await saveNewChatProvider('claude');
    expect(localStorage.getItem(NEW_CHAT_DEFAULT)).toBeNull();
  });
});
