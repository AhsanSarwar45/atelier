/**
 * Shared utility functions for bead display formatting.
 *
 * These pure functions are used across bead-card, bead-detail, epic-card,
 * and subtask-list components.
 */

import type { BeadStatus } from "@/types";

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
  switch (status) {
    case "open":
      return "Open";
    case "in_progress":
      return "In Progress";
    case "inreview":
      return "In Review";
    case "closed":
      return "Closed";
    default:
      return status;
  }
}

/**
 * Get Tailwind color class for status indicator dot
 */
export function getStatusDotColor(status: BeadStatus): string {
  switch (status) {
    case "open":
      return "text-status-open";
    case "in_progress":
      return "text-status-progress";
    case "inreview":
      return "text-status-review";
    case "closed":
      return "text-status-closed";
    default:
      return "text-t-tertiary";
  }
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
 * The beads the kanban columns draw as cards of their own.
 *
 * A child normally belongs inside its epic card, not in a column. But an epic
 * stays open until its last child closes, so drawing only parents leaves the
 * whole working layer invisible — nothing ever reaches In Progress however many
 * sessions are claiming steps. A child that is in progress or in review is
 * therefore a card in its own right; one nobody has started stays inside its
 * epic, so Open does not fill with unstarted steps and Closed does not fill
 * with finished ones.
 *
 * @param beads - Beads whose status has already been mapped to a column.
 */
export function drawnInColumns<T extends { status: string; parent_id?: string }>(
  beads: ReadonlyArray<T>,
): T[] {
  return beads.filter(
    (b) => !b.parent_id || b.status === "in_progress" || b.status === "inreview",
  );
}
