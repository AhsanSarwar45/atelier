/**
 * Epic parser utility for beads kanban
 *
 * Provides functions to separate epics from tasks, build epic trees,
 * compute progress metrics, and identify blocking relationships.
 */

import { isBlockedBy } from "@/lib/bead-utils";
import { WORKING, counted, finished } from "@/types";
import type { Bead, Epic, EpicProgress } from "@/types";

/**
 * Separates epics from standalone tasks
 *
 * @param beads - Array of all beads
 * @returns Object with separate arrays for epics and standalone tasks
 *
 * @example
 * ```typescript
 * const { epics, tasks } = parseEpicsAndTasks(allBeads);
 * console.log(`Found ${epics.length} epics and ${tasks.length} standalone tasks`);
 * ```
 */
export function parseEpicsAndTasks(beads: Bead[]): {
  epics: Epic[];
  tasks: Bead[];
} {
  if (!beads || beads.length === 0) {
    return { epics: [], tasks: [] };
  }

  const epics: Epic[] = [];
  const tasks: Bead[] = [];

  for (const bead of beads) {
    // Bead is an epic if issue_type is 'epic' OR if it has children
    if (bead.issue_type === 'epic' || (bead.children && bead.children.length > 0)) {
      epics.push({
        ...bead,
        issue_type: 'epic',
        children: bead.children ?? [],
      } as Epic);
    } else if (!bead.parent_id) {
      // Only include tasks that are NOT children of epics (standalone tasks)
      tasks.push(bead);
    }
  }

  return { epics, tasks };
}

/**
 * Attaches child beads to their parent epics
 *
 * @param epics - Array of epic beads
 * @param allBeads - Array of all beads (including children)
 * @returns Array of epics with resolved children attached
 *
 * @example
 * ```typescript
 * const epicsWithChildren = buildEpicTree(epics, allBeads);
 * epicsWithChildren.forEach(epic => {
 *   console.log(`Epic ${epic.id} has ${epic.children.length} children`);
 * });
 * ```
 */
export function buildEpicTree(epics: Epic[], allBeads: Bead[]): Epic[] {
  if (!epics || epics.length === 0) {
    return [];
  }

  if (!allBeads || allBeads.length === 0) {
    return epics;
  }

  // Create a lookup map for fast child access
  const beadMap = new Map<string, Bead>();
  for (const bead of allBeads) {
    beadMap.set(bead.id, bead);
  }

  // Build epic tree with resolved children
  return epics.map((epic) => {
    const children = (epic.children ?? [])
      .map((childId) => beadMap.get(childId))
      .filter((child): child is Bead => child !== undefined);

    return {
      ...epic,
      children: children.map((c) => c.id),
    };
  });
}

/** A job with nothing under it at all: not finished, just empty. */
const NOTHING: EpicProgress = {
  total: 0, completed: 0, inProgress: 0, blocked: 0, dropped: 0,
};

/**
 * How much of a job is done, from the pieces under it.
 *
 * Dropped work is not part of the job. A job of fourteen pieces with four
 * dropped is a job of ten, and it reads ten of ten once those ten are done —
 * counting the dropped ones in the total is what left a finished job stuck at
 * 71% and, because the button that finishes a job is offered at 100% and
 * nowhere else, left it unsignable. What each state counts as is on the one
 * list of states, not spelled again here.
 *
 * @param epic - Epic bead with children
 * @param beadById - Every bead by id, built once for the whole board
 * @param statusById - Every bead's state by id, which the board builds once and
 *   hands down. Building it here meant a fresh table of the whole board per job
 *   card on every redraw, on top of a second one for the pieces themselves.
 * @returns EpicProgress object with computed metrics
 *
 * @example
 * ```typescript
 * const progress = computeEpicProgress(epic, beadById, statusById);
 * console.log(`${progress.completed}/${progress.total} children completed`);
 * console.log(`${progress.blocked} children blocked`);
 * ```
 */
