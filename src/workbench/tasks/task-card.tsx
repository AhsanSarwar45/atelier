'use client';

/**
 * A task's card (docs/tasks.md, "Front end"): what was promised and, once the
 * task is finished, what was proved — each type drawn for what it is.
 *
 * The same card is the `task` chat widget and the body of the Tasks tab's
 * detail panel.
 */
import { useEffect, useState, type ReactNode } from 'react';

import { AlertTriangle, Ban, Check, ChevronRight, Circle, CircleDot, GitMerge, Pause, Plus } from 'lucide-react';

import { MarkdownBody } from '@/components/markdown-body';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, CollapsibleTriggerRow } from '@/components/ui/collapsible';
import { Panel } from '@/components/ui/panel';
import { Textarea } from '@/components/ui/textarea';
import { tasks as tasksApi } from '@/lib/api';
import { apiUrl } from '@/lib/api-base';
import { cn } from '@/lib/utils';
import { mediaUrl, presentationAssetUrl } from '@/workbench/attachment-store';
import { ImageComparisonView } from '@/workbench/image-comparison';
import { useLiveSessions } from '@/workbench/live';
import { onWorkbench } from '@/workbench/live-wire';
import { PictureViewer } from '@/workbench/picture-viewer';
import type { LookableImage, SessionState } from '@/workbench/protocol';
import { ProposalCells, TaskCells } from '@/workbench/grids/task-cells';
import { useComposerPrefill } from '@/workbench/tasks/composer-prefill';
import {
  STATUS_LABEL,
  followupLine,
  sessionStopped,
  targetMet,
  typeLabel,
  type Followup,
  type OptimizationOutcome,
  type OptimizationTarget,
  type OwnerAction,
  type ProposalChoice,
  type ReviewFinding,
  type Task,
  type TaskProposal,
  type TaskStatus,
} from '@/workbench/tasks/types';
import { tasksChangedFor, useLiveTask } from '@/workbench/tasks/use-tasks';

/* ------------------------------------------------------------------ reading */

