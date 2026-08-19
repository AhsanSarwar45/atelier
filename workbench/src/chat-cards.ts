/**
 * The cards a chat has worked on, and what asking for them costs.
 *
 * Opening a chat used to read the whole board — every card, closed ones too,
 * a megabyte of it — to find the handful stamped with this chat's name. It was
 * paid on every open, of every chat, while the reader waited for the first
 * message to appear.
 *
 * Now an open asks the tracker about this chat and nothing else, and the board
 * is read for every chat at once, in the background, at most once a minute per
 * project. What that read finds is remembered, so a chat run in a terminal —
 * the only kind the stamps are needed for — carries its cards from the next
 * look onwards.
 */
import { claimedCards, issuesForSession, run, type BdRunner } from './bd.ts';

/** What this needs of the store, so a test can stand one in. */
export interface CardMemory {
  rememberBeadLink(sessionId: string, beadId: string, via: string): void;
  beadsForSession(sessionId: string): string[];
}

/** A chat, as far as matching board stamps is concerned. */
export interface KnownChat {
  id: string;
  externalId: string | null;
  cwd: string;
}

/** How long a board read stands for every chat in that project. */
export const SWEEP_EVERY_MS = 60_000;

const sweptAt = new Map<string, number>();

/** Only for tests: forget when each project was last swept. */
export function forgetSweeps(): void {
  sweptAt.clear();
}

/** The name a claim is stamped under ends in the first eight of the session. */
function stampedBy(claimant: string, shortId: string): boolean {
  return claimant === shortId || claimant.endsWith(`-${shortId}`);
}

/**
 * The cards to show for a chat being opened.
 *
 * One tracker command, about this chat: what the board recorded against this
 * session. Everything else comes from what is already remembered here.
 */
export async function cardsForOpen(
  memory: CardMemory,
  sessionId: string,
  cwd: string,
  exec: BdRunner = run,
): Promise<string[]> {
  const linked = await issuesForSession(sessionId, cwd, exec);
  for (const beadId of linked) memory.rememberBeadLink(sessionId, beadId, 'board');
  return [...new Set([...memory.beadsForSession(sessionId), ...linked])];
}

/**
 * Reads the board once and remembers, for every chat it knows, the cards
 * stamped with that chat's name.
 *
 * Never awaited by an open: it is kicked off after one has been answered, and
 * refuses to run again for a minute, so a reader clicking through ten chats
 * pays for no board read at all.
 */
export async function sweepClaims(
  memory: CardMemory,
  cwd: string,
  chats: KnownChat[],
  exec: BdRunner = run,
  now: number = Date.now(),
): Promise<boolean> {
  if (now - (sweptAt.get(cwd) ?? -Infinity) < SWEEP_EVERY_MS) return false;
  sweptAt.set(cwd, now);
  const here = chats.filter((c) => c.cwd === cwd && (c.externalId ?? '').length >= 8);
  if (here.length === 0) return false;
  const claimed = await claimedCards(cwd, exec);
  for (const chat of here) {
    const shortId = chat.externalId!.slice(0, 8);
    for (const card of claimed) {
      if (stampedBy(card.claimant, shortId)) memory.rememberBeadLink(chat.id, card.id, 'board');
    }
  }
  return true;
}
