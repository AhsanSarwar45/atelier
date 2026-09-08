/**
 * The project screen's address, in one place.
 *
 * Everything a reader could arrive at is in the address and nothing that a link
 * could carry is held in a component's own state:
 *
 *   /project?id=<project>&tab=chat|board|files&chat=<sessionId>&card=<cardId>
 *   …&file=<absolute path>&line=<1-based line>
 *
 * Design: docs/designs/app-shell.md §1.7.
 */

export type Tab = 'chat' | 'board' | 'files';

export interface Where {
  /** The project. Null only while the screen is being sent back to the list. */
  id: string | null;
  tab: Tab;
  /** The conversation drawn in the chat tab. */
  chat: string | null;
  /** The card whose panel is over the top of whichever tab is showing. */
  card: string | null;
  /** The file the Files tab is showing, as an absolute path. */
  file: string | null;
  /** The line of that file to scroll to and mark, counted from one. */
  line: number | null;
}

/**
 * The line the address names, or null when it names none worth having.
 *
 * A file's lines start at one, so `0`, `-3`, `2.5` and `banana` are all
 * somebody's slip; a viewer told to scroll to any of them would either throw or
 * quietly land somewhere else and say nothing.
 */
export function lineFrom(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const line = Number(raw);
  return Number.isInteger(line) && line > 0 ? line : null;
}

/** What a chip and a link used to spell `card` as. Still read, never written. */
export const OLD_CARD = 'bead';

/** Where the address says we are. */
export function whereFrom(params: URLSearchParams): Where {
  const chat = params.get('chat');
  const file = params.get('file');
  const rawTab = params.get('tab');
  // Naming a file asks for the Files tab, the same way naming a chat asks for
  // the Chat tab: a link that carries one lands where the thing it carries can
  // actually be seen, without every writer of a link having to spell the tab
  // out as well. Unknown and retired tab names fall back to the board rather
  // than opening a destination that no longer exists.
  const tab: Tab =
    rawTab === 'chat'
      ? 'chat'
      : rawTab === 'board'
        ? 'board'
        : rawTab === 'files'
          ? 'files'
          : file
            ? 'files'
            : chat
              ? 'chat'
              : 'board';
  return {
    id: params.get('id'),
    tab,
    chat,
    card: params.get('card') ?? params.get(OLD_CARD),
    file,
    line: lineFrom(params.get('line')),
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
  // `line` is a number where every other part is a string; both are written as
  // the text a reader would have typed into the address bar themselves.
  for (const [key, value] of Object.entries({ ...patch, card }) as [keyof Where, string | number | null][]) {
    if (value === null || value === undefined || value === '') q.delete(key);
    else q.set(key, String(value));
  }
  return `/project?${q.toString()}`;
}

/**
 * Whether the app has a page of its own behind this one.
 *
 * The bar's arrow is a step back through the history, not a jump to the list:
 * a nested page opened from a chat has to give that chat back, not the front door.
 * It falls back to the list only when nothing of ours is behind — a pasted
 * address, a fresh tab — because stepping back there would leave the app.
 *
 * The Navigation API is the exact answer: its entries are only the ones on this
 * origin, so an index above the first means the entry behind us is ours.
 * Browsers without it get the rough count, which is right about the fresh tab
 * and wrong only about arriving from somewhere else, where stepping back is
 * what the browser's own arrow would do anyway.
 */
export function somewhereBehind(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = (window as { navigation?: { currentEntry?: { index: number } } }).navigation;
  if (nav?.currentEntry) return nav.currentEntry.index > 0;
  return window.history.length > 1;
}
