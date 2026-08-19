/**
 * What reports this machine holds, and the way in from a card.
 *
 * A report is a place under its project now, drawn by the app itself
 * (`src/app/project/report-tab.tsx`), so nothing here draws one: this is the
 * one shared answer to "what reports are there", and a card's link is a link to
 * that place rather than a drawer of its own (bw-7ks.21.14).
 */
"use client";

import { useCallback, useEffect, useState } from "react";

import { useRouter, useSearchParams } from "next/navigation";

import { FileText } from "lucide-react";

import { apiUrl } from "@/lib/api-base";
import { addressWith } from "@/lib/address";
import { isDoltProject } from "@/lib/utils";

export interface ReportEntry {
  project: string;
  slug: string;
  title: string;
  card: string | null;
  /** Questions on it still holding work up — 0 for a report nothing waits on. */
  waiting: number;
}

/**
 * One answer shared by every caller. Each card on the board asks whether it has
 * a report, and a board holds a hundred of them, so without this the screen
 * fires a hundred identical requests on every paint.
 */
let inFlight: Promise<ReportEntry[]> | null = null;

function fetchReports(): Promise<ReportEntry[]> {
  inFlight ??= fetch(apiUrl("/api/reports"))
    .then(res => (res.ok ? res.json() : []))
    .catch(() => [])
    .finally(() => {
      // Held only for the burst of callers that mount together.
      setTimeout(() => { inFlight = null; }, 2_000);
    });
  return inFlight;
}

/** Every report on this machine; the page itself is rebuilt when it is opened. */
export function useReports() {
  const [reports, setReports] = useState<ReportEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    setReports(await fetchReports());
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { reports, isLoading, reload };
}

/**
 * Where the page is fetched from. `fsPath` is the project's directory on disk:
 * the server builds the report there, and the checklist is read by running the
 * board in it. A Dolt-backed project's own path is a database address and no
 * directory at all, which is why this is never that path.
 */
export function reportUrl(entry: Pick<ReportEntry, 'project' | 'slug'>, fsPath: string): string {
  const q = new URLSearchParams({ project: entry.project, slug: entry.slug });
  // Only when this board IS the report's project. The drawer lists every
  // report on the machine, so sending the open board's folder with all of them
  // built one project's report against another's board (bw-pqt.18). Without a
  // folder the server looks the right one up from its own project list.
  if (fsPath && ownsReport(fsPath, entry.project)) q.set("path", fsPath);
  return apiUrl(`/api/reports/page?${q.toString()}`);
}

/** Whether `fsPath` is the folder a report filed under `project` is about. */
function ownsReport(fsPath: string, project: string): boolean {
  const parts = fsPath.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] === project;
}

/** The report belonging to this card, or null when it has none. */
export function useCardReport(card: string): ReportEntry | null {
  const { reports } = useReports();
  return reports.find(r => r.card === card) ?? null;
}

interface CardReportLinkProps {
  entry: ReportEntry;
  fsPath: string;
}

/**
 * A card's report, worn where the card already wears its comment count: it is
 * one of the card's own facts. Anything sitting outside the card's frame reads
 * as a separate object stuck underneath it, which is what this replaced.
 *
 * It goes to the report's own place under this project — the same address the
 * Reports tab writes, so the report opens full-width inside the app and Back
 * returns to the board the reader left (bw-7ks.21.14).
 */
export function CardReportLink({ entry, fsPath }: CardReportLinkProps) {
  const params = useSearchParams();
  const router = useRouter();

  // With no directory to build the page in, the link could only open an error.
  if (!fsPath || isDoltProject(fsPath)) return null;

  return (
    <button
      type="button"
      data-testid="card-report-link"
      data-report-slug={entry.slug}
      onClick={e => {
        e.stopPropagation(); // the card underneath opens its own detail panel
        // Pushed, so Back is the board: a report read from a card is a step
        // away from the card, not a new place the reader has to find his way
        // out of.
        router.push(addressWith(params, { tab: 'reports', report: entry.slug, section: null }));
      }}
      title={entry.title}
      className="flex items-center gap-1 text-[10px] font-medium text-t-tertiary
                 hover:text-t-primary hover:underline transition-colors"
    >
      <FileText className="size-3 shrink-0" aria-hidden="true" />
      Manager report
    </button>
  );
}
