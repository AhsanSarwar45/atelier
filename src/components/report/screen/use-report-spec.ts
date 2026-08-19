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

/**
 * The server turning the report down — a question naming a card the board has
 * finished, say — as opposed to not answering at all. The difference decides
 * whether a report already on the screen is taken away: a refusal means what is
 * on the screen is no longer true, a dropped connection means nothing.
 */
class Refused extends Error {}

/** The report's facts. `fresh` waits for a run of the toolchain. */
async function facts(query: string, fresh: boolean): Promise<string> {
  const res = await fetch(apiUrl(`/api/reports/spec?${query}${fresh ? '&fresh=1' : ''}`));
  const body = await res.text();
  if (!res.ok) throw new Refused(body.trim() || `the server answered ${res.status}`);
  return body;
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
    const query = reportQuery(project, slug, fsPath);

    // Two asks, on purpose (bw-7ks.21.9). The first takes whatever the server
    // built last time, so the report is on the screen at once instead of after
    // ten seconds of toolchain. The second waits for a real run, and replaces
    // what is shown only if the report has actually changed — so a card closed
    // on the board a minute ago still reaches the reader, a few seconds behind
    // the words.
    facts(query, false)
      .then((body) => {
        if (!live) return body;
        setSpec(JSON.parse(body) as ReportSpec);
        setIsLoading(false);
        return body;
      })
      .catch(() => null)
      .then(async (shown) => {
        try {
          const current = await facts(query, true);
          if (!live) return;
          if (current !== shown) setSpec(JSON.parse(current) as ReportSpec);
          setError(null);
        } catch (e: unknown) {
          if (!live) return;
          // A refusal is shown either way: the words on the screen came from a
          // build that no longer holds, and the builder's reason names the fix.
          // A server that simply did not answer takes nothing away.
          if (shown !== null && !(e instanceof Refused)) return;
          setSpec(null);
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          if (live) setIsLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [project, slug, fsPath, attempt]);

  return { spec, isLoading, error, reload };
}
