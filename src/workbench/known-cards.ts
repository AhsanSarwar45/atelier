/**
 * Which card ids this project actually has, for deciding what in a message is
 * worth clicking.
 *
 * The board's own list is held by the board (src/app/project/board-cards.tsx)
 * and mounted only when the board or a card panel is on screen, so the chat tab
 * cannot read it — and mounting it here would put the whole board's fetch
 * behind every chat. This asks for the same list, once per project, and hands
 * back the ids alone.
 *
 * Kept for a minute: a card made during a conversation should become clickable
 * in that conversation, and re-reading the board on every message would not.
 */
'use client';

import { useEffect, useState } from 'react';

import { loadProjectBeads } from '@/lib/beads-parser';

/** How long an answer stands before the next reader asks again. */
const KEPT_MS = 60_000;

const EMPTY: ReadonlySet<string> = new Set<string>();

const asked = new Map<string, { at: number; ids: Promise<Set<string>> }>();

function idsOf(projectPath: string): Promise<Set<string>> {
  const had = asked.get(projectPath);
  if (had && Date.now() - had.at < KEPT_MS) return had.ids;
  const ids = loadProjectBeads(projectPath)
    .then((beads) => new Set(beads.map((b) => b.id)))
    // A board that cannot be read is a board with no cards to click, which is
    // the text drawn plainly — never an error in the middle of a conversation.
    .catch(() => new Set<string>());
  asked.set(projectPath, { at: Date.now(), ids });
  return ids;
}

/** The ids, empty until they arrive. Nothing is chipped while it is empty. */
export function useKnownCards(projectPath: string | null): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(EMPTY);

  useEffect(() => {
    if (!projectPath) {
      setIds(EMPTY);
      return;
    }
    let alive = true;
    void idsOf(projectPath).then((found) => {
      if (alive) setIds(found);
    });
    return () => {
      alive = false;
    };
  }, [projectPath]);

  return ids;
}
