'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { grids as gridsApi } from '@/lib/api';
import type { GridDetail, GridsList } from '@/workbench/grids/types';
import { onWorkbench } from '@/workbench/live-wire';

/**
 * Whether a frame on the `workbench` feed says this project's grids changed
 * (`{type: "grids.changed", kind: "grids.changed", projectId, slug}`). Given a
 * slug, any change in the project still counts: a reference row shows another
 * grid's cells.
 */
export function gridsChangedFor(data: string, projectId: string): boolean {
  if (!data.includes('grids.changed')) return false;
  try {
    const frame = JSON.parse(data) as { type?: unknown; kind?: unknown; projectId?: unknown };
    return (frame.type === 'grids.changed' || frame.kind === 'grids.changed') && frame.projectId === projectId;
  } catch {
    return false;
  }
}

/** Whether a frame says this project's tasks changed: a claim moved with them. */
function tasksChangedIn(data: string, projectId: string): boolean {
  if (!data.includes('tasks.changed')) return false;
  try {
    const frame = JSON.parse(data) as { type?: unknown; kind?: unknown; projectId?: unknown };
    return (frame.type === 'tasks.changed' || frame.kind === 'tasks.changed') && frame.projectId === projectId;
  } catch {
    return false;
  }
}

export interface Read<T> {
  data: T | null;
  /** False until the first answer, so a screen can tell "none" from "not yet". */
  loaded: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * One read kept current by the `workbench` feed: read again whenever the
 * project's grids change, and after a dropped connection, which may have
 * missed a change.
 */
function useLiveRead<T>(projectId: string | null, key: string | null, read: (() => Promise<T>) | null, alsoTasks = false): Read<T> {
  const [data, setData] = useState<T | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [round, setRound] = useState(0);
  const refetch = useCallback(() => setRound((n) => n + 1), []);
  const reader = useRef(read);
  reader.current = read;

  useEffect(() => {
    setData(null);
    setLoaded(false);
    setError(null);
  }, [key]);

  useEffect(() => {
    if (!key || !reader.current) return;
    let alive = true;
    reader.current()
      .then((found) => {
        if (!alive) return;
        setData(found);
        setError(null);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoaded(true);
      });
    return () => { alive = false; };
  }, [key, round]);

  const missed = useRef(false);
  useEffect(() => {
    if (!projectId || !key) return;
    return onWorkbench({
      frame: (data) => {
        if (missed.current || gridsChangedFor(data, projectId) || (alsoTasks && tasksChangedIn(data, projectId))) {
          missed.current = false;
          refetch();
        }
      },
      dropped: () => { missed.current = true; },
    });
  }, [projectId, key, alsoTasks, refetch]);

  return useMemo(() => ({ data, loaded, error, refetch }), [data, loaded, error, refetch]);
}

/** A project's grids and templates, kept current. */
export function useGrids(projectId: string | null): Read<GridsList> {
  return useLiveRead(
    projectId,
    projectId ? `grids:${projectId}` : null,
    projectId ? () => gridsApi.list(projectId) : null,
  );
}

/** One grid's rows, columns and cells, kept current. */
export function useGrid(projectId: string | null, slug: string | null): Read<GridDetail> {
  return useLiveRead(
    projectId,
    projectId && slug ? `grid:${projectId}:${slug}` : null,
    projectId && slug ? () => gridsApi.get(projectId, slug) : null,
    true,
  );
}
