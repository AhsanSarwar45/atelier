/**
 * A report named in a chat, and the way through to it.
 *
 * The chip on the chat's line and the card in the stream are both links to the
 * report's own place under this project — `?tab=reports&report=<slug>`, the
 * same address the Reports tab writes — where the app draws the report out of
 * its own parts. Nothing here holds a page in a frame any more, so a report
 * mentioned in a chat and a report opened from the tab are one place with one
 * address (bw-7ks.21.15).
 */
'use client';

import { useCallback } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import { FileText } from 'lucide-react';

import { useReports } from '@/components/reports';
import { Badge } from '@/components/ui/badge';
import { addressWith } from '@/lib/address';

interface ReportRef {
  project: string;
  slug: string;
}

/**
 * Going to a report from inside a chat.
 *
 * Pushed rather than replaced: the chat is where the reader came from, so Back
 * has to be that conversation, at the message that named the report.
 */
function useOpenReport(slug: string): () => void {
  const params = useSearchParams();
  const router = useRouter();
  return useCallback(() => {
    router.push(addressWith(params, { tab: 'reports', report: slug, section: null }));
  }, [router, params, slug]);
}

/**
 * A report this chat's cards own, as a chip on the chat's line.
 *
 * The chat's own record only ever carries the reports written while this app was
 * watching, and the kit hands back one branch of a long conversation. The board
 * is the surer link: a report names the card it belongs to, so a chat that
 * worked that card has that report (docs/agent-workbench.md §8.2.2).
 */
export function ReportChip({ slug, title }: ReportRef & { title: string }) {
  const open = useOpenReport(slug);
  return (
    <Badge asChild variant="info" appearance="light" size="sm" shape="circle" className="shrink-0">
      <button type="button" data-testid="chat-report-chip" data-report-slug={slug} title={title} onClick={open}>
        <FileText className="mr-1 h-3 w-3" />
        {title}
      </button>
    </Badge>
  );
}

/**
 * A report delivered in the middle of a conversation.
 *
 * It carries what the reader needs to decide whether to stop and read it — its
 * title, and whether anything on it is waiting on his answer — rather than a
 * postage-stamp picture of the page, which was unreadable at that size and cost
 * a build of the whole report to draw.
 */
export function ReportCard({ project, slug }: ReportRef) {
  const open = useOpenReport(slug);
  const { reports } = useReports();
  const entry = reports.find((r) => r.project === project && r.slug === slug);

  return (
    <button
      type="button"
      data-testid="report-inline"
      data-report-slug={slug}
      onClick={open}
      className="block w-[640px] max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted/20 text-left transition hover:border-primary/60"
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="font-medium text-foreground">Manager report</span>
        <span className="truncate font-mono text-muted-foreground">{slug}</span>
        {entry && entry.waiting > 0 && (
          <Badge variant="warning" appearance="light" size="sm" shape="circle" className="ml-auto shrink-0">
            Waiting on you
          </Badge>
        )}
      </div>
      <div className="px-3 py-2">
        <div className="truncate text-sm font-medium text-foreground">{entry?.title ?? slug}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">Click to read it under this project</div>
      </div>
    </button>
  );
}
