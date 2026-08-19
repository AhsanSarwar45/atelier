/**
 * One report, fetched as facts rather than as a finished page (bw-7ks.21.4).
 *
 * `GET /api/reports/spec` runs the same builder the old page came from and
 * hands back what the report SAYS — every question with the card it is holding
 * up, the checklist read off the board, each section's blocks — so the app can
 * draw it out of its own parts. A refusal comes back with the builder's own
 * reason (a question naming a card the board has finished, say), and that
 * reason is what the reader is shown: it names the fix, and inventing a
 * friendlier sentence here would hide it.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiUrl } from '@/lib/api-base';

import type { ReportSpec } from '../types';

export interface ReportSpecState {
  spec: ReportSpec | null;
  isLoading: boolean;
  /** The builder's own words when it refused, or the fetch's when the server never answered. */
  error: string | null;
  reload: () => void;
}

/** Where the report's facts and its old self-contained page both live. */
export function reportQuery(project: string, slug: string, fsPath: string): string {
  return new URLSearchParams({ project, slug, path: fsPath }).toString();
}

export function useReportSpec(project: string, slug: string | null, fsPath: string): ReportSpecState {
  const [spec, setSpec] = useState<ReportSpec | null>(null);
  const [isLoading, setIsLoading] = useState(!!slug);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!slug || !project || !fsPath) {
      setSpec(null);
      setIsLoading(false);
      setError(null);
      return undefined;
    }
    let live = true;
    setIsLoading(true);
    setError(null);
    fetch(apiUrl(`/api/reports/spec?${reportQuery(project, slug, fsPath)}`))
      .then(async (res) => {
        const body = await res.text();
        if (!live) return;
        if (!res.ok) {
          setSpec(null);
          setError(body.trim() || `the server answered ${res.status}`);
          return;
        }
        setSpec(JSON.parse(body) as ReportSpec);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setSpec(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (live) setIsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [project, slug, fsPath, attempt]);

  return { spec, isLoading, error, reload };
}