type Loose = Record<string, unknown>;
const rec = (value: unknown): Loose => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Loose : {});
const list = (value: unknown): Loose[] => (Array.isArray(value) ? value.map(rec) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const byId = (rows: Loose[]): Map<string, Loose> => new Map(rows.map((row) => [str(row.id), row]));

/** What the card's chip says: the stored status, or "paused" for a task nobody is working. */
export type ShownStatus = TaskStatus | 'paused';

export function shownStatus(task: Pick<Task, 'status'>, sessionState: SessionState | undefined): ShownStatus {
  return task.status === 'in_progress' && sessionStopped(sessionState) ? 'paused' : task.status;
}

const CHIP: Record<ShownStatus, { variant: 'secondary' | 'info' | 'warning' | 'primary' | 'success'; label: string; icon: typeof Circle }> = {
  todo: { variant: 'secondary', label: STATUS_LABEL.todo, icon: Circle },
  in_progress: { variant: 'info', label: STATUS_LABEL.in_progress, icon: CircleDot },
  paused: { variant: 'secondary', label: 'Paused', icon: Pause },
  blocked: { variant: 'warning', label: STATUS_LABEL.blocked, icon: AlertTriangle },
  review: { variant: 'primary', label: STATUS_LABEL.review, icon: CircleDot },
  done: { variant: 'success', label: STATUS_LABEL.done, icon: Check },
  cancelled: { variant: 'secondary', label: STATUS_LABEL.cancelled, icon: Ban },
};

export function TaskStatusChip({ status, className }: { status: ShownStatus; className?: string }) {
  const chip = CHIP[status];
  const Icon = chip.icon;
  return (
    <Badge data-testid="task-status" data-status={status} variant={chip.variant} appearance="light" size="sm" className={className}>
      <Icon aria-hidden />
      <span>{chip.label}</span>
    </Badge>
  );
}

/**
 * Whether a done task's commits have reached the base branch (docs/tasks.md,
 * "Merging"). Drawn only for a done task with commits whose answer is known.
 */
export function MergeBadge({ task, className }: { task: Pick<Task, 'status' | 'merged' | 'result'>; className?: string }) {
  const commits = Array.isArray(task.result?.commits) ? task.result.commits : [];
  if (task.status !== 'done' || commits.length === 0 || typeof task.merged !== 'boolean') return null;
  return (
    <Badge data-testid="task-merged" data-merged={task.merged ? 'yes' : 'no'} variant={task.merged ? 'success' : 'secondary'}
      appearance="light" size="sm" className={className}>
      <GitMerge aria-hidden />
      <span>{task.merged ? 'Merged' : 'Not merged'}</span>
    </Badge>
  );
}

/* ------------------------------------------------------------------ pieces */

function Label({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  if (children === '' || children === null || children === undefined) return null;
  return (
    <div className="min-w-0">
      <Label>{label}</Label>
      <div className="mt-0.5 whitespace-pre-wrap break-words text-sm text-foreground">{children}</div>
    </div>
  );
}

function Bullets({ items, ordered = false }: { items: string[]; ordered?: boolean }) {
  if (!items.length) return null;
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className={cn('space-y-0.5 pl-5 text-sm', ordered ? 'list-decimal' : 'list-disc')}>
      {items.map((item, index) => <li key={index} className="break-words">{item}</li>)}
    </Tag>
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO = /\.(webm|mp4|mov)$/i;
const ASSET = /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/;

/**
 * Where a picture or video named in a result is read from. The server stores
 * an uploaded one as its served address (docs/tasks.md, "Evidence"); any other
 * path is read from disk, a relative one against the session's folder.
 */
export function shotUrl(path: string, cwd: string | null | undefined): string {
  if (ASSET.test(path)) return presentationAssetUrl(path);
  if (path.startsWith('/api/presentation-assets/')) return apiUrl(path);
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return mediaUrl(path);
  if (!cwd) return '';
  return mediaUrl(`${cwd.replace(/[\\/]+$/, '')}/${path.replace(/^\.\//, '')}`);
}

/** Evidence: words, a `file:line`, a test name, or a picture or video shown inline. */
function Evidence({ value, cwd }: { value: string; cwd?: string | null }) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/\s/.test(trimmed) && IMAGE.test(trimmed)) {
    const src = shotUrl(trimmed, cwd);
    // eslint-disable-next-line @next/next/no-img-element
    if (src) return <img src={src} alt={trimmed} className="mt-1 max-h-48 rounded border border-border/60 object-contain" />;
  }
  if (!/\s/.test(trimmed) && VIDEO.test(trimmed)) {
    const src = shotUrl(trimmed, cwd);
    if (src) return <video src={src} controls preload="metadata" className="mt-1 max-h-60 w-full rounded bg-black" />;
  }
  return <span className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{trimmed}</span>;
}

/** One promised item and how it came out: the shape of feature, general, qa, chore and the rest. */
function CheckRow({ ok, text, children, testId }: { ok: boolean | null; text: ReactNode; children?: ReactNode; testId?: string }) {
  const Icon = ok === null ? Circle : ok ? Check : AlertTriangle;
  return (
    <li data-testid={testId} data-met={ok === null ? 'pending' : ok ? 'yes' : 'no'} className="flex gap-2 py-1.5">
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0',
        ok === null ? 'text-muted-foreground' : ok ? 'text-[var(--color-success-accent)]' : 'text-[var(--color-warning-accent)]')} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="break-words text-sm text-foreground">{text}</div>
        {children}
      </div>
    </li>
  );
}

