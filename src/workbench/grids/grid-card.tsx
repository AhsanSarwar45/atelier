'use client';

/**
 * The `grid` chat widget (docs/grids.md, "Cards"): the line printed by every
 * `atelier grid` change. The draft, template and N/A lines carry the owner's
 * buttons; prove, audit, discover, pass and reopen lines are read-only
 * summaries. Every line reads its grid again on `grids.changed`, so a line
 * printed long ago shows where things stand now.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import {
  AlertTriangle, Ban, Check, ChevronDown, CircleCheckBig, CircleSlash, Columns3, Grid3x3, RotateCcw, Search, type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Progress } from '@/components/ui/progress';
import { addressWith } from '@/lib/address';
import { grids as gridsApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CellOwnerActions, failure } from '@/workbench/grids/cell-detail';
import {
  draftColumns,
  draftContent,
  draftDiff,
  cellLook,
  LOOK_LABEL,
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

/** A way to open the grid, or one cell of it, in the Tasks tab's Grids view. */
function useOpenGrid(grid: Pick<GridSummary, 'projectId' | 'slug'> | null | undefined, cell?: { row: string; col: string }): (() => void) | null {
  const router = useRouter();
  const params = useSearchParams();
  if (!grid) return null;
  return () => router.push(addressWith(params, {
    id: grid.projectId,
    tab: 'tasks',
    view: 'grids',
    grid: grid.slug,
    cell: cell ? `${cell.row}:${cell.col}` : null,
    task: null,
  }));
}

/** Opens the grid in the Tasks tab's Grids view. */
function OpenGrid({ grid, cell }: { grid: Pick<GridSummary, 'projectId' | 'slug'>; cell?: { row: string; col: string } }) {
  const open = useOpenGrid(grid, cell);
  return <Button type="button" size="sm" variant="ghost" data-testid="grid-open" onClick={() => open?.()}>Open grid</Button>;
}

/* ------------------------------------------------------------------ the row */

type Tone = 'done' | 'warn' | 'plain';

/**
 * One line in a chat for each `atelier grid` change, the way a task's later
 * changes are drawn (task-event-row.tsx): an icon, what happened, and which
 * cell or grid, e.g. `✓ Proved  Glare × Ground truth · camera`. The chevron
 * unfolds the details. While the change waits on the owner (a draft, a
 * template change, an N/A request) its buttons sit on the line, and after the
 * details once they are unfolded.
 */
function GridLine({ event, icon: Icon, tone, label, what, onOpen, answered, more, actions, waiting }: {
  event: string;
  icon: LucideIcon;
  tone: Tone;
  label: string;
  what: string;
  onOpen?: (() => void) | null;
  answered?: string;
  more?: ReactNode;
  actions?: ReactNode;
  waiting: boolean;
}) {
  const [open, setOpen] = useState(() => waiting && gridOpensByDefault(event));
  return (
    <Panel inset="none" data-testid="grid-card" data-event={event} data-waiting={waiting ? 'yes' : 'no'} className="my-1 max-w-4xl">
      <div className="space-y-1 px-3 py-1.5">
        <div className="flex min-h-6 min-w-0 items-center gap-2">
          <Icon aria-hidden className={cn('size-4 shrink-0', tone === 'done' ? 'text-[var(--color-success-accent)]'
            : tone === 'warn' ? 'text-[var(--color-warning-accent)]' : 'text-muted-foreground')} />
          <span data-testid="grid-card-label" className="shrink-0 text-sm">{label}</span>
          {onOpen ? (
            <Button type="button" variant="ghost" size="inherit" data-testid="grid-card-what" onClick={onOpen}
              className="block min-w-0 flex-1 truncate text-left text-sm font-normal text-muted-foreground hover:bg-transparent hover:underline">
              {what}
            </Button>
          ) : <span data-testid="grid-card-what" className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{what}</span>}
          {answered && <Badge variant="secondary" appearance="light" size="sm" data-testid="grid-card-answer" className="shrink-0"><span>{answered}</span></Badge>}
          {more && (
            <Button type="button" variant="ghost" size="none" data-testid="grid-card-toggle" aria-expanded={open}
              aria-label={open ? 'Hide details' : 'Show details'} className="-my-1 size-6 shrink-0 text-muted-foreground" onClick={() => setOpen((o) => !o)}>
              <ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
            </Button>
          )}
        </div>
        {waiting && actions && !(open && more) && <div data-testid="grid-card-actions">{actions}</div>}
      </div>
      {open && more && (
        <div data-testid="grid-card-more" className="space-y-3 border-t border-border/60 px-3 py-2">
          {more}
          {waiting && actions && <div data-testid="grid-card-actions">{actions}</div>}
        </div>
      )}
    </Panel>
  );
}

