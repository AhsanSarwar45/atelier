'use client';

/**
 * The `grid` chat widget (docs/grids.md, "Cards"): the card printed by every
 * `atelier grid` change. The draft, template and N/A cards carry the owner's
 * buttons; prove, audit, discover, pass and reopen cards are read-only
 * summaries. Every card reads its grid again on `grids.changed`, so a card
 * printed long ago shows where things stand now.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import { ChevronRight, Grid3x3 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Panel } from '@/components/ui/panel';
import { Progress } from '@/components/ui/progress';
import { addressWith } from '@/lib/address';
import { grids as gridsApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CellOwnerActions, CellStateChip, failure } from '@/workbench/grids/cell-detail';
import {
  draftColumns,
  draftContent,
  draftDiff,
  type CellDetail,
  type DraftContent,
  type DraftDiff,
  type GridOwnerAction,
  type GridSummary,
  type GridWidget,
} from '@/workbench/grids/types';
import { gridsChangedFor, useGrid, useGrids } from '@/workbench/grids/use-grids';
import { onWorkbench } from '@/workbench/live-wire';

/* ------------------------------------------------------------------ pieces */

function Label({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

function IdList({ ids, tone }: { ids: string[]; tone?: 'add' | 'drop' }) {
  if (!ids.length) return null;
  return (
    <span className={cn('font-mono text-xs', tone === 'add' && 'text-[var(--color-success-accent)]', tone === 'drop' && 'text-[var(--color-destructive-accent)]')}>
      {ids.join(', ')}
    </span>
  );
}

/** A grid's percent proved as a bar and a number. */
export function PercentBar({ percent, className }: { percent: number | null; className?: string }) {
  if (percent === null || percent === undefined) return null;
  return (
    <div className={cn('flex items-center gap-2', className)} data-testid="grid-percent" data-percent={percent}>
      <Progress value={percent} size="sm" tone={percent >= 100 ? 'success' : 'default'} aria-label="Proved" className="min-w-16 flex-1" />
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{`${percent}%`}</span>
    </div>
  );
}

/**
 * What a draft holds: title, area, template, columns (template ones marked),
 * rows grouped by kind, the row search, and for an edit what it changes.
 */
export function DraftView({ draft, diff }: { draft: DraftContent; diff?: DraftDiff | null }) {
  const features = draft.rows.filter((r) => r.kind === 'feature');
  const combinations = draft.rows.filter((r) => r.kind === 'combination');
  const references = draft.rows.filter((r) => r.kind === 'reference');
  const name = new Map(draft.rows.map((r) => [r.id, r.name]));
  const changes = diff && (diff.columnsAdded.length || diff.columnsRetired.length || diff.rowsAdded.length || diff.rowsRemoved.length);
  return (
    <div className="space-y-3" data-testid="grid-draft">
      {draft.area && <p className="whitespace-pre-wrap text-sm">{draft.area}</p>}
      {draft.template && <p className="text-xs text-muted-foreground">{`Template: ${draft.template}`}</p>}
      {diff && (
        <Panel tone="info" inset="sm" className="space-y-1 text-xs" data-testid="grid-draft-diff">
          {!changes && <div>No rows or columns change</div>}
          {diff.columnsAdded.length > 0 && <div>Columns added: <IdList ids={diff.columnsAdded} tone="add" /></div>}
          {diff.columnsRetired.length > 0 && <div>Columns retired: <IdList ids={diff.columnsRetired} tone="drop" /></div>}
          {diff.rowsAdded.length > 0 && <div>Rows added: <IdList ids={diff.rowsAdded} tone="add" /></div>}
          {diff.rowsRemoved.length > 0 && <div>Rows removed: <IdList ids={diff.rowsRemoved} tone="drop" /></div>}
        </Panel>
      )}
      <section className="space-y-1">
        <Label>{`Columns (${draft.columns.length})`}</Label>
        <ul className="space-y-1">
          {draft.columns.map((c) => (
            <li key={c.id} className="text-sm" data-testid="grid-draft-column" data-template={c.fromTemplate ? 'yes' : 'no'}>
              <span className="font-medium">{c.name}</span>
              {c.fromTemplate && <Badge variant="secondary" size="xs" className="ml-1.5 align-middle"><span>Template</span></Badge>}
              {c.proofRule && <div className="text-xs text-muted-foreground">{c.proofRule}</div>}
            </li>
          ))}
        </ul>
      </section>
      <section className="space-y-1">
        <Label>{`Rows (${draft.rows.length})`}</Label>
        {features.length > 0 && (
          <div className="text-sm" data-testid="grid-draft-features">{features.map((r) => r.name).join(', ')}</div>
        )}
        {combinations.length > 0 && (
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">Combinations</div>
            <ul className="text-sm">
              {combinations.map((r) => <li key={r.id}>{r.name} <span className="text-xs text-muted-foreground">{`(${r.of.map((id) => name.get(id) ?? id).join(' × ')})`}</span></li>)}
            </ul>
          </div>
        )}
        {references.length > 0 && (
          <div className="space-y-0.5">
            <div className="text-xs text-muted-foreground">References</div>
            <ul className="text-sm italic">
              {references.map((r) => <li key={r.id}>{r.name} <span className="text-xs not-italic text-muted-foreground">{r.ref ? `(owned by ${r.ref.grid})` : ''}</span></li>)}
            </ul>
          </div>
        )}
      </section>
      {draft.command && (
        <section className="space-y-1">
          <Label>Row search</Label>
          <Panel inset="sm" className="break-all font-mono text-xs">{draft.command}</Panel>
          {draft.watch.length > 0 && <div className="text-xs text-muted-foreground">{`Watches ${draft.watch.join(', ')}`}</div>}
        </section>
      )}
    </div>
  );
}

/** Approve and Discard for a draft or an edit. */
export function DraftActions({ projectId, slug, onDone }: { projectId: string; slug: string; onDone?: () => void }) {
  const [busy, setBusy] = useState<GridOwnerAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: 'approve' | 'discard') => {
    setBusy(action);
    setError(null);
    try {
      await gridsApi.act(action, { projectId, slug });
      onDone?.();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" data-testid="grid-draft-actions">
        <Button type="button" size="sm" data-testid="grid-approve" disabled={busy !== null} loading={busy === 'approve'} onClick={() => void act('approve')}>Approve</Button>
        <Button type="button" size="sm" variant="ghost" data-testid="grid-discard" disabled={busy !== null} loading={busy === 'discard'} onClick={() => void act('discard')}>Discard</Button>
      </div>
      {error && <div role="alert" className="text-xs text-destructive">{`Couldn't update grid. ${error}`}</div>}
    </div>
  );
}

/** Opens the grid in the Tasks tab's Grids view. */
function OpenGrid({ grid, cell }: { grid: Pick<GridSummary, 'projectId' | 'slug'>; cell?: { row: string; col: string } }) {
  const router = useRouter();
  const params = useSearchParams();
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      data-testid="grid-open"
      onClick={() => router.push(addressWith(params, {
        id: grid.projectId,
        tab: 'tasks',
        view: 'grids',
        grid: grid.slug,
        cell: cell ? `${cell.row}:${cell.col}` : null,
        task: null,
      }))}
    >
      Open grid
    </Button>
  );
}

/* ------------------------------------------------------------------ cards */

/** A card about one grid: every card but a template's. */
type GridCardWidget = GridWidget & { grid: GridSummary };

function DraftCard({ widget }: { widget: GridCardWidget }) {
  const snapshot = widget.grid;
  const { data, refetch } = useGrid(snapshot.projectId, snapshot.slug);
  const grid = data?.grid ?? snapshot;
  const pending = grid.pending;
  const draft = pending ? draftContent(pending, grid) : null;
  const edit = grid.status === 'approved';
  return (
    <div className="space-y-3">
      {draft ? (
        <>
          <DraftView draft={draft} diff={edit && data ? draftDiff(draft, data) : null} />
          <DraftActions projectId={grid.projectId} slug={grid.slug} onDone={refetch} />
        </>
      ) : (
        <p data-testid="grid-draft-answer" className="text-xs text-muted-foreground">
          {grid.status === 'discarded' ? 'Discarded' : grid.status === 'approved' ? 'Approved' : 'No draft waiting'}
        </p>
      )}
    </div>
  );
}

function TemplateCard({ widget }: { widget: GridWidget }) {
  const snapshot = widget.template;
  const projectId = widget.grid?.projectId ?? snapshot?.projectId ?? null;
  const { data, refetch } = useGrids(projectId);
  const [busy, setBusy] = useState<GridOwnerAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!snapshot) return null;
  const live = data?.templates.find((t) => t.name === snapshot.name) ?? snapshot;
  const pending = live.pending;
  const now = draftColumns(live.columns);
  const next = pending ? draftColumns(pending.columns) : [];
  const had = new Set(now.map((c) => c.id));
  const will = new Set(next.map((c) => c.id));
  const changed = next.filter((c) => {
    const was = now.find((o) => o.id === c.id);
    return was && (was.name !== c.name || was.proofRule !== c.proofRule);
  });
  const change = snapshot.change ?? null;
  const affected = change?.affects
    ?? (data?.grids ?? []).filter((g) => g.template === snapshot.name && g.status === 'approved').map((g) => g.slug);
  const clashes = change?.clashes ?? [];
  const act = async (action: 'approve_template' | 'reject_template') => {
    if (!projectId) return;
    setBusy(action);
    setError(null);
    try {
      await gridsApi.act(action, { projectId, slug: snapshot.name });
      refetch();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-3" data-testid="grid-template">
      {pending ? (
        <>
          <Panel tone="info" inset="sm" className="space-y-1 text-xs">
            {next.filter((c) => !had.has(c.id)).length > 0 && <div>Columns added: <IdList ids={next.filter((c) => !had.has(c.id)).map((c) => c.id)} tone="add" /></div>}
            {now.filter((c) => !will.has(c.id)).length > 0 && <div>Columns removed: <IdList ids={now.filter((c) => !will.has(c.id)).map((c) => c.id)} tone="drop" /></div>}
            {changed.length > 0 && <div>Columns changed: <IdList ids={changed.map((c) => c.id)} /></div>}
          </Panel>
          <ul className="space-y-1">
            {next.map((c) => (
              <li key={c.id} className="text-sm">
                <span className="font-medium">{c.name}</span>
                {c.proofRule && <div className="text-xs text-muted-foreground">{c.proofRule}</div>}
              </li>
            ))}
          </ul>
          {affected.length > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="grid-template-affected">
              {`Changes ${affected.join(', ')}. Existing proofs are kept; @audit the grids it changes.`}
            </p>
          )}
          {clashes.length > 0 && (
            <p className="text-xs text-[var(--color-warning-accent)]">
              {`Kept as the grid's own column: ${clashes.map((c) => `${c.grid}.${c.column}`).join(', ')}`}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" data-testid="grid-template-approve" disabled={busy !== null} loading={busy === 'approve_template'} onClick={() => void act('approve_template')}>Approve</Button>
            <Button type="button" size="sm" variant="ghost" data-testid="grid-template-reject" disabled={busy !== null} loading={busy === 'reject_template'} onClick={() => void act('reject_template')}>Reject</Button>
          </div>
          {error && <div role="alert" className="text-xs text-destructive">{`Couldn't update template. ${error}`}</div>}
        </>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="grid-template-answer">No change waiting</p>
      )}
    </div>
  );
}

/** A cell as it stands now, read again on `grids.changed`. */
function useLiveCell(projectId: string, slug: string, row: string, col: string): [CellDetail | null, () => void] {
  const [detail, setDetail] = useState<CellDetail | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let alive = true;
    gridsApi.cell(projectId, slug, row, col).then((found) => { if (alive) setDetail(found); }).catch(() => {});
    return () => { alive = false; };
  }, [projectId, slug, row, col, round]);
  useEffect(() => onWorkbench({
    frame: (data) => { if (gridsChangedFor(data, projectId)) setRound((n) => n + 1); },
    dropped: () => {},
  }), [projectId]);
  return [detail, () => setRound((n) => n + 1)];
}

