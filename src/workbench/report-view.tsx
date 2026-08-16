/**
 * A report, inline in the chat and large on click.
 *
 * Both show the very same page the report route already serves; nothing under
 * `reporting/` is touched (docs/agent-workbench.md §8.5). It goes in an iframe
 * rather than being injected, because the report ships its own stylesheet and
 * script and letting those loose in the app's document would wreck both.
 */
'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { reportUrl } from '@/components/report-panel';
import { apiUrl } from '@/lib/api-base';

interface ReportCardProps {
  project: string;
  slug: string;
  /** The project folder the report is about — its pictures and board resolve there. */
  fsPath: string;
}

export function ReportCard({ project, slug, fsPath }: ReportCardProps) {
  const [open, setOpen] = useState(false);
  const src = apiUrl(reportUrl({ project, slug, title: slug, card: null }, fsPath));

  return (
    <>
      <button
        type="button"
        data-testid="report-inline"
        data-report-slug={slug}
        onClick={() => setOpen(true)}
        className="block w-[640px] max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted/20 text-left transition hover:border-primary/60"
      >
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs">
          <span className="font-medium text-foreground">Manager report</span>
          <span className="truncate font-mono text-muted-foreground">{slug}</span>
          <span className="ml-auto shrink-0 text-muted-foreground">click to open</span>
        </div>
        {/* Inert: the preview is a picture of the page, not a place to click about in. */}
        <div className="pointer-events-none h-[220px] w-[640px] overflow-hidden">
          <iframe
            data-testid="report-preview-frame"
            src={src}
            title={`${slug} preview`}
            className="h-[880px] w-[1280px] origin-top-left border-0"
            style={{ transform: 'scale(0.5)' }}
          />
        </div>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-testid="report-modal"
          // Explicit rows: the base dialog is a grid, and auto rows stretch, which
          // would give the title half the modal and push the report down.
          className="grid h-[92vh] w-[94vw] max-w-[94vw] grid-rows-[auto_1fr] gap-0 overflow-hidden p-0"
        >
          <DialogTitle className="flex items-center gap-3 border-b border-border/60 px-4 py-2 text-sm">
            <span>
              Manager report · <span className="font-mono text-muted-foreground">{slug}</span>
            </span>
            {/* Its own button: the page fills the window in an iframe, so a
                keypress lands in the report rather than on the dialog. */}
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-testid="report-modal-close"
              onClick={() => setOpen(false)}
              className="ml-auto mr-6"
            >
              Close
            </Button>
          </DialogTitle>
          <iframe
            data-testid="report-modal-frame"
            src={src}
            title={slug}
            className="h-full w-full border-0 bg-white"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
