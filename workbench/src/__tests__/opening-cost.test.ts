/**
 * @vitest-environment node
 *
 * What opening one chat costs the tracker.
 *
 * An open used to ask for the whole board — every card, closed ones too, a
 * megabyte of it on a board of 933 — to find the few stamped with this chat's
 * name, and paid it again on every open. The reader waited for that before a
 * single message appeared (bw-uiyz.7).
 *
 * So the commands are counted here, not the seconds: an open asks about this
 * chat and nothing else, and the one command that does read the board runs in
 * the background, for every chat at once, and refuses to run again for a
 * minute.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { cardsForOpen, forgetSweeps, sweepClaims, type CardMemory, type KnownChat } from '../chat-cards.ts';

import type { BdResult } from '../bd.ts';

/** Remembers links the way the store does, without a database. */
class Memory implements CardMemory {
  readonly links = new Map<string, Set<string>>();

  rememberBeadLink(sessionId: string, beadId: string, _via: string): void {
    const held = this.links.get(sessionId) ?? new Set<string>();
    held.add(beadId);
    this.links.set(sessionId, held);
  }

  beadsForSession(sessionId: string): string[] {
    return [...(this.links.get(sessionId) ?? [])];
  }
}

const SESSION = 'sess-aaaaaaaa-1111-2222-3333-444444444444';
const CWD = '/home/me/project';

/** A board of a thousand cards, three of them claimed by one chat. */
function board(): { id: string; assignee: string | null; description: string }[] {
  const rows = Array.from({ length: 1_000 }, (_, i) => ({
    id: `bw-${i}`,
    assignee: i % 7 === 0 ? `bw-other-99999999` : null,
    description: 'x'.repeat(500),
  }));
  for (const i of [3, 40, 800]) rows[i] = { id: `bw-${i}`, assignee: 'bw-job-aaaaaaaa', description: '' };
  return rows;
}

/** A tracker that answers from memory and writes down every command asked of it. */
function tracker(asked: string[][]): (args: string[], cwd: string) => Promise<BdResult> {
  return (args) => {
    asked.push(args);
    if (args[0] === 'provenance') return Promise.resolve({ ok: true, stdout: '[]', stderr: '' });
    if (args[0] === 'list') return Promise.resolve({ ok: true, stdout: JSON.stringify(board()), stderr: '' });
    return Promise.resolve({ ok: true, stdout: '', stderr: '' });
  };
}

const CHATS: KnownChat[] = [
  { id: SESSION, externalId: 'aaaaaaaa-1111-2222-3333-444444444444', cwd: CWD },
  { id: 'sess-b', externalId: 'bbbbbbbb-1111-2222-3333-444444444444', cwd: CWD },
];

describe('what opening a chat costs the tracker', () => {
  beforeEach(() => forgetSweeps());

  it('asks about this chat, and never for every card there is', async () => {
    const asked: string[][] = [];
    await cardsForOpen(new Memory(), SESSION, CWD, tracker(asked));

    expect(asked).toHaveLength(1);
    expect(asked[0]).toEqual(['provenance', 'by-ref', SESSION, '--json']);
    expect(asked.some((args) => args[0] === 'list')).toBe(false);
  });

  it('costs the same however many cards the chat has worked on', async () => {
    const memory = new Memory();
    for (const card of ['bw-3', 'bw-40', 'bw-800']) memory.rememberBeadLink(SESSION, card, 'board');
    const asked: string[][] = [];

    const cards = await cardsForOpen(memory, SESSION, CWD, tracker(asked));

    expect(cards).toEqual(['bw-3', 'bw-40', 'bw-800']);
    expect(asked).toHaveLength(1);
  });

  it('reads the board for every chat at once, not once per chat', async () => {
    const memory = new Memory();
    const asked: string[][] = [];

    await sweepClaims(memory, CWD, CHATS, tracker(asked), 1_000);

    expect(asked.filter((args) => args[0] === 'list')).toHaveLength(1);
    expect(memory.beadsForSession(SESSION)).toEqual(['bw-3', 'bw-40', 'bw-800']);
    expect(memory.beadsForSession('sess-b')).toEqual([]);
  });

  it('refuses to read the board again for a minute', async () => {
    const memory = new Memory();
    const asked: string[][] = [];

    expect(await sweepClaims(memory, CWD, CHATS, tracker(asked), 1_000)).toBe(true);
    expect(await sweepClaims(memory, CWD, CHATS, tracker(asked), 30_000)).toBe(false);
    expect(await sweepClaims(memory, CWD, CHATS, tracker(asked), 62_000)).toBe(true);

    expect(asked.filter((args) => args[0] === 'list')).toHaveLength(2);
  });

  it('the cards a chat is opened with need no board read at all', async () => {
    const memory = new Memory();
    const asked: string[][] = [];
    await sweepClaims(memory, CWD, CHATS, tracker(asked), 1_000);
    asked.length = 0;

    const cards = await cardsForOpen(memory, SESSION, CWD, tracker(asked));

    expect(cards).toEqual(['bw-3', 'bw-40', 'bw-800']);
    expect(asked.some((args) => args[0] === 'list')).toBe(false);
  });
});
