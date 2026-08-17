/**
 * Epic parser utility for beads kanban
 *
 * Provides functions to separate epics from tasks, build epic trees,
 * compute progress metrics, and identify blocking relationships.
 */

import { WORKING, counted, finished, standing } from "@/types";
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
 * @param allBeads - Array of all beads to resolve children from
 * @returns EpicProgress object with computed metrics
 *
 * @example
 * ```typescript
 * const progress = computeEpicProgress(epic, allBeads);
 * console.log(`${progress.completed}/${progress.total} children completed`);
 * console.log(`${progress.blocked} children blocked`);
 * ```
 */
export function computeEpicProgress(epic: Epic, allBeads: Bead[]): EpicProgress {
  if (!epic.children || epic.children.length === 0) {
    return NOTHING;
  }

  if (!allBeads || allBeads.length === 0) {
    return { ...NOTHING, total: epic.children.length };
  }

  // Create lookup map for children
  const beadMap = new Map<string, Bead>();
  for (const bead of allBeads) {
    beadMap.set(bead.id, bead);
  }

  // Resolve child beads
  const children = epic.children
    .map((childId) => beadMap.get(childId))
    .filter((child): child is Bead => child !== undefined);

  // The pieces this job is actually made of, and the ones it dropped.
  const pieces = children.filter((c) => counted(c.status));
  const dropped = children.length - pieces.length;

  const completed = pieces.filter((c) => finished(c.status)).length;
  const inProgress = pieces.filter((c) => c.status === WORKING).length;

  // A piece is blocked while something it waits on is still standing. Work that
  // was dropped is standing in nobody's way, so it blocks nothing.
  const blocked = pieces.filter((child) => {
    if (!child.deps || child.deps.length === 0) {
      return false;
    }

    return child.deps.some((depId) => {
      const depBead = beadMap.get(depId);
      return depBead !== undefined && standing(depBead.status);
    });
  }).length;

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
 * A job every piece of which was dropped has nothing left to do, so it reads
 * finished. A job with no pieces at all is not finished, it is empty.
 *
 * @param progress - What {@link computeEpicProgress} returned for the job.
 */
export function progressPercent(progress: EpicProgress): number {
  if (progress.total > 0) {
    return Math.round((progress.completed / progress.total) * 100);
  }
  return progress.dropped > 0 ? 100 : 0;
}

/**
 * Identifies tasks that are blocked by unresolved dependencies
 *
 * @param beads - Array of all beads to check
 * @returns Array of beads that have blocking dependencies
 *
 * @example
 * ```typescript
 * const blockedTasks = getBlockedTasks(allBeads);
 * console.log(`${blockedTasks.length} tasks are currently blocked`);
 * blockedTasks.forEach(task => {
 *   console.log(`${task.id} blocked by: ${task.deps?.join(', ')}`);
 * });
 * ```
 */
export function getBlockedTasks(beads: Bead[]): Bead[] {
  if (!beads || beads.length === 0) {
    return [];
  }

  // Create lookup map for fast access
  const beadMap = new Map<string, Bead>();
  for (const bead of beads) {
    beadMap.set(bead.id, bead);
  }

  // Filter beads with unresolved dependencies
  return beads.filter((bead) => {
    if (!bead.deps || bead.deps.length === 0) {
      return false;
    }

    // Blocked while something it waits on is still standing. Work that was
    // dropped is standing in nobody's way.
    return bead.deps.some((depId) => {
      const depBead = beadMap.get(depId);
      return depBead !== undefined && standing(depBead.status);
    });
  });
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
