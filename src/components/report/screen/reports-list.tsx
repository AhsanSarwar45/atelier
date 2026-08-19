/**
 * The Reports tab with no `report=` in the address: this project's own
 * reports, and nothing else on this machine (bw-7ks.21.4).
 *
 * `useReports()` (`report-panel.tsx`) answers for every report this computer
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

import { useReports, type ReportEntry } from '@/components/report-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { projectDir } from '@/lib/utils';

/** The folder name a report is filed under — mirrors the server's own basename match. */
function basenameOf(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

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
  const basename = useMemo(
    () => basenameOf(projectDir({ path: projectPath, localPath: projectLocalPath })),
    [projectPath, projectLocalPath],
  );
  const ours: ReportEntry[] = useMemo(
    () => reports.filter((r) => r.project === basename),
    [reports, basename],
  );

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
            <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
              <span className="truncate text-sm font-semibold text-t-primary">{r.title}</span>
              <span className="truncate font-mono text-xs text-t-muted">{r.slug}</span>
            </span>
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