export function computeEpicProgress(
  epic: Epic,
  beadById: ReadonlyMap<string, Bead>,
  statusById: ReadonlyMap<string, string>,
): EpicProgress {
  if (!epic.children || epic.children.length === 0) {
    return NOTHING;
  }

  // Nothing to read the pieces off, so nothing is known about them — least of
  // all which were dropped. Reporting the raw count of references here is the
  // old rule this whole counter exists to remove, and it disagreed with the
  // answer given below once the same empty board is walked properly.
  if (beadById.size === 0) {
    return NOTHING;
  }

  // The board already paid for the one whole-board walk that built this
  // lookup. Each job now reads only its own pieces.
  const children = epic.children
    .map((id) => beadById.get(id))
    .filter((bead): bead is Bead => bead !== undefined);

  // The pieces this job is actually made of, and the ones it dropped.
  const pieces = children.filter((c) => counted(c.status));
  const dropped = children.length - pieces.length;

  const completed = pieces.filter((c) => finished(c.status)).length;
  const inProgress = pieces.filter((c) => c.status === WORKING).length;

  // What blocks a piece is the board's one rule, asked here rather than spelled
  // again, off the table the board already built.
  const blocked = pieces.filter((child) => isBlockedBy(child, statusById)).length;

  return {
    total: pieces.length,
    completed,
    inProgress,
    blocked,
    dropped,
  };
}

/**
 * How much of a job is done, as the number the bar and the card draw.
 *
 * Of the pieces that count, which is what dropping work is for: fourteen
 * pieces with four dropped is a job of ten, and ten finished is all of it.
 *
 * A job with nothing left counting — every piece dropped, or no pieces at all
 * — reads nothing done, not everything done. Nothing was finished there, and a
 * job whose every piece was abandoned is one to drop, not one to sign off; the
 * screen offers the manager the finish only at a hundred, so this is what keeps
 * it from offering him a job where no work happened.
 *
 * Both ends of the bar are held to that: a hundred means every piece is in,
 * and a zero means not one of them is.
 *
 * @param progress - What {@link computeEpicProgress} returned for the job.
 */
export function progressPercent(progress: EpicProgress): number {
  if (progress.total === 0) return 0;
  // A hundred means finished and nothing else. Rounding alone gives it to a job
  // of two hundred pieces with one still open, which then draws a full green
  // bar over work nobody has done — the same lie in a different place.
  if (progress.completed === progress.total) return 100;
  // And a zero means nothing has happened. A job of 250 pieces with one done
  // rounds to zero, which draws the empty bar of a job nobody has started over
  // work that was finished — the same lie at the other end.
  if (progress.completed === 0) return 0;
  return Math.min(99, Math.max(1, Math.round((progress.completed / progress.total) * 100)));
}

/**
 * Computes which beads the given bead blocks (inverse of deps)
 *
 * @param bead - The bead to check
 * @param allBeads - Array of all beads to search for dependents
 * @returns Array of bead IDs that depend on this bead
 *
 * @example
 * ```typescript
 * const blockers = computeBlockers(someBead, allBeads);
 * if (blockers.length > 0) {
 *   console.log(`Completing this task will unblock: ${blockers.join(', ')}`);
 * }
 * ```
 */
export function computeBlockers(bead: Bead, allBeads: Bead[]): string[] {
  if (!bead || !bead.id) {
    return [];
  }

  if (!allBeads || allBeads.length === 0) {
    return [];
  }

  // Find all beads that list this bead in their deps array
  const blockers: string[] = [];

  for (const otherBead of allBeads) {
    if (!otherBead.deps || otherBead.deps.length === 0) {
      continue;
    }

    // If this bead is in the other bead's deps, then this bead blocks it
    if (otherBead.deps.includes(bead.id)) {
      blockers.push(otherBead.id);
    }
  }

  return blockers;
}
