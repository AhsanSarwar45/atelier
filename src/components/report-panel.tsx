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

export interface ReportEntry {
  project: string;
  slug: string;
  title: string;
  card: string | null;
}

/** Every report on this machine; the page itself is rebuilt when it is opened. */
export function useReports() {
  const [reports, setReports] = useState<ReportEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/reports");
      setReports(res.ok ? await res.json() : []);
    } catch {
      setReports([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { reports, isLoading, reload };
}

export function reportUrl(entry: ReportEntry, projectPath: string): string {
  const q = new URLSearchParams({
    project: entry.project,
    slug: entry.slug,
    path: projectPath,
  });
  return `/api/reports/page?${q.toString()}`;
}

interface ReportPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  /** Opens straight onto this card's report when set. */
  card?: string | null;
}

export function ReportPanel({ open, onOpenChange, projectPath, card }: ReportPanelProps) {
  const { reports, isLoading } = useReports();
  const [showing, setShowing] = useState<ReportEntry | null>(null);

  useEffect(() => {
    if (!open) return;
    setShowing(card ? reports.find(r => r.card === card) ?? null : null);
  }, [open, card, reports]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-3xl md:max-w-5xl bg-surface-base border-b-default flex flex-col"
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
        ) : showing ? (
          <div className="flex-1 mt-4 -mx-6 flex flex-col min-h-0">
            <div className="px-6 pb-2 flex items-center gap-3">
              <button
                type="button"
                onClick={() => setShowing(null)}
                className="text-sm text-t-tertiary hover:text-t-primary"
              >
                All reports
              </button>
              <a
                href={reportUrl(showing, projectPath)}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-t-tertiary hover:text-t-primary flex items-center gap-1"
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                Own window
              </a>
            </div>
            <iframe
              title={showing.title}
              src={reportUrl(showing, projectPath)}
              className="flex-1 w-full border-0 bg-white dark:bg-transparent"
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

interface CardReportButtonProps {
  card: string;
  projectPath: string;
}

/** Shown on a card only when that card has a report. */
export function CardReportButton({ card, projectPath }: CardReportButtonProps) {
  const { reports } = useReports();
  const [open, setOpen] = useState(false);
  const mine = reports.find(r => r.card === card);
  if (!mine) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-8 px-3 text-sm font-medium rounded-md flex items-center gap-1.5 bg-surface-overlay/50 text-t-secondary hover:text-t-primary transition-colors"
      >
        <FileText className="size-4" aria-hidden="true" />
        Report
      </button>
      <ReportPanel open={open} onOpenChange={setOpen} projectPath={projectPath} card={card} />
    </>
  );
}
