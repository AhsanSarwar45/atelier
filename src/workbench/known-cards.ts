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
import type { BeadStatus } from '@/types';

/** How long an answer stands before the next reader asks again. */
const KEPT_MS = 60_000;

const EMPTY: ReadonlySet<string> = new Set<string>();
const EMPTY_STATUSES: ReadonlyMap<string, BeadStatus> = new Map<string, BeadStatus>();

const asked = new Map<string, { at: number; cards: Promise<Map<string, BeadStatus>> }>();

function cardsOf(projectPath: string): Promise<Map<string, BeadStatus>> {
  const had = asked.get(projectPath);
  if (had && Date.now() - had.at < KEPT_MS) return had.cards;
  const cards = loadProjectBeads(projectPath)
    .then((beads) => new Map(beads.map((b) => [b.id, b.status])))
    // A board that cannot be read is a board with no cards to click, which is
    // the text drawn plainly — never an error in the middle of a conversation.
    .catch(() => new Map<string, BeadStatus>());
  asked.set(projectPath, { at: Date.now(), cards });
  return cards;
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
    void cardsOf(projectPath).then((found) => {
      if (alive) setIds(new Set(found.keys()));
    });
    return () => {
      alive = false;
    };
  }, [projectPath]);

  return ids;
}

/** Live status by id, sharing the same one-minute board read as known ids. */
export function useKnownCardStatuses(projectPath: string | null): ReadonlyMap<string, BeadStatus> {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, BeadStatus>>(EMPTY_STATUSES);

  useEffect(() => {
    if (!projectPath) {
      setStatuses(EMPTY_STATUSES);
      return;
    }
    let alive = true;
    void cardsOf(projectPath).then((found) => {
      if (alive) setStatuses(found);
    });
    return () => { alive = false; };
  }, [projectPath]);

  return statuses;
}
