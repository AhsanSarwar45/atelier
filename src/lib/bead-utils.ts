/**
 * Shared utility functions for bead display formatting.
 *
 * These pure functions are used across bead-card, bead-detail, epic-card,
 * and subtask-list components.
 */

import { classesFor } from "@/lib/state-styles";
import {
  FINISHED, STATE_BY_ID, STATES, UNTOUCHED, WORKING, type BeadStatus,
} from "@/types";

/** Nothing is still standing under a card in one of these. */
const DONE: ReadonlySet<string> = new Set<string>(
  STATES.filter((s) => !s.live).map((s) => s.id),
);
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
 * Detect if bead is blocked by checking for unresolved dependencies.
 *
 * A bead is blocked when at least one of its dependencies (resolved
 * via {@link allBeads}) has a status other than `closed`. Closed beads
 * are never considered blocked. Dependencies that cannot be found in
 * {@link allBeads} (e.g. references to deleted beads) do NOT block —
 * this matches the behaviour of `bd ready` and `getBlockedTasks` in
 * `epic-parser.ts`.
 *
 * @param bead - The bead to evaluate (only `status` and `deps` are used).
 * @param allBeads - All beads available for dep resolution. Pass the
 *   full board state — `deps` lookup is O(deps.length) over a Map.
 */
export function isBlocked(
  bead: { status: string; deps?: string[] | null },
  allBeads: ReadonlyArray<{ id: string; status: string }>,
): boolean {
  if (bead.status === "closed") return false;
  const deps = bead.deps ?? [];
  if (deps.length === 0) return false;
  const statusById = new Map(allBeads.map((b) => [b.id, b.status]));
  return deps.some((depId) => {
    const status = statusById.get(depId);
    return status !== undefined && status !== "closed";
  });
}

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
 * The column a card belongs in.
 *
 * Read from the pieces DIRECTLY under it and no deeper, so a card and the list
 * of pieces printed beneath it can never disagree — that mismatch is what made
 * an untouched job read as waiting on a reader. All of them open and the card
 * is open; one being worked and it is in progress; all closed and there is
 * nothing left standing. A card with no pieces keeps its own status.
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

  const standing = pieces.filter((k) => !DONE.has(k.status));
  if (standing.length === 0) return FINISHED;
  return standing.some((k) => k.status === WORKING) ? WORKING : UNTOUCHED;
}
