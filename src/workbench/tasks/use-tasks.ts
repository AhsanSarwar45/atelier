'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { tasks as tasksApi } from '@/lib/api';
import { onRepository, onWorkbench } from '@/workbench/live-wire';
import type { Task } from '@/workbench/tasks/types';

/**
 * Whether a frame on the `workbench` feed says this project's tasks changed.
 *
 * docs/tasks.md writes the frame as `{type: "tasks.changed", projectId,
 * number}`; the feed's other frames name themselves by `kind`, so either is
 * read.
 */
export function tasksChangedFor(data: string, projectId: string): boolean {
  if (!data.includes('tasks.changed')) return false;
  try {
    const frame = JSON.parse(data) as { type?: unknown; kind?: unknown; projectId?: unknown };
    return (frame.type === 'tasks.changed' || frame.kind === 'tasks.changed') && frame.projectId === projectId;
  } catch {
    return false;
  }
}

export interface TasksRead {
  tasks: Task[];
  /** False until the first answer, so a screen can tell "none" from "not yet". */
  loaded: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * A project's tasks, or one session's, kept current by the live feed.
 *
 * Every change to a task is announced on the `workbench` feed, and the list is
 * read again when it is. A dropped connection may have missed one, so the
 * first frame after it reads the list again too. Given `repo`, a change to
 * that repository reads it again as well, so Merged follows a merge.
 */
export function useTasks(projectId: string | null, sessionId?: string | null, repo?: string | null): TasksRead {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [round, setRound] = useState(0);
  const refetch = useCallback(() => setRound((n) => n + 1), []);

  useEffect(() => {
    setTasks([]);
    setLoaded(false);
    setError(null);
  }, [projectId, sessionId]);

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    tasksApi.list(projectId, sessionId ?? undefined)
      .then((found) => {
        if (!alive) return;
        setTasks(found);
        setError(null);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoaded(true);
      });
    return () => { alive = false; };
  }, [projectId, sessionId, round]);

  const missed = useRef(false);
  useEffect(() => {
    if (!projectId) return;
    return onWorkbench({
      frame: (data) => {
        if (missed.current || tasksChangedFor(data, projectId)) {
          missed.current = false;
          refetch();
        }
      },
      dropped: () => { missed.current = true; },
    });
  }, [projectId, refetch]);

  // Merged or not is read from git, and a merge changes no task, so no
  // `tasks.changed` comes for it. The repository's own feed does.
  useEffect(() => {
    if (!projectId || !repo) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = onRepository(repo, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refetch, 500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      stop();
    };
  }, [projectId, repo, refetch]);

  return useMemo(() => ({ tasks, loaded, error, refetch }), [tasks, loaded, error, refetch]);
}

/**
 * The project's tasks as the open chat screen knows them, so a card drawn in
 * the transcript shows the status a task has now rather than the one it had
 * when the card was printed. Absent outside a chat screen: the card then
 * draws its own snapshot.
 */
export const LiveTasksContext = createContext<ReadonlyMap<number, Task> | null>(null);

/** The task as it stands now, where the screen knows; otherwise the snapshot. */
export function useLiveTask(snapshot: Task): Task {
  const live = useContext(LiveTasksContext);
  const now = live?.get(snapshot.number);
  return now && now.projectId === snapshot.projectId ? now : snapshot;
}

/** Tasks by number, for `LiveTasksContext`. */
export function byNumber(tasks: Task[]): ReadonlyMap<number, Task> {
  return new Map(tasks.map((task) => [task.number, task]));
}
