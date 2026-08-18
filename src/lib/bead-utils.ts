/**
 * Shared utility functions for bead display formatting.
 *
 * These pure functions are used across bead-card, bead-detail, epic-card,
 * and subtask-list components.
 */

import { classesFor } from "@/lib/state-styles";
import {
  STATE_BY_ID, STATES, UNTOUCHED, WORKING, standing, type BeadStatus,
} from "@/types";

/** Places the board itself writes, which columnFor takes as final. */
const SETTLED: ReadonlySet<string> = new Set<string>(
  STATES.filter((s) => s.settled).map((s) => s.id),
);

/**
 * Format bead ID for display, preserving the workspace prefix.
 *
 * Beads supports arbitrary per-workspace ID prefixes (`bd init --prefix`),
 * e.g. `pa-pne9`, `dc-xyz`, `beads-web-2m8`. The prefix is everything before
 * the last dash and is upper-cased for display. The suffix after the last
 * dash is kept as-is (real IDs use lower-case + digits) and truncated to
 * `maxLen`. IDs without a dash are returned upper-cased.
 *
 * @param id - Raw bead ID (e.g., "pa-pne9", "beads-web-2m8", "BD-abc123")
 * @param maxLen - Max chars for the short ID portion (6 for cards, 8 for detail)
 */
export function formatBeadId(id: string, maxLen = 6): string {
  const dashIdx = id.lastIndexOf("-");
  if (dashIdx === -1) return id.toUpperCase();
  const prefix = id.slice(0, dashIdx).toUpperCase();
  const shortId = id.slice(dashIdx + 1, dashIdx + 1 + maxLen);
  return `${prefix}-${shortId}`;
}

/**
 * Format status for display (e.g., "in_progress" -> "In Progress")
 */
export function formatStatus(status: BeadStatus): string {
  return STATE_BY_ID[status]?.label ?? status;
}

/**
 * Why the work stopped, said once.
 *
 * The tracker writes the state's own name at the front of the reason it stores
 * — "cancelled: rests on work that was dropped" — and the screen puts the state
 * in front of it as a heading, so the two together stuttered: "Cancelled:
 * cancelled: rests on...". The heading wins; the copy inside the sentence goes.
 */
export function whyItStopped(status: BeadStatus, reason: string): string {
  const names: string[] = [status, STATE_BY_ID[status]?.label ?? ""]
    .filter(Boolean)
    .map((n) => n.toLowerCase());
  const trimmed = reason.trimStart();
  for (const name of names) {
    if (trimmed.toLowerCase().startsWith(`${name}:`)) {
      return trimmed.slice(name.length + 1).trimStart();
    }
  }
  return trimmed;
}

/**
 * Get Tailwind color class for status indicator dot
 */
export function getStatusDotColor(status: BeadStatus): string {
  return classesFor(status).text;
}

/**
 * Format date for short display (e.g., "Jan 23, 2025")
 */
export function formatShortDate(dateString: string): string {
  try {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return dateString;
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateString;
  }
}

/**
 * Format worktree path for display.
 * Shows only the worktree folder name (e.g., "bd-beads-kanban-ui-0io")
 */