/** A card about one grid: every card but a template's. */
type GridCardWidget = GridWidget & { grid: GridSummary };

function DraftRow({ widget }: { widget: GridCardWidget }) {
  const snapshot = widget.grid;
  const { data, refetch } = useGrid(snapshot.projectId, snapshot.slug);
  const grid = data?.grid ?? snapshot;
  const draft = grid.pending ? draftContent(grid.pending, grid) : null;
  const edit = grid.status === 'approved';
  const open = useOpenGrid(grid);
  // What stands now, never both the draft and its answer.
  const [label, icon, tone]: [string, LucideIcon, Tone] = draft
    ? [edit ? 'Grid edit' : 'Grid draft', Grid3x3, 'plain']
    : grid.status === 'discarded' ? ['Grid discarded', Ban, 'plain']
      : grid.status === 'approved' ? ['Grid approved', CircleCheckBig, 'done'] : ['Grid draft', Grid3x3, 'plain'];
  return (
    <GridLine event="draft" icon={icon} tone={tone} label={label} what={grid.title || grid.slug} onOpen={grid.status === 'approved' ? open : null}
      waiting={!!draft}
      more={draft ? <DraftView draft={draft} diff={edit && data ? draftDiff(draft, data) : null} /> : null}
      actions={<DraftActions projectId={grid.projectId} slug={grid.slug} onDone={refetch} />} />
  );
}

