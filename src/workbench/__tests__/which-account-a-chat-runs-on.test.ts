/**
 * Which account a chat is spending, on the chat's own line (bw-5ihw.7).
 *
 * The server already knew — it has to, to point the provider at the right
 * directory — but nothing it sent the browser carried it, so every chat looked
 * the same whichever account was paying for it. The start record carries it
 * now, and the line draws it for a named account only: a badge on every chat
 * saying "System" would be a word that never varies.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { EMPTY, foldAll, reduce } from '@/workbench/fold';
import type { WbpEvent } from '@/workbench/protocol';

const chatTab = readFileSync('src/workbench/chat-tab.tsx', 'utf8');

function startedOn(profile?: string | null): WbpEvent {
  return {
    type: 'session.started',
    sessionId: 'chat',
    seq: 1,
    at: '2026-09-12T12:00:00.000Z',
    brand: 'claude',
    externalId: null,
    model: null,
    cwd: '/tmp',
    permissionMode: 'default',
    ...(profile === undefined ? {} : { profile }),
  } as WbpEvent;
}

describe('the account a chat was started on', () => {
  it('is folded off the start record, both ways of folding one', () => {
    expect(foldAll([startedOn('work')]).profile).toBe('work');
    expect(reduce(EMPTY, startedOn('work')).profile).toBe('work');
  });

  it('is nothing for a chat on the account the computer itself is signed in with', () => {
    // Which is also every chat started before accounts existed: the field is
    // simply absent from those records, and absent has to read the same as
    // "the computer's own" or old chats would all grow a badge.
    expect(foldAll([startedOn(undefined)]).profile).toBeNull();
    expect(foldAll([startedOn(null)]).profile).toBeNull();
  });
});

describe('the badge on the chat status line', () => {
  it('draws nothing for the system account or a local model', () => {
    expect(chatTab).toContain("!view.profile || sessionBrand === 'local'");
    expect(chatTab).toContain('{sessionProfileName && <ProfileBadge');
  });

  it('calls the account by its current name, and falls back to the id it was started with', () => {
    // A rename in settings should move the badge with it, so the name is
    // looked up rather than remembered; an account deleted after the chat ran
    // leaves the id, which is still truer than drawing nothing.
    expect(chatTab).toContain('accounts[sessionBrand]?.find((p) => p.id === view.profile)?.name ?? view.profile');
  });
});
