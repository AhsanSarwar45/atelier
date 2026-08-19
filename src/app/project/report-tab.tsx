/**
 * A report as a place under its project (bw-7ks.21.4).
 *
 * It is drawn inside the app's own shell — the same bar the board and the chats
 * sit under (docs/designs/app-shell.md §1.5) — and out of the app's own parts
 * (`src/components/report/`), never as somebody else's page held in a frame.
 * Three shapes, decided by how wide the window is and nothing else:
 *
 *   wide    contents pinned at the window's left edge | reading column | links
 *   middle  contents at the left edge, links beneath  | reading column
 *   narrow  contents and links in a strip across the top, report beneath
 *
 * The reading column is the report document's own (~72 letters); the room left
 * over goes to the contents and the links rather than to longer lines, which is
 * the whole reason a report was hard to read in a drawer.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import { Loader2 } from 'lucide-react';

import { ReportDocument } from '@/components/report/report-document';
import { LinksRail } from '@/components/report/screen/links-rail';
import { ReportsList } from '@/components/report/screen/reports-list';
import { TableOfContents, type TocEntry } from '@/components/report/screen/toc';
import { useActiveSection } from '@/components/report/screen/use-active-section';
import { reportQuery, useReportSpec } from '@/components/report/screen/use-report-spec';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { apiUrl } from '@/lib/api-base';
import { addressWith, cardWasPushed } from '@/lib/address';
import { projectDir } from '@/lib/utils';

import { useBoardCards } from './board-cards';

/** The folder name a report is filed under — the server's own basename match. */
function basenameOf(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

export default function ReportTab({
  projectId,
  projectPath,
  projectLocalPath,
  report,
  section,
}: {
  projectId: string | null;
  projectPath: string;
  projectLocalPath?: string | null;
  report: string | null;
  section: string | null;
}) {
  const params = useSearchParams();
  const router = useRouter();
  const go = useCallback(
    (patch: Parameters<typeof addressWith>[1]) => router.push(addressWith(params, patch)),
    [router, params],
  );

  const fsPath = useMemo(
    () => projectDir({ path: projectPath, localPath: projectLocalPath }),
    [projectPath, projectLocalPath],
  );
  const projectName = useMemo(() => basenameOf(fsPath), [fsPath]);
  const { spec, isLoading, error, reload } = useReportSpec(projectName, report, fsPath);

  // The board's own list, read once for the whole screen: the links rail names
  // the cards a report touches by their titles, and they are already here.
  const { beads } = useBoardCards();
  const beadsById = useMemo(() => new Map(beads.map((b) => [b.id, b])), [beads]);

  // The contents: the fixed parts in the one order a report is always built in,
  // with the sections it actually has in the middle.
  const entries: TocEntry[] = useMemo(() => {
    if (!spec) return [];
    return [
      { id: 'act', label: 'What I need from you' },
      { id: 'stat', label: 'Where we are' },
      ...spec.content.map((s) => ({ id: s.id, label: s.label })),
      { id: 'dec', label: 'Decisions' },
      { id: 'next', label: "What's next" },
    ];
  }, [spec]);

  const pane = useRef<HTMLDivElement>(null);
  const ids = useMemo(() => entries.map((e) => e.id), [entries]);
  const active = useActiveSection(ids, pane);

  // Where the reader is put when a report opens, and when they stop being put
  // anywhere: the cached copy paints first and fresh facts replace it a moment
  // later (`use-report-spec.ts`), which drops the reader back at the top — so
  // the two landings below run again on the new facts, and both stand down the
  // moment the reader moves the report themselves.
  const took = useRef(false);
  useEffect(() => {
    took.current = false;
  }, [report, section]);

  useEffect(() => {
    const el = pane.current;
    if (!el) return undefined;
    const theirs = () => {
      took.current = true;
    };
    el.addEventListener('wheel', theirs, { passive: true });
    el.addEventListener('touchmove', theirs, { passive: true });
    el.addEventListener('keydown', theirs);
    return () => {
      el.removeEventListener('wheel', theirs);
      el.removeEventListener('touchmove', theirs);
      el.removeEventListener('keydown', theirs);
    };
  }, [report, spec]);

  const scrollTo = useCallback((id: string) => {
    took.current = true;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // A pasted address may name the part to open on, so honour it once the report
  // is on screen rather than dropping the reader at the top of it.
  useEffect(() => {
    if (!spec || !section || took.current) return;
    document.getElementById(section)?.scrollIntoView({ block: 'start' });
  }, [spec, section]);

  // A report with a question waiting opens on the question (bw-7ks.21.7): the
  // ask is why the manager was handed the link, and the title it sits under is
  // one scroll up. Never over an address that already names the part to land on.
  useEffect(() => {
    if (!spec || section || !report || took.current) return;
    if (!spec.actions.questions.some((q) => q.live)) return;
    document.getElementById('act')?.scrollIntoView({ block: 'start' });
  }, [spec, section, report]);

  const standaloneUrl = apiUrl(`/api/reports/page?${reportQuery(projectName, report ?? '', fsPath)}`);

  // No report named: the tab is this project's list of them.
  if (!report) {
    return (
      <div data-testid="report-tab" className="flex min-h-0 flex-1 flex-col overflow-y-auto p-6">
        <div className="mx-auto w-full max-w-[72ch]">
          <h2 className="mb-4 text-lg font-semibold text-t-primary">Reports</h2>
          <ReportsList
            projectPath={projectPath}
            projectLocalPath={projectLocalPath}
            onOpen={(slug) => go({ tab: 'reports', report: slug })}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="report-tab"
      // One grid, three arrangements. The first column starts at x=0 of the
      // window, which is what pins the contents to its left edge.
      className={[
        'grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_auto_minmax(0,1fr)]',
        'lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)]',
        'xl:grid-cols-[15rem_minmax(0,1fr)_18rem] xl:grid-rows-[minmax(0,1fr)]',
      ].join(' ')}
    >
      <TableOfContents
        entries={entries}
        activeId={active}
        onSelect={scrollTo}
        className={[
          'col-start-1 row-start-1 flex-row overflow-x-auto border-b border-b-default bg-surface-base p-2',
          'lg:flex-col lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-3',
        ].join(' ')}
      />

      {spec && (
      <LinksRail
        spec={spec}
        projectId={projectId}
        projectPath={projectPath}
        beadsById={beadsById}
        onOpenCard={(id) => {
          cardWasPushed();
          go({ card: id });
        }}
        standaloneUrl={standaloneUrl}
        className={[
          // A strip, whatever it holds: the tallest group in it — a card that
          // half a dozen chats have touched — would otherwise stand the links
          // up as a banner and push the report off the screen, so the strip
          // keeps its height and scrolls inside itself.
          'col-start-1 row-start-2 max-h-32 flex-row gap-2 overflow-auto border-b border-b-default p-2 [&>*]:shrink-0',
          'lg:col-start-1 lg:row-start-2 lg:max-h-none lg:flex-col lg:gap-4 lg:overflow-y-auto lg:border-b-0 lg:border-r lg:p-3',
          'xl:col-start-3 xl:row-start-1 xl:border-r-0 xl:border-l xl:border-b-default',
        ].join(' ')}
      />
      )}

      <div
        ref={pane}
        data-testid="report-pane"
        className={[
          'col-start-1 row-start-3 min-h-0 overflow-y-auto p-6',
          'lg:col-start-2 lg:row-start-1 lg:row-span-2',
          'xl:row-span-1',
        ].join(' ')}
      >
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-t-muted" data-testid="report-loading">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Building this report…
          </div>
        )}

        {/* The builder's own refusal, in its own words: it names the rule and
            the fix, and a friendlier sentence here would hide both. */}
        {!isLoading && error && (
          <Panel tone="attention" className="mx-auto max-w-[72ch]" data-testid="report-error">
            <p className="text-sm font-semibold text-t-primary">This report could not be built.</p>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-t-secondary">{error}</pre>
            <Button type="button" variant="outline" size="sm" className="mt-3" onClick={reload}>
              Try again
            </Button>
          </Panel>
        )}

        {!isLoading && !error && spec && <ReportDocument spec={spec} />}
      </div>
    </div>
  );
}