export function formatWorktreePath(path: string): string {
  const match = path.match(/\.worktrees\/(.+)$/);
  if (match) {
    return match[1];
  }
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/**
 * Truncate text to a maximum length with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trim() + "\u2026";
}

/**
 * Whether a bead is waiting on something — the board's one answer to that.
 *
 * It is blocked when at least one of the things it waits on is still standing.
 * Work that was dropped is standing in nobody's way, so it blocks nothing, and
 * a bead with nothing left standing of its own is never blocked. Something it
 * waits on that cannot be found at all (a reference to a deleted card) does NOT
 * block — this matches what `bd ready` does.
 *
 * Everything that asks this question calls this, and the reason is what the
 * dropped state cost: the rule was written out three times, all three had to be
 * taught the same thing in step, and the one that was missed would have gone
 * quietly wrong.
 *
 * @param bead - The bead to evaluate (only `status` and `deps` are used).
 * @param statusById - The status of every bead the deps could name.
 */
export function isBlockedBy(
  bead: { status: string; deps?: string[] | null },
  statusById: ReadonlyMap<string, string>,
): boolean {
  if (!standing(bead.status)) return false;
  const deps = bead.deps ?? [];
  if (deps.length === 0) return false;
  return deps.some((depId) => {
    const status = statusById.get(depId);
    return status !== undefined && standing(status);
  });
}

/*
 * A second way in used to sit here, taking the board as a list and building the
 * lookup itself. Once the board built the lookup once and handed it down,
 * nothing called it — and a second entry point nobody calls is the one that
 * goes quietly wrong when the rule next moves.
 */

/**
 * Card shapes that are mechanism rather than work. A gate is a lock the board
 * puts on a step; it is never something a person picks up and does.
 */
const NOT_WORK = new Set(["gate"]);

/**
 * The beads the kanban columns draw as cards of their own: the goals and the
 * standalone tasks. A step belongs inside the goal it is a step of, which is
 * where the goal card already lists it with its own state.
 *
 * @param beads - Beads whose status has already been mapped to a column.
 */
export function drawnInColumns<T extends { status: string; parent_id?: string; issue_type?: string }>(
  beads: ReadonlyArray<T>,
): T[] {
  return beads.filter((b) => !b.parent_id && !NOT_WORK.has(b.issue_type ?? ""));
}

/**
 * A card the board opened, at the far end of every date it could carry, so a
 * card that cannot say when it opened cannot claim to be the oldest either.
 */
const NO_DATE = "￿";

/**
 * The cards of a column, oldest job first.
 *
 * The manager is the one being waited on, so his column is drawn this way and no
 * other is: nothing sits in it quietly while newer work lands on top. It orders
 * by when each job was opened, not by how long it has been waiting on him — the
 * board stamps that moment on the card, but the screen is handed no metadata to
 * read it from (corsetta cor-lxwb).
 *
 * @param beads - The column's cards. The caller's array is left as it was.
 */
export function oldestFirst<T extends { created_at?: string }>(
  beads: ReadonlyArray<T>,
): T[] {
  return [...beads].sort((a, b) =>
    (a.created_at || NO_DATE).localeCompare(b.created_at || NO_DATE),
  );
}

/**
 * The column a card belongs in.
 *
 * Read from the pieces DIRECTLY under it and no deeper, so a card and the list
 * of pieces printed beneath it can never disagree — that mismatch is what made
 * an untouched job read as waiting on a reader. All of them open and the card
 * is open; one being worked and it is in progress. A card with no pieces, and a
 * card with nothing left standing under it, keeps the status the board holds:
 * finishing the last piece is not the same as being read or signed off, and
 * those are the board's own to write.
 *
 * A review column is the board's own answer, written once every piece has
 * closed, so it is taken as final rather than recomputed here. Manager's
 * ruling, 2026-08-13: corsetta docs/board.md#3a1.
 *
 * Derived for display only — the board's own record is never rewritten from here.
 *
 * @param bead - The card to place.
 * @param byId - Every bead on the board, by id, for reading its pieces.
 */
export function columnFor<T extends { id: string; status: string; children?: string[] | null }>(
  bead: T,
  byId: ReadonlyMap<string, T>,
): string {
  if (SETTLED.has(bead.status)) return bead.status;

  const pieces = (bead.children ?? [])
    .map((id) => byId.get(id))
    .filter((k): k is T => k !== undefined && k.id !== bead.id);
  if (pieces.length === 0) return bead.status;

  const left = pieces.filter((k) => standing(k.status));
  // Nothing left standing is not the same as finished: the board writes the
  // card's own state when it is read and when it is signed off, and until it
  // does, a card it still holds open belongs where it says it is.
  if (left.length === 0) return bead.status;
  return left.some((k) => k.status === WORKING) ? WORKING : UNTOUCHED;
}
