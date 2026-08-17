/**
 * The project screen's address, in one place.
 *
 * Everything a reader could arrive at is in the address and nothing that a link
 * could carry is held in a component's own state:
 *
 *   /project?id=<project>&tab=chat|board&chat=<sessionId>&card=<cardId>
 *
 * Design: docs/designs/app-shell.md §1.7.
 */

export type Tab = 'chat' | 'board';

export interface Where {
  /** The project. Null only while the screen is being sent back to the list. */
  id: string | null;
  tab: Tab;
  /** The conversation drawn in the chat tab. */
  chat: string | null;
  /** The card whose panel is over the top of whichever tab is showing. */
  card: string | null;
}

/** What a chip and a link used to spell `card` as. Still read, never written. */
const OLD_CARD = 'bead';

/** Where the address says we are. */
export function whereFrom(params: URLSearchParams): Where {
  const chat = params.get('chat');
  // Naming a chat is asking for the chat tab: a link from a card, the tray or
  // the board lands on the conversation it names rather than beside it.
  const tab: Tab = params.get('tab') === 'chat' || (chat && params.get('tab') !== 'board') ? 'chat' : 'board';
  return {
    id: params.get('id'),
    tab,
    chat,
    card: params.get('card') ?? params.get(OLD_CARD),
  };
}

/**
 * How many card panels this visit opened by pushing onto the history.
 *
 * Closing one has to step BACK off the entry it added, or Back is left pointing
 * at an address identical to the one before it and does nothing — one dead press
 * per card looked at (bw-m8o.10). Whoever pushes says so here, because the chips
 * that push are all over the screen and none of them can reach the panel's own
 * close. It lives for the life of the page, like the history it counts.
 */
let pushedCards = 0;

export function cardWasPushed(): void {
  pushedCards += 1;
}

/** True when closing should step back rather than rewrite the address. */
export function cardCameFromHere(): boolean {
  return pushedCards > 0;
}

/** Called by whichever path closed the panel, however it closed. */
export function cardWasClosed(): void {
  pushedCards = Math.max(0, pushedCards - 1);
}

/**
 * The same address with some of it changed. Everything else it carries is kept,
 * so a parameter this file has never heard of survives a tab switch; `null`
 * removes one.
 */
export function addressWith(params: URLSearchParams, patch: Partial<Where>): string {
  const q = new URLSearchParams(params.toString());
  // The old spelling is normalised on the way out, so one address shape leaves
  // this screen however the reader arrived at it.
  const card = 'card' in patch ? patch.card : (params.get('card') ?? params.get(OLD_CARD));
  q.delete(OLD_CARD);
  for (const [key, value] of Object.entries({ ...patch, card }) as [keyof Where, string | null][]) {
    if (value === null || value === undefined || value === '') q.delete(key);
    else q.set(key, value);
  }
  return `/project?${q.toString()}`;
}