function CellCard({ widget, owner }: { widget: GridCardWidget; owner: boolean }) {
  const snapshot = widget.cell!;
  const grid = widget.grid;
  const [detail, reread] = useLiveCell(grid.projectId, grid.slug, snapshot.row, snapshot.col);
  const cell = { ...snapshot, ...(detail?.cell ?? {}) };
  const state = cell.state ?? 'unchecked';
  const summary = cell.proof?.summary ?? cell.proofSummary;
  return (
    <div className="space-y-2" data-testid="grid-cell-card">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{detail ? `${detail.row.name} × ${detail.column.name}` : `${snapshot.row} × ${snapshot.col}`}</span>
        <CellStateChip cell={{ state, stale: !!cell.stale }} />
      </div>
      {cell.reason && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground" data-testid="grid-cell-reason">{cell.reason}</p>}
      {summary && widget.event !== 'na' && <p className="whitespace-pre-wrap break-words text-sm">{summary}</p>}
      {owner && (state === 'na_pending'
        ? <CellOwnerActions projectId={grid.projectId} slug={grid.slug} row={snapshot.row} col={snapshot.col} cell={{ state, proof: null }} recheck={false} onDone={reread} />
        : <p className="text-xs text-muted-foreground" data-testid="grid-na-answer">{state === 'na' ? 'N/A approved' : 'Answered'}</p>)}
      <OpenGrid grid={grid} cell={snapshot} />
    </div>
  );
}

function AuditCard({ widget }: { widget: GridCardWidget }) {
  const audit = widget.audit;
  return (
    <div className="space-y-2" data-testid="grid-audit">
      <p className="text-sm">{`${audit?.passed ?? 0} passed · ${audit?.reopened ?? 0} reopened`}</p>
      {audit?.cells && audit.cells.length > 0 && (
        <ul className="space-y-1 text-sm">
          {audit.cells.map((c) => (
            <li key={`${c.row}.${c.col}`}>
              <span className="font-mono text-xs">{`${c.row}.${c.col}`}</span>
              {c.reason && <span className="text-muted-foreground">{` — ${c.reason}`}</span>}
            </li>
          ))}
        </ul>
      )}
      <OpenGrid grid={widget.grid} />
    </div>
  );
}

function DiscoverCard({ widget, live }: { widget: GridCardWidget; live: GridSummary }) {
  const run = widget.grid.discovery ?? live.discovery;
  return (
    <div className="space-y-1 text-sm" data-testid="grid-discover">
      {!run ? <p className="text-muted-foreground">No run yet</p> : run.ok === false ? (
        <p className="text-[var(--color-destructive-accent)]">{`Row search failed: ${run.error ?? 'no reason given'}`}</p>
      ) : (
        <>
          <p>{`${run.added?.length ?? 0} added · ${run.missing?.length ?? 0} missing · ${run.back?.length ?? 0} back`}</p>
          {run.added && run.added.length > 0 && <div className="text-xs">Added: <IdList ids={run.added} tone="add" /></div>}
          {run.missing && run.missing.length > 0 && <div className="text-xs">Missing: <IdList ids={run.missing} tone="drop" /></div>}
          {run.skipped && run.skipped.length > 0 && (
            <div className="text-xs text-muted-foreground">{`Owned by other grids: ${run.skipped.map((s) => `${s.id} (${s.owner})`).join(', ')}`}</div>
          )}
        </>
      )}
      <OpenGrid grid={widget.grid} />
    </div>
  );
}

/* ------------------------------------------------------------------ the card */

const EVENT_LABEL: Record<string, string> = {
  draft: 'Draft', template: 'Template change', prove: 'Proved', na: 'N/A asked', audit: 'Audit',
  reopen: 'Reopened', pass: 'Audit passed', discover: 'Discovery',
};

/**
 * Draft, template and N/A cards wait on the owner and start open; the rest
 * are updates and start folded.
 */
export function gridOpensByDefault(event: string): boolean {
  return event === 'draft' || event === 'template' || event === 'na';
}

export function GridCard({ widget }: { widget: GridWidget }) {
  const [open, setOpen] = useState(() => gridOpensByDefault(widget.event));
  const template = widget.event === 'template';
  const { data } = useGrids(template ? null : widget.grid?.projectId ?? null);
  const live = data?.grids.find((g) => g.slug === widget.grid?.slug) ?? widget.grid;
  // Every card but a template's is about a grid; the reader refuses one without.
  const about = widget.grid ? widget as GridCardWidget : null;
  const body = template ? <TemplateCard widget={widget} />
    : !about || !live ? null
      : widget.event === 'draft' ? <DraftCard widget={about} />
        : widget.event === 'audit' ? <AuditCard widget={about} />
          : widget.event === 'discover' ? <DiscoverCard widget={about} live={live} />
            : widget.cell ? <CellCard widget={about} owner={widget.event === 'na'} />
              : <OpenGrid grid={about.grid} />;
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid="grid-card" data-event={widget.event}>
      <CollapsibleTrigger
        data-testid="grid-card-toggle"
        className="group/collapsible flex w-full cursor-pointer items-start gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <ChevronRight aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/collapsible:rotate-90" />
        <header className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Grid3x3 aria-hidden className="size-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">{template ? 'Grid template' : 'Coverage grid'}</span>
            <span className="text-xs text-muted-foreground">{EVENT_LABEL[widget.event] ?? widget.event}</span>
            {!template && live?.pending && <Badge variant="warning" appearance="light" size="sm" className="ml-auto"><span>Awaiting approval</span></Badge>}
          </div>
          <h4 className="text-sm font-semibold text-foreground">{template ? widget.template?.name : live?.title || live?.slug}</h4>
          {!template && live?.status === 'approved' && <PercentBar percent={live.percent} className="max-w-xs" />}
        </header>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pl-[1.375rem] pt-3">{body}</CollapsibleContent>
    </Collapsible>
  );
}