function Shortfall({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <div className="whitespace-pre-wrap break-words text-xs text-[var(--color-warning-accent)]">{children}</div>;
}

function Checklist({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-border/60">{children}</ul>;
}

/* ------------------------------------------------------------------ plans */

function OptimizationPlanTable({ targets }: { targets: OptimizationTarget[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-max min-w-full text-left text-xs">
        <thead className="border-b bg-muted/40">
          <tr>{['Target', 'Metric', 'Baseline', 'Goal', 'Measured by', 'Environment'].map((h) => <th key={h} className="px-2 py-1.5 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {targets.map((t) => (
            <tr key={t.id} className="border-b last:border-0">
              <td className="px-2 py-1.5 font-medium">{t.name}</td>
              <td className="px-2 py-1.5 text-muted-foreground">{t.metric} ({t.higher_is_better ? 'higher is better' : 'lower is better'})</td>
              <td className="px-2 py-1.5 tabular-nums">{t.baseline} {t.unit}</td>
              <td className="px-2 py-1.5 tabular-nums">{t.target} {t.unit}</td>
              <td className="px-2 py-1.5 text-muted-foreground">{t.how_measured}</td>
              <td className="px-2 py-1.5 text-muted-foreground">{t.environment}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ItemList({ items }: { items: Loose[] }) {
  return <Checklist>{items.map((item) => <CheckRow key={str(item.id)} ok={null} text={str(item.text)} />)}</Checklist>;
}

export function PlanView({ type, plan }: { type: string; plan: unknown }) {
  const p = rec(plan);
  switch (type) {
    case 'bug':
      return (
        <div className="space-y-2">
          <Field label="Symptom">{str(p.symptom)}</Field>
          {strings(p.repro_steps).length > 0 && <div><Label>Steps to reproduce</Label><Bullets items={strings(p.repro_steps)} ordered /></div>}
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Expected">{str(p.expected)}</Field>
            <Field label="Actual">{str(p.actual)}</Field>
          </div>
          <Field label="Suspected area">{str(p.suspected_area)}</Field>
        </div>
      );
    case 'feature':
      return <div className="space-y-2"><Field label="Outcome">{str(p.outcome)}</Field><div><Label>Criteria</Label><ItemList items={list(p.criteria)} /></div></div>;
    case 'general':
      return <div className="space-y-2"><Field label="Outcome">{str(p.outcome)}</Field><div><Label>Done when</Label><ItemList items={list(p.done_when)} /></div></div>;
    case 'ui_change':
      return (
        <div className="space-y-2">
          {list(p.screens).map((s) => (
            <div key={str(s.id)}>
              <div className="text-sm font-medium">{str(s.name)}</div>
              <div className="text-xs text-muted-foreground">{str(s.how_to_reach)}</div>
              <div className="text-sm">{str(s.change)}</div>
            </div>
          ))}
        </div>
      );
    case 'optimization':
      return <OptimizationPlanTable targets={list(p.targets) as unknown as OptimizationTarget[]} />;
    case 'plan':
      return (
        <div className="space-y-2">
          <Field label="Question">{str(p.question)}</Field>
          <Field label="Scope">{str(p.scope)}</Field>
          {strings(p.constraints).length > 0 && <div><Label>Constraints</Label><Bullets items={strings(p.constraints)} /></div>}
        </div>
      );
    case 'investigation':
      return <div><Label>Questions</Label><ItemList items={list(p.questions)} /></div>;
    case 'refactor':
      return (
        <div className="space-y-2">
          <Field label="Change">{str(p.change)}</Field>
          <Field label="Reason">{str(p.reason)}</Field>
          <div><Label>Invariants</Label><ItemList items={list(p.invariants)} /></div>
        </div>
      );
    case 'tests':
      return <div><Label>Behaviors</Label><ItemList items={list(p.behaviors)} /></div>;
    case 'review':
      return (
        <div className="space-y-2">
          <Field label="Target">{str(p.target)}</Field>
          {strings(p.focus).length > 0 && <div><Label>Focus</Label><Bullets items={strings(p.focus)} /></div>}
        </div>
      );
    case 'qa':
      return (
        <div><Label>Scenarios</Label>
          <Checklist>{list(p.scenarios).map((s) => (
            <CheckRow key={str(s.id)} ok={null} text={str(s.expected)}><Bullets items={strings(s.steps)} ordered /></CheckRow>
          ))}</Checklist>
        </div>
      );
    case 'docs':
      return (
        <div className="space-y-2">
          <Field label="Audience">{str(p.audience)}</Field>
          <div><Label>Pages</Label>
            <Checklist>{list(p.pages).map((page) => (
              <CheckRow key={str(page.id)} ok={null} text={<span className="font-mono text-xs">{str(page.path)}</span>}>
                <div className="text-sm">{str(page.change)}</div>
              </CheckRow>
            ))}</Checklist>
          </div>
        </div>
      );
    case 'chore':
      return <div><Label>Steps</Label><ItemList items={list(p.steps)} /></div>;
    default:
      return <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">{JSON.stringify(plan, null, 2)}</pre>;
  }
}

/* ------------------------------------------------------------------ results */

function OptimizationResultTable({ plan, result }: { plan: Loose; result: Loose }) {
  const targets = list(plan.targets) as unknown as OptimizationTarget[];
  const outcomes = byId(list(result.targets));
  return (
    <div className="space-y-2">
      <Field label="Method">{str(result.method)}</Field>
      <div className="overflow-x-auto">
        <table data-testid="optimization-table" className="w-max min-w-full text-left text-xs">
          <thead className="border-b bg-muted/40">
            <tr>{['Target', 'Baseline', 'Goal', 'Before', 'After', 'Runs', ''].map((h, i) => <th key={i} className="px-2 py-1.5 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {targets.map((t) => {
              const o = outcomes.get(t.id) as unknown as OptimizationOutcome | undefined;
              const after = num(o?.after);
              const met = o?.met ?? (after !== null ? targetMet(t, after) : null);
              const note = met ? o?.why_faster : o?.failure_reason;
              return [
                <tr key={t.id} data-testid="optimization-row" data-met={met === null ? 'pending' : met ? 'yes' : 'no'}
                  className={cn(note ? '' : 'border-b last:border-0', met === false && 'bg-[var(--color-warning-soft)]')}>
                  <td className="px-2 py-1.5 font-medium">{t.name}<div className="font-normal text-muted-foreground">{t.metric}</div></td>
                  <td className="px-2 py-1.5 tabular-nums">{t.baseline} {t.unit}</td>
                  <td className="px-2 py-1.5 tabular-nums">{t.target} {t.unit}</td>
                  <td className="px-2 py-1.5 tabular-nums">{o ? `${str(o.before)} ${t.unit}` : '—'}</td>
                  <td className="px-2 py-1.5 font-semibold tabular-nums">{after !== null ? `${after} ${t.unit}` : '—'}</td>
                  <td className="px-2 py-1.5 tabular-nums text-muted-foreground">{o ? str(o.runs) : ''}</td>
                  <td className="px-2 py-1.5">
                    {met !== null && (
                      <Badge variant={met ? 'success' : 'warning'} appearance="light" size="sm">
                        {met ? <Check aria-hidden /> : <AlertTriangle aria-hidden />}<span>{met ? 'Met' : 'Missed'}</span>
                      </Badge>
                    )}
                  </td>
                </tr>,
                note ? (
                  <tr key={`${t.id}:note`} className={cn('border-b last:border-0', met === false && 'bg-[var(--color-warning-soft)]')}>
                    <td colSpan={7} className={cn('px-2 pb-1.5 text-xs', met ? 'text-muted-foreground' : 'text-[var(--color-warning-accent)]')}>{note}</td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MetList({ planned, results, label, cwd }: { planned: Loose[]; results: Loose[]; label: string; cwd?: string | null }) {
  const got = byId(results);
  return (
    <div><Label>{label}</Label>
      <Checklist>
        {planned.map((item) => {
          const r = got.get(str(item.id));
          const ok = r ? r.met === true || r.passed === true || r.done === true : null;
          return (
            <CheckRow key={str(item.id)} testId="task-check" ok={ok} text={str(item.text) || str(item.expected)}>
              {r && <Evidence value={str(r.evidence) || str(r.output)} cwd={cwd} />}
              {r && !ok && <Shortfall>{str(r.reason) || str(r.notes)}</Shortfall>}
              {r && ok && str(r.notes) && <div className="text-xs text-muted-foreground">{str(r.notes)}</div>}
            </CheckRow>
          );
        })}
      </Checklist>
    </div>
  );
}

function UiChangeResult({ plan, result, cwd }: { plan: Loose; result: Loose; cwd?: string | null }) {
  const [looking, setLooking] = useState<LookableImage | null>(null);
  const shots = byId(list(result.screens));
  return (
    <div className="space-y-3">
      {list(plan.screens).map((screen) => {
        const shot = shots.get(str(screen.id));
        const name = str(screen.name);
        return (
          <div key={str(screen.id)} data-testid="ui-screen">
            <div className="mb-1 text-sm font-medium">{name}</div>
            {shot ? (
              <ImageComparisonView
                comparison={{
                  mode: 'side_by_side',
                  before: { mime: 'image/*', dataUrl: shotUrl(str(shot.before), cwd), alt: `${name} before` },
                  after: { mime: 'image/*', dataUrl: shotUrl(str(shot.after), cwd), alt: `${name} after` },
                }}
                onLook={setLooking}
              />
            ) : <Shortfall>No screenshots</Shortfall>}
            {shot && str(shot.notes) && <div className="text-xs text-muted-foreground">{str(shot.notes)}</div>}
          </div>
        );
      })}
      {looking && <PictureViewer image={looking} onClose={() => setLooking(null)} />}
    </div>
  );
}

const SEVERITIES: ReviewFinding['severity'][] = ['high', 'medium', 'low'];
const SEVERITY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;
const CONFIDENCE = { high: 'success', medium: 'info', low: 'warning' } as const;

function Followups({ items, label }: { items: Followup[]; label: string }) {
  const prefill = useComposerPrefill();
  if (!items.length) return null;
  return (
    <div><Label>{label}</Label>
      <ul className="divide-y divide-border/60">
        {items.map((item, index) => (
          <li key={index} data-testid="task-followup" className="flex items-start gap-2 py-1.5">
            <Badge variant="secondary" size="sm" className="mt-0.5"><span>{typeLabel(item.type)}</span></Badge>
            <div className="min-w-0 flex-1">
              <div className="text-sm">{item.title}</div>
              <div className="text-xs text-muted-foreground">{item.why}</div>
            </div>
            {prefill && (
              <Button type="button" variant="outline" size="xs" onClick={() => prefill(followupLine(item))}>
                <Plus />Create task
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ResultView({ type, plan, result, cwd }: { type: string; plan: unknown; result: unknown; cwd?: string | null }) {
  const p = rec(plan);
  const r = rec(result);
  switch (type) {
    case 'optimization':
      return <OptimizationResultTable plan={p} result={r} />;
    case 'feature':
      return <MetList label="Criteria" planned={list(p.criteria)} results={list(r.criteria)} cwd={cwd} />;
    case 'general':
      return <MetList label="Done when" planned={list(p.done_when)} results={list(r.done_when)} cwd={cwd} />;
    case 'qa':
      return <MetList label="Scenarios" planned={list(p.scenarios)} results={list(r.scenarios)} cwd={cwd} />;
    case 'chore':
      return <MetList label="Steps" planned={list(p.steps)} results={list(r.steps)} cwd={cwd} />;
    case 'ui_change':
      return <UiChangeResult plan={p} result={r} cwd={cwd} />;
    case 'plan':
      return (
        <div className="space-y-3">
          <Panel tone="nested" inset="md" data-testid="plan-document">
            <MarkdownBody>{str(r.document)}</MarkdownBody>
          </Panel>
          {strings(r.decisions).length > 0 && <div><Label>Decisions</Label><Bullets items={strings(r.decisions)} /></div>}
          {strings(r.open_questions).length > 0 && <div><Label>Open questions</Label><Bullets items={strings(r.open_questions)} /></div>}
          <Followups label="Proposed tasks" items={list(r.proposed_tasks) as unknown as Followup[]} />
        </div>
      );
    case 'investigation': {
      const answers = byId(list(r.answers));
      return (
        <div className="space-y-3">
          {list(p.questions).map((q) => {
            const a = answers.get(str(q.id));
            const confidence = str(a?.confidence) as keyof typeof CONFIDENCE;
            return (
              <div key={str(q.id)} data-testid="task-answer">
                <div className="text-sm font-medium">{str(q.text)}</div>
                {a ? (
                  <div className="mt-0.5 space-y-1">
                    <div className="whitespace-pre-wrap text-sm">{str(a.answer)}</div>
                    {CONFIDENCE[confidence] && (
                      <Badge variant={CONFIDENCE[confidence]} appearance="light" size="sm"><span>{`${confidence[0]!.toUpperCase()}${confidence.slice(1)} confidence`}</span></Badge>
                    )}
                    {strings(a.evidence).map((e, i) => <div key={i}><Evidence value={e} cwd={cwd} /></div>)}
                    {str(a.recommendation) && <Field label="Recommendation">{str(a.recommendation)}</Field>}
                  </div>
                ) : <Shortfall>No answer</Shortfall>}
              </div>
            );
          })}
        </div>
      );
    }
    case 'review': {
      const findings = list(r.findings) as unknown as ReviewFinding[];
      const approve = r.verdict === 'approve';
      return (
        <div className="space-y-2">
          <Badge data-testid="review-verdict" variant={approve ? 'success' : 'warning'} appearance="light" size="md">
            {approve ? <Check aria-hidden /> : <AlertTriangle aria-hidden />}<span>{approve ? 'Approved' : 'Changes needed'}</span>
          </Badge>
          {SEVERITIES.map((severity) => {
            const found = findings.filter((f) => f.severity === severity);
            if (!found.length) return null;
            return (
              <div key={severity}><Label>{`${SEVERITY_LABEL[severity]} (${found.length})`}</Label>
                <ul className="divide-y divide-border/60">
                  {found.map((f, i) => (
                    <li key={i} className="py-1.5">
                      <div className="font-mono text-xs text-muted-foreground">{f.location}</div>
                      <div className="text-sm">{f.summary}</div>
                      <div className="text-xs text-muted-foreground">{f.failure_scenario}</div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      );
    }
    case 'bug':
      return (
        <div className="space-y-2">
          <Field label="Root cause">{str(r.root_cause)}</Field>
          <Field label="Fix">{str(r.fix)}</Field>
          <div><Label>Proof</Label><Evidence value={str(r.proof)} cwd={cwd} /></div>
          {strings(r.regression_checked).length > 0 && <div><Label>Regressions checked</Label><Bullets items={strings(r.regression_checked)} /></div>}
        </div>
      );
    case 'refactor': {
      const verified = byId(list(r.invariants));
      const deviations = strings(r.deviations);
      return (
        <div className="space-y-2">
          <div><Label>Invariants</Label>
            <Checklist>{list(p.invariants).map((inv) => {
              const v = verified.get(str(inv.id));
              return <CheckRow key={str(inv.id)} testId="task-check" ok={v ? true : null} text={str(inv.text)}>{v && <Evidence value={str(v.how_verified)} cwd={cwd} />}</CheckRow>;
            })}</Checklist>
          </div>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>{`Files changed: ${str(r.files_changed)}`}</span>
            <span>{`Net lines: ${str(r.net_lines)}`}</span>
          </div>
          {deviations.length > 0 && <div><Label>Deviations</Label><Shortfall><Bullets items={deviations} /></Shortfall></div>}
        </div>
      );
    }
    case 'tests': {
      const done = byId(list(r.behaviors));
      return (
        <div><Label>Behaviors</Label>
          <Checklist>{list(p.behaviors).map((b) => {
            const t = done.get(str(b.id));
            const ok = t ? t.fails_without_code === true : null;
            return (
              <CheckRow key={str(b.id)} testId="task-check" ok={ok} text={str(b.text)}>
                {t && <div className="break-all font-mono text-xs text-muted-foreground">{`${str(t.test_path)} › ${str(t.test_name)}`}</div>}
                {t && !ok && <Shortfall>{str(t.reason) || 'Passes without the change'}</Shortfall>}
              </CheckRow>
            );
          })}</Checklist>
        </div>
      );
    }
    case 'docs': {
      const done = byId(list(r.pages));
      return (
        <div><Label>Pages</Label>
          <Checklist>{list(p.pages).map((page) => {
            const d = done.get(str(page.id));
            return (
              <CheckRow key={str(page.id)} testId="task-check" ok={d ? true : null} text={<span className="font-mono text-xs">{str(d?.path) || str(page.path)}</span>}>
                <div className="text-sm">{d ? str(d.what_changed) : str(page.change)}</div>
              </CheckRow>
            );
          })}</Checklist>
        </div>
      );
    }
    default:
      return <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">{JSON.stringify(result, null, 2)}</pre>;
  }
}

/* ------------------------------------------------------------------ actions */

/** What the owner can do to a task, by where it stands. */
export function ownerActions(task: Pick<Task, 'status' | 'pendingAmend' | 'sessionId'>): OwnerAction[] {
  const actions: OwnerAction[] = [];
  if (task.pendingAmend) actions.push('approve_amend', 'reject_amend');
  if (task.status === 'review') actions.push('approve', 'reopen');
  if (task.status !== 'done' && task.status !== 'cancelled') actions.push('cancel');
  if (task.sessionId && task.status !== 'done' && task.status !== 'cancelled') actions.push('release');
  return actions;
}

function failure(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  return message.replace(/^API error: \d+\s*/, '');
}

/**
 * The owner's buttons for one task. `only` limits them to a set — the chat
 * card shows the review and amend ones; the Tasks tab shows them all.
 */
export function TaskOwnerActions({ task, only, onChanged }: {
  task: Task;
  only?: OwnerAction[];
  onChanged?: (task: Task) => void;
}) {
  const [busy, setBusy] = useState<OwnerAction | null>(null);
  const [asking, setAsking] = useState<'reopen' | 'cancel' | null>(null);
  const [words, setWords] = useState('');
  const [error, setError] = useState<string | null>(null);
  const actions = ownerActions(task).filter((a) => !only || only.includes(a));
  if (!actions.length) return null;

  const act = async (action: OwnerAction, payload?: Record<string, unknown>) => {
    setBusy(action);
    setError(null);
    try {
      const { task: next } = await tasksApi.act(task.projectId, task.number, action, payload);
      setAsking(null);
      setWords('');
      onChanged?.(next);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  };

  const has = (a: OwnerAction) => actions.includes(a);
  return (
    <div className="space-y-2" data-testid="task-actions">
      {asking ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!words.trim()) return;
            void act(asking, asking === 'reopen' ? { note: words.trim() } : { reason: words.trim() });
          }}
        >
          <Textarea
            autoFocus
            rows={2}
            aria-label={asking === 'reopen' ? 'Note' : 'Reason'}
            placeholder={asking === 'reopen' ? 'Note' : 'Reason'}
            value={words}
            onChange={(e) => setWords(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant={asking === 'cancel' ? 'destructive' : 'primary'} disabled={!words.trim()} loading={busy === asking}>
              {asking === 'reopen' ? 'Reopen' : 'Cancel task'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setAsking(null); setWords(''); }}>Back</Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {has('approve') && <Button type="button" size="sm" onClick={() => void act('approve')} loading={busy === 'approve'}>Approve</Button>}
          {has('reopen') && <Button type="button" size="sm" variant="outline" onClick={() => setAsking('reopen')}>Reopen</Button>}
          {has('approve_amend') && <Button type="button" size="sm" onClick={() => void act('approve_amend')} loading={busy === 'approve_amend'}>Approve change</Button>}
          {has('reject_amend') && <Button type="button" size="sm" variant="outline" onClick={() => void act('reject_amend')} loading={busy === 'reject_amend'}>Reject change</Button>}
          {has('release') && <Button type="button" size="sm" variant="outline" onClick={() => void act('release')} loading={busy === 'release'}>Release</Button>}
          {has('cancel') && <Button type="button" size="sm" variant="ghost" onClick={() => setAsking('cancel')}>Cancel task</Button>}
        </div>
      )}
      {error && <div role="alert" className="text-xs text-destructive">{`Couldn't update task. ${error}`}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ card */

const EVENT_LABEL: Record<string, string> = {
  create: 'Created', start: 'Started', block: 'Blocked', unblock: 'Unblocked', amend: 'Change proposed',
  done: 'Finished', cancel: 'Cancelled', take: 'Taken', approve: 'Approved', reopen: 'Reopened',
  approve_amend: 'Change approved', reject_amend: 'Change rejected', release: 'Released',
};

function Section({ label, children }: { label: string; children: ReactNode }) {
  return <section className="space-y-1.5"><Label>{label}</Label>{children}</section>;
}

/**
 * Whether a chat card starts open: a new task, and a card that waits on the
 * owner (a review, a proposed plan change, a block). Any other status update
 * starts folded to its header, so a chat is not a stack of repeated plans.
 * Read from the task as printed, so the card keeps its first look.
 */
export function opensByDefault(event: string, task: Task): boolean {
  if (event === 'create' || event === 'amend' || event === 'block') return true;
  return event === 'done' && task.status === 'review';
}

/**
 * The task card. Draws the task as it stands now where the screen knows it
 * (`LiveTasksContext`), and otherwise the snapshot it was given.
 */
export function TaskCard({ task: snapshot, event, actions = ['approve', 'reopen', 'approve_amend', 'reject_amend'] }: {
  task: Task;
  /** The action that printed this card, for a chat card. */
  event?: string;
  /** Which owner buttons to offer. */
  actions?: OwnerAction[];
}) {
  const live = useLiveTask(snapshot);
  const [open, setOpen] = useState(() => (event ? opensByDefault(event, snapshot) : true));
  const [acted, setActed] = useState<Task | null>(null);
  // What an owner button answered, until the feed catches up. Only for this
  // task: the detail panel reuses the card when another task is chosen.
  const mine = acted && acted.projectId === live.projectId && acted.number === live.number ? acted : null;
  const task = mine && mine.updatedAt >= live.updatedAt ? mine : live;
  const sessions = useLiveSessions();
  const session = task.sessionId ? sessions.find((s) => s.id === task.sessionId) : undefined;
  const status = shownStatus(task, session?.state);
  const cwd = session?.cwd ?? null;
  const result = task.result;
  const reviewing = task.status === 'review';
  const followups = Array.isArray(result?.followups) ? result.followups : [];
  const commits = Array.isArray(result?.commits) ? result.commits.filter((c): c is string => typeof c === 'string') : [];

  const header = (
    <header className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">#{task.number}</span>
          <Badge variant="secondary" size="sm"><span>{typeLabel(task.type)}</span></Badge>
          {event && EVENT_LABEL[event] && <span className="text-xs text-muted-foreground">{EVENT_LABEL[event]}</span>}
          <TaskStatusChip status={status} className="ml-auto" />
        </div>
        <h4 className={cn('text-sm font-semibold text-foreground', task.status === 'cancelled' && 'text-muted-foreground line-through')}>{task.title}</h4>
        {task.why && <p className="text-xs text-muted-foreground">{task.why}</p>}
    </header>
  );

  const body = (
    <>

      {task.status === 'blocked' && task.blocked && (
        <Panel tone="attention" inset="sm" data-testid="task-blocked" className="space-y-1">
          <Field label="Blocked by">{task.blocked.cause}</Field>
          <Field label="Needed to continue">{task.blocked.needed_to_resume}</Field>
        </Panel>
      )}

      {task.status === 'cancelled' && task.cancelReason && (
        <Panel tone="default" inset="sm"><Field label="Cancelled">{task.cancelReason}</Field></Panel>
      )}

      {task.pendingAmend && (
        <Panel tone="info" inset="sm" data-testid="task-amend" className="space-y-2">
          <Label>Proposed plan change</Label>
          <PlanView type={task.type} plan={task.pendingAmend} />
          <TaskOwnerActions task={task} only={actions.filter((a) => a === 'approve_amend' || a === 'reject_amend')} onChanged={setActed} />
        </Panel>
      )}

      {result ? (
        <>
          <Collapsible>
            <CollapsibleTriggerRow size="sm">Plan</CollapsibleTriggerRow>
            <CollapsibleContent className="pt-2"><PlanView type={task.type} plan={task.plan} /></CollapsibleContent>
          </Collapsible>
          <Section label="Result">
            {task.shortfalls && (
              <Panel tone="attention" inset="sm" data-testid="task-shortfalls" className="flex items-center gap-2 text-xs">
                <AlertTriangle aria-hidden className="size-3.5 text-[var(--color-warning-accent)]" />
                Finished with shortfalls
              </Panel>
            )}
            {typeof result.summary === 'string' && result.summary && <p className="whitespace-pre-wrap text-sm">{result.summary}</p>}
            <ResultView type={task.type} plan={task.plan} result={result} cwd={cwd} />
          </Section>
          {commits.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Label>Commits</Label>
              {commits.map((sha) => <Badge key={sha} variant="outline" size="sm"><span className="font-mono">{sha.slice(0, 10)}</span></Badge>)}
              <MergeBadge task={task} />
            </div>
          )}
          <Followups label="Follow-ups" items={followups as Followup[]} />
        </>
      ) : (
        <Section label="Plan"><PlanView type={task.type} plan={task.plan} /></Section>
      )}

      <TaskCells task={task} />

      {reviewing && (
        <TaskOwnerActions task={task} only={actions.filter((a) => a === 'approve' || a === 'reopen')} onChanged={setActed} />
      )}
    </>
  );

  // The Tasks tab's detail panel always shows the whole card.
  if (!event) return (
    <div data-testid="task-card" data-task-type={task.type} data-task-status={status} className="space-y-3">
      {header}
      {body}
    </div>
  );

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      data-testid="task-card"
      data-task-type={task.type}
      data-task-status={status}
    >
      <CollapsibleTrigger
        data-testid="task-card-toggle"
        className="group/collapsible flex w-full cursor-pointer items-start gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <ChevronRight
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/collapsible:rotate-90"
        />
        {header}
      </CollapsibleTrigger>
      {/* Indented past the chevron, so the body lines up with the header. */}
      <CollapsibleContent className="space-y-3 pl-[1.375rem] pt-3">{body}</CollapsibleContent>
    </Collapsible>
  );
}

/* ------------------------------------------------------------------ proposal */

const ANSWERED: Record<Exclude<TaskProposal['status'], 'pending'>, (proposal: TaskProposal) => string> = {
  created: (p) => (p.taskNumber ? `Task #${p.taskNumber} created` : 'Task created'),
  just_do_it: () => 'Just doing it, without a task',
  cancelled: () => 'Cancelled',
};

/**
 * A task an agent asked to make (`atelier task propose`): the draft, and the
 * owner's three answers. Create task makes it a task in the chat that asked;
 * Just do it and Cancel drop it. Whichever is chosen, the chat's agent is
 * told as its next message (docs/tasks.md, "Proposals").
 */
export function ProposalCard({ proposal: snapshot }: { proposal: TaskProposal }) {
  const [proposal, setProposal] = useState<TaskProposal>(snapshot);
  const [busy, setBusy] = useState<ProposalChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = proposal.status === 'pending';
  const { projectId, id } = snapshot;

  // A card printed long ago may have been answered since, here or elsewhere:
  // read it while it is still waiting, and again whenever tasks change.
  useEffect(() => {
    if (!pending) return;
    let alive = true;
    const read = () => {
      tasksApi.proposal(projectId, id)
        .then((now) => { if (alive) setProposal(now); })
        .catch(() => {});
    };
    read();
    const off = onWorkbench({ frame: (data) => { if (tasksChangedFor(data, projectId)) read(); }, dropped: () => {} });
    return () => { alive = false; off(); };
  }, [pending, projectId, id]);

  const answer = async (choice: ProposalChoice) => {
    setBusy(choice);
    setError(null);
    try {
      const answered = await tasksApi.answerProposal(projectId, id, choice);
      setProposal(answered.proposal);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="task-proposal" data-proposal-status={proposal.status} className="space-y-3">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Proposed task</span>
          <Badge variant="secondary" size="sm"><span>{typeLabel(proposal.type)}</span></Badge>
        </div>
        <h4 className={cn('text-sm font-semibold text-foreground', proposal.status === 'cancelled' && 'text-muted-foreground line-through')}>{proposal.title}</h4>
        {proposal.why && <p className="text-xs text-muted-foreground">{proposal.why}</p>}
      </header>
      <Section label="Plan"><PlanView type={proposal.type} plan={proposal.plan} /></Section>
      <ProposalCells proposal={proposal} />
      {pending ? (
        <div className="flex flex-wrap gap-2" data-testid="proposal-actions">
          <Button type="button" size="sm" disabled={busy !== null} loading={busy === 'create'} onClick={() => void answer('create')}>Create task</Button>
          <Button type="button" size="sm" variant="outline" disabled={busy !== null} loading={busy === 'just_do_it'} onClick={() => void answer('just_do_it')}>Just do it</Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy !== null} loading={busy === 'cancel'} onClick={() => void answer('cancel')}>Cancel</Button>
        </div>
      ) : (
        <p data-testid="proposal-answer" className="text-xs text-muted-foreground">{proposal.status === 'pending' ? '' : ANSWERED[proposal.status](proposal)}</p>
      )}
      {error && <div role="alert" className="text-xs text-destructive">{`Couldn't answer. ${error}`}</div>}
    </div>
  );
}