function TemplateRow({ widget }: { widget: GridWidget }) {
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
  const more = pending ? (
    <div className="space-y-3" data-testid="grid-template">
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
    </div>
  ) : null;
  const actions = (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" data-testid="grid-template-approve" disabled={busy !== null} loading={busy === 'approve_template'} onClick={() => void act('approve_template')}>Approve</Button>
        <Button type="button" size="sm" variant="ghost" data-testid="grid-template-reject" disabled={busy !== null} loading={busy === 'reject_template'} onClick={() => void act('reject_template')}>Reject</Button>
      </div>
      {error && <div role="alert" className="text-xs text-destructive">{`Couldn't update template. ${error}`}</div>}
    </div>
  );
  return (
    <GridLine event="template" icon={Columns3} tone="plain" label="Template change" what={snapshot.name}
      waiting={!!pending} answered={pending ? undefined : 'Answered'} more={more} actions={actions} />
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

const CELL_EVENT: Record<string, [string, LucideIcon, Tone]> = {
  prove: ['Proved', Check, 'done'],
  pass: ['Audit passed', CircleCheckBig, 'done'],
  reopen: ['Reopened', RotateCcw, 'warn'],
  na: ['N/A asked', CircleSlash, 'plain'],
};

function CellRow({ widget }: { widget: GridCardWidget }) {
  const snapshot = widget.cell!;
  const grid = widget.grid;
  const [detail, reread] = useLiveCell(grid.projectId, grid.slug, snapshot.row, snapshot.col);
  const open = useOpenGrid(grid, snapshot);
  const cell = { ...snapshot, ...(detail?.cell ?? {}) };
  const state = cell.state ?? 'unchecked';
  const na = widget.event === 'na';
  const waiting = na && state === 'na_pending';
  const summary = cell.proof?.summary ?? cell.proofSummary;
  const name = detail ? `${detail.row.name} × ${detail.column.name}` : `${snapshot.row} × ${snapshot.col}`;
  let [label, icon, tone] = CELL_EVENT[widget.event] ?? [EVENT_LABEL[widget.event] ?? widget.event, Grid3x3, 'plain' as Tone];
  // An N/A request says how it was answered once it was.
  if (na && !waiting && detail) {
    [label, icon, tone] = state === 'na' ? ['N/A approved', CircleCheckBig, 'done'] : ['N/A rejected', Ban, 'warn'];
  }
  // A proof or a pass that no longer stands says where the cell is now.
  const moved = !na && detail && widget.event !== 'reopen' && state !== 'proved' ? LOOK_LABEL[cellLook({ state, stale: !!cell.stale })] : '';
  const stale = !na && detail && state === 'proved' && cell.stale ? 'Stale' : '';
  const reason = cell.reason ?? snapshot.reason;
  const more = (
    <div className="space-y-2" data-testid="grid-cell-card">
      {reason && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground" data-testid="grid-cell-reason">{reason}</p>}
      {summary && !na && <p className="whitespace-pre-wrap break-words text-sm">{summary}</p>}
      {!waiting && <OpenGrid grid={grid} cell={snapshot} />}
    </div>
  );
  const actions = (
    <CellOwnerActions projectId={grid.projectId} slug={grid.slug} row={snapshot.row} col={snapshot.col} cell={{ state, proof: null }}
      recheck={false} onDone={reread} extra={<OpenGrid grid={grid} cell={snapshot} />} />
  );
  return (
    <GridLine event={widget.event} icon={icon} tone={tone} label={label} what={`${name} · ${grid.slug}`} onOpen={open}
      answered={moved || stale || undefined} waiting={waiting} more={more} actions={waiting ? actions : null} />
  );
}

function AuditRow({ widget }: { widget: GridCardWidget }) {
  const audit = widget.audit;
  const open = useOpenGrid(widget.grid);
  const reopened = audit?.reopened ?? 0;
  const cells = audit?.cells ?? [];
  return (
    <GridLine event="audit" icon={reopened ? AlertTriangle : CircleCheckBig} tone={reopened ? 'warn' : 'done'}
      label={`Audit: ${audit?.passed ?? 0} passed · ${reopened} reopened`} what={widget.grid.slug} onOpen={open} waiting={false}
      more={cells.length > 0 ? (
        <ul className="space-y-1 text-sm" data-testid="grid-audit">
          {cells.map((c) => (
            <li key={`${c.row}.${c.col}`}>
              <span className="font-mono text-xs">{`${c.row}.${c.col}`}</span>
              {c.reason && <span className="text-muted-foreground">{` — ${c.reason}`}</span>}
            </li>
          ))}
        </ul>
      ) : null} />
  );
}

function DiscoverRow({ widget, live }: { widget: GridCardWidget; live: GridSummary }) {
  const run = widget.grid.discovery ?? live.discovery;
  const open = useOpenGrid(widget.grid);
  const failed = run?.ok === false;
  const label = !run ? 'Row search: no run yet' : failed ? 'Row search failed'
    : `Row search: ${run.added?.length ?? 0} added · ${run.missing?.length ?? 0} missing · ${run.back?.length ?? 0} back`;
  const lists = run && !failed && ((run.added?.length ?? 0) + (run.missing?.length ?? 0) + (run.skipped?.length ?? 0) > 0);
  return (
    <GridLine event="discover" icon={failed ? AlertTriangle : Search} tone={failed ? 'warn' : 'plain'} label={label}
      what={widget.grid.slug} onOpen={open} waiting={false}
      more={failed ? (
        <p className="text-sm text-[var(--color-destructive-accent)]" data-testid="grid-discover">{run?.error ?? 'No reason given'}</p>
      ) : lists ? (
        <div className="space-y-1 text-xs" data-testid="grid-discover">
          {run.added && run.added.length > 0 && <div>Added: <IdList ids={run.added} tone="add" /></div>}
          {run.missing && run.missing.length > 0 && <div>Missing: <IdList ids={run.missing} tone="drop" /></div>}
          {run.skipped && run.skipped.length > 0 && (
            <div className="text-muted-foreground">{`Owned by other grids: ${run.skipped.map((s) => `${s.id} (${s.owner})`).join(', ')}`}</div>
          )}
        </div>
      ) : null} />
  );
}

function OtherRow({ widget }: { widget: GridCardWidget }) {
  const open = useOpenGrid(widget.grid);
  return <GridLine event={widget.event} icon={Grid3x3} tone="plain" label={EVENT_LABEL[widget.event] ?? 'Grid changed'} what={widget.grid.slug} onOpen={open} waiting={false} />;
}

/* ------------------------------------------------------------------ the card */

const EVENT_LABEL: Record<string, string> = {
  draft: 'Grid draft', template: 'Template change', prove: 'Proved', na: 'N/A asked', audit: 'Audit',
  reopen: 'Reopened', pass: 'Audit passed', discover: 'Row search',
};

/** Draft, template and N/A rows wait on the owner and start open while they do; the rest start folded. */
export function gridOpensByDefault(event: string): boolean {
  return event === 'draft' || event === 'template' || event === 'na';
}

/** The `grid` chat widget: one line per change (docs/grids.md, "Cards"). */
export function GridCard({ widget }: { widget: GridWidget }) {
  const template = widget.event === 'template';
  const discover = widget.event === 'discover';
  const { data } = useGrids(discover ? widget.grid?.projectId ?? null : null);
  // Every card but a template's is about a grid; the reader refuses one without.
  const about = widget.grid ? widget as GridCardWidget : null;
  if (template) return <TemplateRow widget={widget} />;
  if (!about) return null;
  if (widget.event === 'draft') return <DraftRow widget={about} />;
  if (widget.event === 'audit') return <AuditRow widget={about} />;
  if (discover) return <DiscoverRow widget={about} live={data?.grids.find((g) => g.slug === about.grid.slug) ?? about.grid} />;
  if (widget.cell) return <CellRow widget={about} />;
  return <OtherRow widget={about} />;
}
