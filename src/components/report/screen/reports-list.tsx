/**
 * The Reports tab with no `report=` in the address: this project's own
 * reports, and nothing else on this machine (bw-7ks.21.4).
 *
 * `useReports()` (`reports.tsx`) answers for every report this computer
 * holds, the same call the drawer and the chat tab already share — one fetch,
 * however many places read it. What is "this project's own" is decided the
 * way the server itself files a report under a project: the last segment of
 * the folder that holds its board (`server/src/routes/reports.rs`'s
 * `resolve_project_path`, mirrored here since the client has no route that
 * already does this filtering for it).
 */
'use client';

import { useMemo } from 'react';

import { FileText, Loader2 } from 'lucide-react';

import { ownReports, reportFolder } from '@/components/report/waiting';
import { useReports, type ReportEntry } from '@/components/reports';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';

export function ReportsList({
  projectPath,
  projectLocalPath,
  onOpen,
}: {
  projectPath: string;
  projectLocalPath?: string | null;
  onOpen: (slug: string) => void;
}) {
  const { reports, isLoading } = useReports();
  const folder = useMemo(
    () => reportFolder(projectPath, projectLocalPath),
    [projectPath, projectLocalPath],
  );
  const ours: ReportEntry[] = useMemo(() => ownReports(reports, folder), [reports, folder]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-1 py-6 text-sm text-t-muted" data-testid="reports-list-loading">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading reports…
      </div>
    );
  }

  if (ours.length === 0) {
    return (
      <p className="px-1 py-6 text-sm text-t-muted" data-testid="reports-list-empty">
        No reports for this project yet.
      </p>
    );
  }

  return (
    <div data-testid="reports-list" className="flex flex-col gap-2">
      {ours.map((r) => (
        <Panel key={r.slug} inset="none" className="p-0">
          <Button
            type="button"
            variant="ghost"
            size="lg"
            data-testid="reports-list-item"
            data-report-slug={r.slug}
            className="h-auto w-full justify-start gap-3 px-4 py-3 text-left"
            onClick={() => onOpen(r.slug)}
          >
            <FileText className="size-4 shrink-0 opacity-60" aria-hidden="true" />
            {/* `items-start` gives each line the width of its own words, and a
                line as wide as its words has nothing to trim — so on a phone
                the title ran on under the badges beside it. `w-full` bounds
                the lines by the column, and the trimming works again. */}
            <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
              <span className="w-full truncate text-sm font-semibold text-t-primary">{r.title}</span>
              <span className="w-full truncate font-mono text-xs text-t-muted">{r.slug}</span>
            </span>
            {r.waiting > 0 && (
              <Badge
                variant="warning"
                appearance="light"
                size="sm"
                shape="circle"
                className="shrink-0"
                data-testid="reports-list-waiting"
              >
                Waiting on you
              </Badge>
            )}
            {r.card && (
              <Badge variant="secondary" appearance="outline" size="sm" shape="circle" className="shrink-0 font-mono">
                {r.card}
              </Badge>
            )}
          </Button>
        </Panel>
      ))}
    </div>
  );
}
