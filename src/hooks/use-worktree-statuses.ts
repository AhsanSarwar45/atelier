/**
 * Hook for fetching worktree statuses for multiple beads
 *
 * Efficiently fetches worktree status (exists, path, ahead, behind, dirty)
 * for all beads in a project and keeps the data updated via polling.
 */

import { useState, useEffect, useCallback, useRef } from "react";

import * as api from "@/lib/api";
import type { WorktreeStatus } from "@/types";

/** Default polling interval in milliseconds */
const DEFAULT_POLLING_INTERVAL = 30_000;

/**
 * How many of these are allowed to be in the air at once. A browser opens six
 * connections to a host; leaving four of them free is what keeps the rest of
 * the app answering while a board full of worktrees is being read.
 */
const AT_A_TIME = 2;

/**
 * Result type for the useWorktreeStatuses hook
 */
export interface UseWorktreeStatusesResult {
  /** Map of bead ID to worktree status */
  statuses: Record<string, WorktreeStatus>;
  /** Whether statuses are currently being loaded */
  isLoading: boolean;
  /** Any error that occurred during loading */
  error: Error | null;
  /** Manually refresh worktree statuses */
  refresh: () => Promise<void>;
}

/**
 * Default worktree status for beads without a worktree
 */
const DEFAULT_STATUS: WorktreeStatus = {
  exists: false,
  worktree_path: null,
  branch: null,
  ahead: 0,
  behind: 0,
  dirty: false,
  last_modified: null,
};

/**
 * Hook to fetch and track worktree statuses for beads
 *
 * @param projectPath - Absolute path to the project git repository
 * @param beadIds - Array of bead IDs to check worktree status for
 * @param pollingInterval - Polling interval in milliseconds (default: 30000)
 * @returns Object containing statuses map, loading state, error, and refresh function
 *
 * @example
 * ```tsx
 * function KanbanBoard({ projectPath, beads }) {
 *   const beadIds = beads.map(b => b.id);
 *   const { statuses, isLoading } = useWorktreeStatuses(projectPath, beadIds);
 *
 *   return beads.map(bead => (
 *     <BeadCard
 *       key={bead.id}
 *       bead={bead}
 *       worktreeStatus={statuses[bead.id]}
 *     />
 *   ));
 * }
 * ```
 */
export function useWorktreeStatuses(
  projectPath: string,
  beadIds: string[],
  pollingInterval = DEFAULT_POLLING_INTERVAL
): UseWorktreeStatusesResult {
  const [statuses, setStatuses] = useState<Record<string, WorktreeStatus>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Track if initial load has completed
  const hasLoadedRef = useRef(false);

  /** The round in the air, so it can be dropped when the board goes away. */
  const inflightRef = useRef<AbortController | null>(null);

  // Stabilize beadIds — only update ref when IDs actually change
  const beadIdsRef = useRef<string[]>(beadIds);
  const beadIdsKey = beadIds.join(",");
  useEffect(() => {
    beadIdsRef.current = beadIds;
  }, [beadIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Load worktree statuses, a few at a time
   *
   * Each one is a git status on disk and takes seconds; a browser holds only
   * six connections to a host, so asking for all of them at once starves
   * everything else the screen needs — measured, it put the chat's own list
   * eight seconds behind (bw-ccm.3). They are also dropped the moment this
   * board leaves the screen.
   */
  const loadStatuses = useCallback(async () => {
    const ids = beadIdsRef.current;
    if (!projectPath || ids.length === 0) {
      setStatuses({});
      setIsLoading(false);
      return;
    }

    // Only show loading on initial load
    if (!hasLoadedRef.current) {
      setIsLoading(true);
    }

    inflightRef.current?.abort();
    const run = new AbortController();
    inflightRef.current = run;

    try {
      const results: { beadId: string; status: WorktreeStatus }[] = [];
      const queue = [...ids];
      const worker = async () => {
        for (let beadId = queue.shift(); beadId !== undefined; beadId = queue.shift()) {
          try {
            results.push({ beadId, status: await api.git.worktreeStatus(projectPath, beadId, run.signal) });
          } catch {
            // A worktree that cannot be read has none as far as the card knows.
            results.push({ beadId, status: DEFAULT_STATUS });
          }
        }
      };
      await Promise.all(Array.from({ length: AT_A_TIME }, worker));
      if (run.signal.aborted) return;

      // Build statuses map
      const beadStatuses: Record<string, WorktreeStatus> = {};
      for (const { beadId, status } of results) {
        beadStatuses[beadId] = status;
      }

      setStatuses(beadStatuses);
      setError(null);
      hasLoadedRef.current = true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      console.error("Failed to load worktree statuses:", error);
    } finally {
      setIsLoading(false);
    }
  }, [projectPath]);

  /**
   * Public refresh function for manual reload
   */
  const refresh = useCallback(async () => {
    await loadStatuses();
  }, [loadStatuses]);

  // Load statuses when project path or bead IDs change
  useEffect(() => {
    hasLoadedRef.current = false;
    loadStatuses();
    return () => inflightRef.current?.abort();
  }, [loadStatuses, beadIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Set up periodic refresh (polling)
  useEffect(() => {
    if (!projectPath || beadIdsRef.current.length === 0) return;

    const intervalId = setInterval(() => {
      loadStatuses();
    }, pollingInterval);

    return () => clearInterval(intervalId);
  }, [projectPath, loadStatuses, pollingInterval]);

  return {
    statuses,
    isLoading,
    error,
    refresh,
  };
}
