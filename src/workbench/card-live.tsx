/**
 * A card being worked on says so, on the board.
 *
 * Draws nothing at all unless a chat linked to this card is running right now,
 * so a board of a hundred cards is unchanged until something is actually
 * happening on one of them (docs/agent-workbench.md §8.3). Reads the one live
 * store — no request of its own, however many cards are on screen.
 */
'use client';

import { isLive, useLiveSessions } from '@/workbench/live';

export function CardLiveChat({ beadId }: { beadId: string }) {
  const live = useLiveSessions().find((s) => isLive(s) && s.beads.includes(beadId));
  if (!live) return null;

  // A link rather than a button that navigates: a card is drawn in places that
  // have no router mounted, and a hook that demands one would take those down
  // with it.
  return (
    <a
      data-testid="card-live-chat"
      data-bead-id={beadId}
      data-session-id={live.id}
      href={`/project?id=${encodeURIComponent(live.projectId)}&tab=chat&chat=${encodeURIComponent(live.id)}`}
      // The card's own click opens its details; this one goes to the chat.
      onClick={(e) => e.stopPropagation()}
      className="mt-1.5 flex w-full min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-accent"
    >
      <span className="relative flex size-1.5 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
      </span>
      <span data-testid="card-live-activity" className="truncate">
        {live.activity || 'Working'}
      </span>
    </a>
  );
}
