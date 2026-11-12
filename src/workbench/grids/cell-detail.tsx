'use client';

/**
 * One cell in full (docs/grids.md, "Cell detail panel"): its state, why it is
 * open, the proof behind it and what became of each check, its history, and
 * the owner's buttons.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { ArrowLeft, Check, ExternalLink, GitMerge, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { ReadFailed } from '@/components/ui/read-failed';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { grids as gridsApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CreateTaskButton } from '@/workbench/grids/create-task';
import { CellSquare } from '@/workbench/grids/grid-heatmap';
import { blocker } from '@/workbench/grids/selection';
import { cellLook, LOOK_LABEL, type Benchmark, type CellDetail, type CellFull, type GridEvent, type GridOwnerAction } from '@/workbench/grids/types';
import { gridsChangedFor } from '@/workbench/grids/use-grids';
import { onWorkbench } from '@/workbench/live-wire';
import { shotUrl } from '@/workbench/tasks/task-card';
import { ZoomableImage } from '@/workbench/zoomable-image';

export function failure(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.replace(/^API error: \d+\s*/, '');
}

const when = (at: number | null | undefined): string => (at ? new Date(at).toLocaleString() : '');

function Label({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

/** A cell's state as a chip, with its square. */
export function CellStateChip({ cell, className }: { cell: Pick<CellFull, 'state' | 'stale'>; className?: string }) {
  const look = cellLook(cell);
  return (
    <Badge data-testid="cell-state" data-state={cell.state} data-look={look} variant="secondary" appearance="light" size="sm" className={className}>
      <CellSquare look={look} className="size-2.5" />
      <span>{LOOK_LABEL[look]}</span>
    </Badge>
  );
}

/** Whether a benchmark meets its budget: at most it, or at least it when higher is better. */
export function withinBudget(b: Pick<Benchmark, 'value' | 'budget' | 'lower_is_better'>): boolean {
  return b.lower_is_better === false ? b.value >= b.budget : b.value <= b.budget;
}

/**
 * The owner's buttons for one cell: Approve N/A and Reject (with a note) while
 * N/A waits on him, Reopen (with a reason) for a proved or N/A cell, and
 * Re-check for a cell with proof.
 */
export function CellOwnerActions({ projectId, slug, row, col, cell, recheck = true, onDone, extra }: {
  projectId: string;
  slug: string;
  row: string;
  col: string;
  cell: Pick<CellFull, 'state' | 'proof'> & { proofSummary?: string | null };
  /** Offer Re-check: the detail panel does, the N/A card does not. */
  recheck?: boolean;
  onDone?: () => void;
  /** More buttons for the same row, after these (the N/A card's Open grid). */
  extra?: ReactNode;
}) {
  const [busy, setBusy] = useState<GridOwnerAction | null>(null);
  const [asking, setAsking] = useState<'reject_na' | 'reopen' | null>(null);
  const [words, setWords] = useState('');
  const [error, setError] = useState<string | null>(null);
  // A re-check that ran and failed reopens the cell; say why.
  const [checkFailed, setCheckFailed] = useState<string | null>(null);
  const naPending = cell.state === 'na_pending';
  const reopens = cell.state === 'proved' || cell.state === 'na';
  const hasProof = !!cell.proof || !!cell.proofSummary;
  if (!naPending && !reopens && !(recheck && hasProof)) return null;

  const act = async (action: GridOwnerAction, payload?: Record<string, unknown>) => {
    setBusy(action);
    setError(null);
    setCheckFailed(null);
    try {
      const answer = await gridsApi.act(action, { projectId, slug, row, col }, payload);
      if (answer.failed) setCheckFailed(answer.failed);
      setAsking(null);
      setWords('');
      onDone?.();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2" data-testid="cell-actions">
      {asking ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!words.trim()) return;
            void act(asking, asking === 'reject_na' ? { note: words.trim() } : { reason: words.trim() });
          }}
        >
          <Textarea
            autoFocus
            rows={2}
            aria-label={asking === 'reject_na' ? 'Note' : 'Reason'}
            placeholder={asking === 'reject_na' ? 'Why it applies' : 'Reason'}
            value={words}
            onChange={(e) => setWords(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant={asking === 'reject_na' ? 'primary' : 'destructive'} disabled={!words.trim()} loading={busy === asking}>
              {asking === 'reject_na' ? 'Reject' : 'Reopen'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setAsking(null); setWords(''); }}>Back</Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {naPending && (
            <>
              <Button type="button" size="sm" data-testid="cell-approve-na" onClick={() => void act('approve_na')} loading={busy === 'approve_na'} disabled={busy !== null}>Approve N/A</Button>
              <Button type="button" size="sm" variant="outline" data-testid="cell-reject-na" onClick={() => setAsking('reject_na')} disabled={busy !== null}>Reject</Button>
            </>
          )}
          {recheck && hasProof && (
            <Button type="button" size="sm" variant="outline" data-testid="cell-recheck" onClick={() => void act('verify')} loading={busy === 'verify'} disabled={busy !== null}>Re-check</Button>
          )}
          {reopens && (
            <Button type="button" size="sm" variant="ghost" data-testid="cell-reopen" onClick={() => setAsking('reopen')} disabled={busy !== null}>Reopen</Button>
          )}
          {extra}
        </div>
      )}
      {checkFailed && <div role="alert" data-testid="cell-check-failed" className="text-xs text-destructive">{`Re-check failed: ${checkFailed}`}</div>}
      {error && <div role="alert" className="text-xs text-destructive">{`Couldn't update cell. ${error}`}</div>}
    </div>
  );
}

