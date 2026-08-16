"use client";

import { useCallback, useEffect, useState } from "react";

import { FileText, Loader2, ExternalLink } from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { apiUrl } from "@/lib/api-base";
import { isDoltProject } from "@/lib/utils";

export interface ReportEntry {
  project: string;
  slug: string;
  title: string;
  card: string | null;
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
export function reportUrl(entry: ReportEntry, fsPath: string): string {
  const q = new URLSearchParams({
    project: entry.project,
    slug: entry.slug,
    path: fsPath,
  });
  return apiUrl(`/api/reports/page?${q.toString()}`);
}

interface ReportPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fsPath: string;
  /** Opens straight onto this card's report when set. */
  card?: string | null;
}

export function ReportPanel({ open, onOpenChange, fsPath, card }: ReportPanelProps) {
  const { reports, isLoading } = useReports();
  const [showing, setShowing] = useState<ReportEntry | null>(null);
  // Every report here is built by running the report tools in the project, so
  // with no directory there is nothing any of these rows could open.
  const buildable = !!fsPath && !isDoltProject(fsPath);

  useEffect(() => {
    if (!open) return;
    setShowing(card ? reports.find(r => r.card === card) ?? null : null);
  }, [open, card, reports]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* A drawer never takes more than half the screen: the board behind it is
          what the reader came back to, and a report page lays out its own
          reading column inside this, so it does not need the room. */}
      <SheetContent
        side="right"
        className="w-full sm:max-w-xl md:max-w-2xl bg-surface-base border-b-default flex flex-col"
      >
        <SheetHeader className="space-y-1">
          <SheetTitle className="flex items-center gap-2 text-t-primary">
            <FileText className="size-5" aria-hidden="true" />
            {showing ? showing.title : "Reports"}
          </SheetTitle>
          <SheetDescription className="text-t-muted">
            {isLoading
              ? "Loading..."
              : showing
                ? showing.project
                : `${reports.length} ${reports.length === 1 ? "report" : "reports"}`}
          </SheetDescription>
        </SheetHeader>

        {isLoading ? (
          <div className="flex items-center justify-center flex-1">
            <Loader2 className="size-5 animate-spin text-t-muted" aria-hidden="true" />
          </div>
        ) : !buildable ? (
          <p className="flex-1 mt-4 text-sm text-t-muted text-center py-12">
            This board has no copy of the project on this machine, so there is
            nowhere to build its reports.
          </p>
        ) : showing ? (
          <div className="flex-1 mt-4 flex flex-col min-h-0">
            <div className="pb-2 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowing(null)}
                className="text-sm text-t-tertiary hover:text-t-primary"
              >
                All reports
              </button>
              <a
                href={reportUrl(showing, fsPath)}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-t-tertiary hover:text-t-primary flex items-center gap-1"
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                Own window
              </a>
            </div>
            {/* Inset and framed: the report is a page being held up, not the
                drawer's own wallpaper. */}
            <iframe
              title={showing.title}
              src={reportUrl(showing, fsPath)}
              className="flex-1 w-full mb-6 rounded-lg border border-b-default/60
                         bg-white dark:bg-transparent"
            />
          </div>
        ) : (
          <div className="flex-1 mt-4 -mx-6 px-6 overflow-y-auto">
            <div className="space-y-2 pb-4">
              {reports.map(r => (
                <button
                  key={`${r.project}/${r.slug}`}
                  type="button"
                  onClick={() => setShowing(r)}
                  className="w-full text-left p-3 rounded-lg border border-b-default bg-surface-raised/50 hover:bg-surface-overlay/30 transition-colors"
                >
                  <div className="text-sm font-medium text-t-primary">{r.title}</div>
                  <div className="text-xs text-t-muted mt-0.5">
                    {r.project}
                    {r.card ? ` · ${r.card}` : ""}
                  </div>
                </button>
              ))}
              {reports.length === 0 && (
                <p className="text-sm text-t-muted py-12 text-center">
                  No reports yet.
                </p>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
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
 */
export function CardReportLink({ entry, fsPath }: CardReportLinkProps) {
  const [open, setOpen] = useState(false);

  // With no directory to build the page in, the button could only open an error.
  if (!fsPath || isDoltProject(fsPath)) return null;

  return (
    <>
      <button
        type="button"
        onClick={e => {
          e.stopPropagation(); // the card underneath opens its own detail panel
          setOpen(true);
        }}
        title={entry.title}
        className="flex items-center gap-1 text-[10px] font-medium text-t-tertiary
                   hover:text-t-primary hover:underline transition-colors"
      >
        <FileText className="size-3 shrink-0" aria-hidden="true" />
        Manager report
      </button>
      <ReportPanel open={open} onOpenChange={setOpen} fsPath={fsPath} card={entry.card} />
    </>
  );
}
