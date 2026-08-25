/**
 * What he typed and has not sent, kept against the chat he typed it in.
 *
 * The writing box used to hold both of these itself, and lost them twice over.
 * Leaving the chat tab for the board takes the whole chat screen down —
 * deliberately, so a board behind the chat costs nothing (app/project/page.tsx)
 * — and everything the screen was holding went down with it. And which chat is
 * open is not the screen's state but the address (chat-tab.tsx), so switching
 * chats does NOT take it down: one box served every chat, and an unsent line
 * followed him into the next one, where he had never written it (bw-33qh).
 *
 * So both are held out here, against the chat's own id, where the screen coming
 * and going cannot touch them.
 *
 * The line and the pictures are kept in different places on purpose. A line
 * survives closing the window, because that is what he asked for, and the
 * browser's own store is the only thing that outlives a window. Pictures do not
 * go in there: they arrive as their own bytes spelled out in text, one
 * screenshot runs to megabytes, and the store gives up somewhere around five —
 * so a tray of two would start throwing where a line never can. They live in
 * this module instead, which outlasts every screen in the window and nothing
 * more, and that is the whole of what bounds them.
 */
import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from 'react';

import type { ImagePayload } from '@/workbench/protocol';

/** Where one chat's unsent line is kept, under its own id. */
const LINE = 'workbench.unsent-line.';

/** The order those lines were last written in, oldest first. */
const ORDER = 'workbench.unsent-order';

/**
 * How many chats' lines are kept at once, the oldest written thrown out first.
 *
 * A line he abandoned in a chat he later deleted would otherwise sit in the
 * browser for the life of the machine. Bounded rather than swept against the
 * chats that still exist, and both halves of that are worth writing down. The
 * only list this app is ever handed is one project's, and it leaves out the
 * chats an agent started unless he has asked for them — so a sweep by that list
 * would read every one of those as a chat that is gone and throw away what he
 * wrote in it. And a fuller list means asking the helper a second time on every
 * visit to the chat tab, which is the cost `chats-from-outside` pins at one.
 *
 * Fifty is far past the number of conversations anybody has half-written lines
 * in at once, and the line he is typing is by definition the newest, so the cap
 * can never reach the one in front of him.
 */
const KEEP = 50;

/** Every chat's unsent pictures, for as long as this window is open. */
const TRAYS = new Map<string, ImagePayload[]>();

/** One empty tray, so a chat with no pictures draws the same value every pass. */
const NO_PICTURES: ImagePayload[] = [];

/** The browser's store, or nothing where there is not one to have. */
function store(): Storage | null {
  try {
    // No browser at all while the page is being built into a file, and a
    // browser told to allow no storage throws on the getter itself. A line he
    // cannot keep is worth less than a chat that will not draw.
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function order(kept: Storage): string[] {
  try {
    const read: unknown = JSON.parse(kept.getItem(ORDER) ?? '[]');
    return Array.isArray(read) ? read.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Moves one chat's line to the newest end, and throws out whatever that pushes
 * past the cap. Runs on every keystroke, so it touches the index and nothing
 * else: the lines themselves are never read here.
 */
function newest(kept: Storage, key: string): void {
  const soFar = order(kept).filter((k) => k !== key);
  soFar.push(key);
  for (const old of soFar.splice(0, Math.max(0, soFar.length - KEEP))) kept.removeItem(old);
  kept.setItem(ORDER, JSON.stringify(soFar));
}

/** Takes one chat out of the index, because it no longer has a line. */
function dropped(kept: Storage, key: string): void {
  kept.setItem(ORDER, JSON.stringify(order(kept).filter((k) => k !== key)));
}

/**
 * The line he has typed into this chat and not sent, and the way to change it.
 *
 * Shaped like `useState` so the box using it reads as it always did, updater
 * and all.
 */
export function useUnsentLine(sessionId: string): [string, Dispatch<SetStateAction<string>>] {
  const [line, setLine] = useState('');
  const key = LINE + sessionId;

  // Read after the first draw rather than in the opening value: this app is
  // built as files a server hands over, and that first pass has no browser to
  // ask. Keyed on the chat, so opening another one brings back ITS line instead
  // of carrying this one across.
  useEffect(() => {
    setLine(store()?.getItem(key) ?? '');
  }, [key]);

  const write = useCallback<Dispatch<SetStateAction<string>>>(
    (next) => {
      setLine((was) => {
        const now = typeof next === 'function' ? next(was) : next;
        // Written where it CHANGES, never mirrored back from an effect: an
        // effect that writes the state out runs once with the value the screen
        // opened on, and overwrites what was remembered before the effect that
        // reads it has run. That is the fault that lost the reader's kind
        // filter on every reload (bw-qdim, chat-right-rail.tsx).
        const kept = store();
        if (kept && now) {
          kept.setItem(key, now);
          newest(kept, key);
        } else if (kept) {
          kept.removeItem(key);
          dropped(kept, key);
        }
        return now;
      });
    },
    [key],
  );

  return [line, write];
}

/**
 * The pictures he has attached to this chat and not sent, and the way to change
 * them. Gone when the window closes; see the note at the top for why.
 */
export function useUnsentPictures(
  sessionId: string,
): [ImagePayload[], Dispatch<SetStateAction<ImagePayload[]>>] {
  const [tray, setTray] = useState<ImagePayload[]>(() => TRAYS.get(sessionId) ?? NO_PICTURES);

  useEffect(() => {
    setTray(TRAYS.get(sessionId) ?? NO_PICTURES);
  }, [sessionId]);

  const write = useCallback<Dispatch<SetStateAction<ImagePayload[]>>>(
    (next) => {
      setTray((was) => {
        const now = typeof next === 'function' ? next(was) : next;
        if (now.length) TRAYS.set(sessionId, now);
        else TRAYS.delete(sessionId);
        return now;
      });
    },
    [sessionId],
  );

  return [tray, write];
}

/** Everything this module is holding, dropped. Only a test wants this. */
export function forgetEveryDraft(): void {
  TRAYS.clear();
  const kept = store();
  if (!kept) return;
  const gone: string[] = [ORDER];
  for (let i = 0; i < kept.length; i += 1) {
    const key = kept.key(i);
    if (key?.startsWith(LINE)) gone.push(key);
  }
  // Collected first and removed after: taking a key out while walking the store
  // moves every key behind it down one, and the walk then skips the next.
  for (const key of gone) kept.removeItem(key);
}