const EVENT_LABEL: Record<string, string> = {
  row_added: 'Row added', column_added: 'Column added', claimed: 'Claimed', released: 'Released',
  proved: 'Proved', check_passed: 'Re-check passed', check_failed: 'Re-check failed', gap: 'Left open',
  na_asked: 'N/A asked', na_approved: 'N/A approved', na_rejected: 'N/A rejected',
  audit_passed: 'Audit passed', reopened: 'Reopened', row_missing: 'Row missing', row_back: 'Row back',
  column_retired: 'Column retired',
};

/** The words an event carries worth showing. */
function eventDetail(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object' || payload === null) return '';
  const p = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof p.task === 'number') parts.push(`Task #${p.task}`);
  for (const key of ['note', 'reason', 'summary']) {
    if (typeof p[key] === 'string' && p[key]) { parts.push(p[key] as string); break; }
  }
  return parts.join(' · ');
}

export function CellHistory({ events }: { events: GridEvent[] }) {
  if (!events.length) return <p className="text-xs text-muted-foreground">No history</p>;
  return (
    <ol data-testid="cell-history" className="space-y-1.5">
      {[...events].sort((a, b) => b.seq - a.seq).map((event) => (
        <li key={event.seq} className="flex gap-2 text-xs">
          <time className="w-32 shrink-0 tabular-nums text-muted-foreground sm:w-36" dateTime={new Date(event.at).toISOString()}>{when(event.at)}</time>
          <div className="min-w-0">
            <span className="font-medium text-foreground">{EVENT_LABEL[event.kind] ?? event.kind}</span>
            <span className="text-muted-foreground">{` · ${event.actor === 'owner' ? 'Owner' : event.actor === 'app' ? 'App' : 'Agent'}`}</span>
            {eventDetail(event.payload) && <div className="whitespace-pre-wrap break-words text-muted-foreground">{eventDetail(event.payload)}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO = /\.(webm|mp4|mov)$/i;

/** The proof behind a cell: summary, checks with their last result, benchmarks, tests, commits, evidence. */
export function ProofView({ cell }: { cell: Pick<CellFull, 'proof' | 'lastCheck' | 'merged'> }) {
  const proof = cell.proof;
  if (!proof) return <p className="text-xs text-muted-foreground">No proof yet</p>;
  const results = new Map((cell.lastCheck?.results ?? []).map((r) => [r.name, r]));
  const benchmarks = proof.benchmarks ?? [];
  const commits = proof.commits ?? [];
  const tests = proof.tests ?? [];
  const evidence = proof.evidence ?? [];
  return (
    <div className="space-y-3" data-testid="cell-proof">
      {proof.summary && <p className="whitespace-pre-wrap break-words text-sm">{proof.summary}</p>}
      {proof.checks?.length > 0 && (
        <div className="space-y-1">
          <Label>Checks</Label>
          <ul className="divide-y divide-border/60">
            {proof.checks.map((check) => {
              const result = results.get(check.name);
              return (
                <li key={check.name} data-testid="cell-check" data-passed={result ? (result.exit === 0 ? 'yes' : 'no') : 'unknown'} className="space-y-0.5 py-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {result ? (
                      result.exit === 0
                        ? <Check aria-label="Passed" className="size-4 text-[var(--color-success-accent)]" />
                        : <X aria-label="Failed" className="size-4 text-[var(--color-destructive-accent)]" />
                    ) : null}
                    <span className="font-medium">{check.name}</span>
                    {result && (
                      <span className="text-xs text-muted-foreground">
                        {result.exit === 0 ? 'Passed' : `Failed (exit ${result.exit})`}
                        {` · ${(result.ms / 1000).toFixed(1)} s`}
                        {cell.lastCheck ? ` · ${when(cell.lastCheck.at)}` : ''}
                      </span>
                    )}
                  </div>
                  <code className="block break-all font-mono text-xs text-muted-foreground">{check.command}</code>
                  {result && result.exit !== 0 && result.tail && (
                    <pre className="max-h-40 overflow-auto rounded bg-muted/50 p-2 text-[11px]">{result.tail}</pre>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {benchmarks.length > 0 && (
        <div className="space-y-1">
          <Label>Benchmarks</Label>
          <div className="overflow-x-auto">
            <table className="w-max min-w-full text-left text-xs" data-testid="cell-benchmarks">
              <thead className="border-b bg-muted/40">
                <tr>{['Benchmark', 'Value', 'Budget', ''].map((h, i) => <th key={i} className="px-2 py-1.5 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {benchmarks.map((b) => {
                  const ok = withinBudget(b);
                  return (
                    <tr key={b.name} className="border-b last:border-0" data-met={ok ? 'yes' : 'no'}>
                      <td className="px-2 py-1.5 font-medium">{b.name}</td>
                      <td className="px-2 py-1.5 tabular-nums">{b.value} {b.unit}</td>
                      <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{b.lower_is_better === false ? '≥' : '≤'} {b.budget} {b.unit}</td>
                      <td className="px-2 py-1.5">
                        {ok
                          ? <Check aria-label="Within budget" className="size-3.5 text-[var(--color-success-accent)]" />
                          : <X aria-label="Over budget" className="size-3.5 text-[var(--color-destructive-accent)]" />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {tests.length > 0 && (
        <div className="space-y-1">
          <Label>Tests</Label>
          <ul className="space-y-0.5">{tests.map((t) => <li key={t} className="break-all font-mono text-xs">{t}</li>)}</ul>
        </div>
      )}
      {commits.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Label>Commits</Label>
          {commits.map((sha) => <Badge key={sha} variant="outline" size="sm"><span className="font-mono">{sha.slice(0, 10)}</span></Badge>)}
          {typeof cell.merged === 'boolean' && (
            <Badge data-testid="cell-merged" data-merged={cell.merged ? 'yes' : 'no'} variant={cell.merged ? 'success' : 'secondary'} appearance="light" size="sm">
              <GitMerge aria-hidden />
              <span>{cell.merged ? 'Merged' : 'Not merged'}</span>
            </Badge>
          )}
        </div>
      )}
      {evidence.length > 0 && (
        <div className="space-y-1">
          <Label>Evidence</Label>
          <div className="flex flex-wrap gap-2">
            {evidence.map((path) => {
              const src = shotUrl(path, null);
              if (src && IMAGE.test(path)) return <ZoomableImage key={path} src={src} alt={path} compact />;
              if (src && VIDEO.test(path)) return <video key={path} src={src} controls preload="metadata" className="max-h-60 w-full rounded bg-black" />;
              return <span key={path} className="break-all text-xs text-muted-foreground">{path}</span>;
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** The detail panel: reads the cell, and again whenever the project's grids change. */
/** Who holds a claimed cell: `Task #14 · Glare fixes`, or `Task #14` when the chat is not known. */
export function claimLine(task: number, chat: { title: string | null } | null | undefined): string {
  return chat?.title ? `Task #${task} · ${chat.title}` : `Task #${task}`;
}

export function CellDetailPanel({ projectId, slug, row, col, gridName, onClose, onOpenTask, onOpenChat, onCreated }: {
  projectId: string;
  slug: string;
  row: string;
  col: string;
  /** The grid's name, for the back control a phone shows in place of the grid. */
  gridName?: string;
  /** Back to the grid. */
  onClose: () => void;
  /** Opens the task that claims the cell. */
  onOpenTask?: (task: number) => void;
  /** Opens the chat a task made here went to. */
  onOpenChat?: (sessionId: string) => void;
  /** A task was made for this cell. */
  onCreated?: () => void;
}) {
  const [detail, setDetail] = useState<CellDetail | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    setDetail(null);
    setError(null);
  }, [projectId, slug, row, col]);

  useEffect(() => {
    let alive = true;
    gridsApi.cell(projectId, slug, row, col)
      .then((found) => { if (alive) { setDetail(found); setError(null); } })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e : new Error(String(e))); });
    return () => { alive = false; };
  }, [projectId, slug, row, col, round]);

  useEffect(() => onWorkbench({
    frame: (data) => { if (gridsChangedFor(data, projectId)) setRound((n) => n + 1); },
    dropped: () => {},
  }), [projectId]);

  const cell = detail?.cell;
  // A cell no task holds and that still needs work can be given to one.
  const claimable = !!detail && !!cell && !cell.claimedTask && blocker(cell, detail.row, detail.column) === null;
  return (
    <div data-testid="cell-detail" data-row={row} data-col={col} className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-1 border-b border-border/60 px-4 py-2">
        {/* On a phone the cell takes the grid's place, so the way back names the grid. */}
        <Button type="button" variant="ghost" size="xs" data-testid="cell-back" className="-ml-2 max-w-full md:hidden" onClick={onClose}>
          <ArrowLeft aria-hidden />
          <span className="truncate">{gridName || slug}</span>
        </Button>
        <div className="flex items-center gap-2">
          <span className="min-w-0 text-sm font-medium md:truncate" data-testid="cell-title">
            {detail ? `${detail.row.name} × ${detail.column.name}` : `${row} × ${col}`}
          </span>
          <Button type="button" variant="ghost" size="icon" aria-label="Close" className="ml-auto hidden size-8 shrink-0 md:inline-flex" onClick={onClose}>
            <X />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {error && !detail ? (
          <ReadFailed what="Couldn't load cell." why={error.message} onRetry={() => setRound((n) => n + 1)} />
        ) : !detail || !cell ? (
          <div className="flex justify-center p-6"><Spinner className="size-5 text-muted-foreground" /></div>
        ) : (
          <>
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <CellStateChip cell={cell} />
                {cell.stale && <span className="text-xs text-muted-foreground">The covered code changed since it was proved</span>}
                {cell.claimedTask ? (
                  onOpenTask ? (
                    <Button type="button" size="xs" variant="ghost" data-testid="cell-claimed" className="min-w-0 max-w-full" onClick={() => onOpenTask(cell.claimedTask!)}>
                      <span className="truncate">{claimLine(cell.claimedTask, cell.claimedChat)}</span>
                      <ExternalLink aria-hidden />
                    </Button>
                  ) : (
                    <span data-testid="cell-claimed" className="text-xs text-muted-foreground">{claimLine(cell.claimedTask, cell.claimedChat)}</span>
                  )
                ) : null}
                {cell.auditedAt ? <span className="text-xs text-muted-foreground">{`Audited ${when(cell.auditedAt)}`}</span> : null}
              </div>
              {detail.column.proofRule && (
                <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Proof rule: </span>{detail.column.proofRule}</p>
              )}
              {cell.reason && (
                <Panel tone={cell.state === 'na_pending' || cell.state === 'na' ? 'attention' : 'danger'} inset="sm" data-testid="cell-reason">
                  <div className="whitespace-pre-wrap break-words text-sm">{cell.reason}</div>
                </Panel>
              )}
              <CellOwnerActions projectId={projectId} slug={slug} row={row} col={col} cell={cell} onDone={() => setRound((n) => n + 1)} />
              {claimable && (
                <div className="flex">
                  <CreateTaskButton
                    projectId={projectId}
                    cells={{ slug, rows: [row], cols: [col], onlyGaps: false }}
                    label="Create task"
                    testId="cell-create-task"
                    onCreated={() => { setRound((n) => n + 1); onCreated?.(); }}
                    onOpenChat={onOpenChat}
                  />
                </div>
              )}
            </section>
            <section className="space-y-2">
              <Label>Proof</Label>
              <ProofView cell={cell} />
              {cell.provedAt ? <p className={cn('text-xs text-muted-foreground')}>{`Proved ${when(cell.provedAt)}`}</p> : null}
            </section>
            <section className="space-y-2">
              <Label>History</Label>
              <CellHistory events={detail.events} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}
