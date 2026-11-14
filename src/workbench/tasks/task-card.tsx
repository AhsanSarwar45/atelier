'use client';

/**
 * A task's card (docs/tasks.md, "Front end"): what was promised and, once the
 * task is finished, what was proved — each type drawn for what it is.
 *
 * The same card is the `task` chat widget and the body of the Tasks tab's
 * detail panel.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { AlertTriangle, Ban, Check, Circle, CircleDot, CircleSlash, GitMerge, Images, Minus, Pause, Pencil, Plus } from 'lucide-react';

import { MarkdownBody } from '@/components/markdown-body';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTriggerRow } from '@/components/ui/collapsible';
import { Panel } from '@/components/ui/panel';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import { tasks as tasksApi } from '@/lib/api';
import { apiUrl } from '@/lib/api-base';
import { cn } from '@/lib/utils';
import { mediaUrl, presentationAssetUrl } from '@/workbench/attachment-store';
import { ImageComparisonView } from '@/workbench/image-comparison';
import { useLiveSessions } from '@/workbench/live';
import { onWorkbench } from '@/workbench/live-wire';
import { PictureViewer } from '@/workbench/picture-viewer';
import type { LookableImage, SessionState } from '@/workbench/protocol';
import { ClaimShapeLink, ProposalCells, TaskCells } from '@/workbench/grids/task-cells';
import { NotesView } from '@/workbench/notes';
import { useComposerPrefill } from '@/workbench/tasks/composer-prefill';
import { openTaskDetail } from '@/workbench/tasks/open-task';
import { CheckDiffView, CheckFlagsPanel, CheckGateProvider, FlagLines, ItemChecks, PlanChecks, useCheckGate, type CheckGate } from '@/workbench/tasks/check-views';
import { checkDiff, flagsFor, itemChecks, readFlags, tallyLine, withoutChecks } from '@/workbench/tasks/checks';
import { fieldName, planDiff } from '@/workbench/tasks/plan-diff';
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
import { ITEM_LISTS, VISUAL_TYPES, entryOutcome, gated, itemCounts, itemProgress, itemText, recordedEntries, shapeOf, withCheckedEntries, type ItemProgress } from '@/workbench/tasks/progress';
import { tasksChangedFor, useLiveTask } from '@/workbench/tasks/use-tasks';
import { ZoomableImage } from '@/workbench/zoomable-image';

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
    if (src) return <ZoomableImage src={src} alt={trimmed} className="mt-1" compact />;
  }
  if (!/\s/.test(trimmed) && VIDEO.test(trimmed)) {
    const src = shotUrl(trimmed, cwd);
    if (src) return <video src={src} controls preload="metadata" className="mt-1 max-h-60 w-full rounded bg-black" />;
  }
  return <span className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{trimmed}</span>;
}

/** One promised item and how it came out: the shape of feature, general, qa, chore and the rest. */
function CheckRow({ ok, text, children, testId, itemId, full, declined }: {
  ok: boolean | null;
  text: ReactNode;
  children?: ReactNode;
  testId?: string;
  itemId?: string;
  /** The item's text, for a row whose `text` is drawn from more than it. */
  full?: string;
  /** Why the agent declined one of the type's default items. */
  declined?: string;
}) {
  const Icon = declined !== undefined ? CircleSlash : ok === null ? Circle : ok ? Check : AlertTriangle;
  return (
    <li data-testid={testId} data-item={itemId} data-full={full} data-declined={declined} data-met={ok === null ? 'pending' : ok ? 'yes' : 'no'} className="flex gap-2 py-1.5">
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0',
        ok === null ? 'text-muted-foreground' : ok ? 'text-[var(--color-success-accent)]' : 'text-[var(--color-warning-accent)]')} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className={cn('break-words text-sm', declined !== undefined ? 'text-muted-foreground' : 'text-foreground')}>{text}</div>
        {declined !== undefined && <div className="text-xs text-muted-foreground">{`Declined: ${declined}`}</div>}
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

/**
 * The before and after images of one screen or scene, and a render's
 * reference image. Folded behind a toggle, so a card with many takes no room
 * until they are wanted; open, they sit side by side and open large on a click.
 */
/** One image with its caption above it, opened full size on a click. */
function Still({ name, caption, src }: { name: string; caption: string; src: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{caption}</div>
      <ZoomableImage src={src} alt={`${name} ${caption.toLowerCase()}`} compact />
    </div>
  );
}

/**
 * A visual item's images: before and after side by side, the after alone for
 * something new (no before), and a reference under them. Behind a toggle
 * where they would crowd a plan; `inline` where they are what is being
 * looked at (a result in review, a checked item unfolded).
 */
export function ShotPair({ name, before, after, reference, cwd, inline = false }: {
  name: string;
  before?: string;
  after: string;
  reference?: string;
  cwd?: string | null;
  inline?: boolean;
}) {
  const [toggled, setShown] = useState(false);
  const [looking, setLooking] = useState<LookableImage | null>(null);
  if (!before && !after) return null;
  const shown = inline || toggled;
  const label = before
    ? reference ? 'Show before, after and reference' : 'Show before and after'
    : reference ? 'Show after and reference' : 'Show after';
  return (
    <div data-testid="task-images" data-shown={shown ? 'yes' : 'no'}>
      {!inline && (
        <Button type="button" variant="ghost" size="xs" aria-expanded={shown} data-testid="task-images-toggle"
          className="-ml-2 text-muted-foreground" onClick={() => setShown((open) => !open)}>
          <Images aria-hidden />{shown ? 'Hide images' : label}
        </Button>
      )}
      {shown && (
        <div className={cn('space-y-2', !inline && 'mt-1')}>
          {before ? (
            <ImageComparisonView
              comparison={{
                mode: 'side_by_side',
                before: { mime: 'image/*', dataUrl: shotUrl(before, cwd), alt: `${name} before` },
                after: { mime: 'image/*', dataUrl: shotUrl(after, cwd), alt: `${name} after` },
              }}
              onLook={setLooking}
            />
          ) : <Still name={name} caption="After" src={shotUrl(after, cwd)} />}
          {reference && <Still name={name} caption="Reference" src={shotUrl(reference, cwd)} />}
        </div>
      )}
      {looking && <PictureViewer image={looking} onClose={() => setLooking(null)} />}
    </div>
  );
}

/** The screenshots a `feature` or `bug` result carries, each behind its own toggle. */
export function Screenshots({ result, cwd }: { result: unknown; cwd?: string | null }) {
  const shots = list(rec(result).screens);
  if (!shots.length) return null;
  return (
    <div data-testid="task-screenshots"><Label>Screenshots</Label>
      <div className="space-y-1">
        {shots.map((shot, index) => (
          <div key={index}>
            <div className="text-sm">{str(shot.name)}</div>
            <ShotPair name={str(shot.name)} before={str(shot.before) || undefined} after={str(shot.after)} cwd={cwd} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** What a checked item's entry says beside its tick: the evidence, and why it was missed. */
function EntryDetail({ type, item, entry, cwd }: { type: string; item: Loose; entry: Loose; cwd?: string | null }) {
  const outcome = entryOutcome(type, item, entry);
  let shown: ReactNode = null;
  switch (type) {
    case 'feature': case 'general': case 'qa':
      shown = <Evidence value={str(entry.evidence)} cwd={cwd} />;
      break;
    case 'chore':
      shown = <Evidence value={str(entry.output)} cwd={cwd} />;
      break;
    case 'refactor':
      shown = <Evidence value={str(entry.how_verified)} cwd={cwd} />;
      break;
    case 'docs':
      shown = <span className="text-xs text-muted-foreground">{str(entry.what_changed)}</span>;
      break;
    case 'tests':
      shown = <div className="break-all font-mono text-xs text-muted-foreground">{`${str(entry.test_path)} › ${str(entry.test_name)}`}</div>;
      break;
    case 'investigation':
      shown = <div className="whitespace-pre-wrap text-xs text-muted-foreground">{str(entry.answer)}</div>;
      break;
    case 'ui_change': case 'ui_feature': case 'ui_bug': case 'render_change': case 'render_feature': case 'render_bug':
      shown = <ShotPair name={itemText(type, item)} before={str(entry.before) || undefined} after={str(entry.after)} reference={str(entry.reference) || undefined} cwd={cwd} />;
      break;
  }
  return (
    <>
      {shown}
      {outcome.state === 'missed' && <Shortfall>{outcome.note}</Shortfall>}
      {outcome.state === 'met' && str(entry.notes) && <div className="text-xs text-muted-foreground">{str(entry.notes)}</div>}
    </>
  );
}

/**
 * One plan item: an open circle until it is checked, then ticked or marked
 * missed with what its entry says.
 */
function PlanItem({ type, item, entries, cwd, text, children }: {
  type: string;
  item: Loose;
  entries?: ReadonlyMap<string, Loose>;
  cwd?: string | null;
  text: ReactNode;
  children?: ReactNode;
}) {
  const gate = useCheckGate();
  const id = str(item.id);
  const checks = itemChecks(item);
  const raw = entries?.get(id);
  // An item with checks is ticked by them alone: the server's `checkMet`,
  // never an entry, and one that fails stays open with its tally.
  const byChecks = checks.length > 0 || gate?.met?.[id] !== undefined;
  const entry = raw && !(byChecks && Array.isArray(raw.checks)) ? raw : undefined;
  const ok = byChecks && gate?.met
    ? (gate.met[id] === true ? true : null)
    : entry ? entryOutcome(type, item, entry).state === 'met' : null;
  return (
    <CheckRow testId="task-plan-item" itemId={id} ok={ok} text={text} full={typeof text === 'string' ? text : undefined}>
      {children}
      {entry && <EntryDetail type={type} item={item} entry={entry} cwd={cwd} />}
      <ItemChecks itemId={id} checks={checks} />
    </CheckRow>
  );
}

function ItemList({ type, items, entries, cwd }: { type: string; items: Loose[]; entries?: ReadonlyMap<string, Loose>; cwd?: string | null }) {
  return (
    <Checklist>
      {items.map((item) => <PlanItem key={str(item.id)} type={type} item={item} entries={entries} cwd={cwd} text={str(item.text)} />)}
    </Checklist>
  );
}

/**
 * A task's plan. Given the entries checked so far (`atelier task check`),
 * each plan item shows whether it was met, missed or is still open.
 */
export function PlanView({ type, plan, entries, cwd }: {
  type: string;
  plan: unknown;
  entries?: ReadonlyMap<string, Loose>;
  cwd?: string | null;
}) {
  // bug, plan and review keep their checks on the plan itself.
  const own = itemChecks(plan);
  const fields = <PlanFields type={type} plan={plan} entries={entries} cwd={cwd} />;
  const defaults = <Requirements type={type} plan={plan} entries={entries} cwd={cwd} />;
  if (!own.length || ITEM_LISTS[type]) return <>{fields}{defaults}</>;
  return <div className="space-y-2">{fields}<PlanChecks checks={own} />{defaults}</div>;
}

/**
 * The type's default items (`plan.requirements`): each with the checks that
 * prove it, or the reason the agent declined it.
 */
function Requirements({ type, plan, entries, cwd }: {
  type: string;
  plan: unknown;
  entries?: ReadonlyMap<string, Loose>;
  cwd?: string | null;
}) {
  const items = list(rec(plan).requirements);
  if (!items.length) return null;
  return (
    <div data-testid="task-requirements" className="pt-2">
      <Label>Default items</Label>
      <Checklist>
        {items.map((item) => (str(item.declined)
          ? <CheckRow key={str(item.id)} testId="task-plan-item" itemId={str(item.id)} ok={null} text={str(item.text)} full={str(item.text)} declined={str(item.declined)} />
          : <PlanItem key={str(item.id)} type={type} item={item} entries={entries} cwd={cwd} text={str(item.text)} />))}
      </Checklist>
    </div>
  );
}

/**
 * The agent's reason for each type it could have picked, its own type's
 * first (docs/tasks.md, "Task types"), folded behind "Why this type".
 */
export function TypeDecisions({ type, decisions }: { type: string; decisions?: Record<string, string> | null }) {
  const reasons = Object.entries(decisions ?? {}).filter(([, why]) => typeof why === 'string' && why.trim());
  if (!reasons.length) return null;
  reasons.sort(([a], [b]) => Number(b === type) - Number(a === type));
  return (
    <Collapsible>
      <CollapsibleTriggerRow size="sm">Why this type</CollapsibleTriggerRow>
      <CollapsibleContent className="pt-1">
        <ul data-testid="task-decisions" className="space-y-0.5 text-xs">
          {reasons.map(([name, why]) => (
            <li key={name} data-testid="task-decision" data-chosen={name === type ? 'yes' : 'no'}
              className={cn('break-words', name === type ? 'text-foreground' : 'text-muted-foreground')}>
              <span className={cn('font-mono', name === type && 'font-semibold')}>{name}</span>{`: ${why}`}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function PlanFields({ type, plan, entries, cwd }: {
  type: string;
  plan: unknown;
  entries?: ReadonlyMap<string, Loose>;
  cwd?: string | null;
}) {
  const p = rec(plan);
  const items = (key: string) => <ItemList type={type} items={list(p[key])} entries={entries} cwd={cwd} />;
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
      return <div className="space-y-2"><Field label="Outcome">{str(p.outcome)}</Field><div><Label>Criteria</Label>{items('criteria')}</div></div>;
    case 'general':
      return <div className="space-y-2"><Field label="Outcome">{str(p.outcome)}</Field><div><Label>Done when</Label>{items('done_when')}</div></div>;
    case 'ui_change':
      if (entries?.size || list(p.screens).some((s) => itemChecks(s).length > 0)) {
        return (
          <Checklist>{list(p.screens).map((s) => (
            <PlanItem key={str(s.id)} type={type} item={s} entries={entries} cwd={cwd} text={<span className="font-medium">{str(s.name)}</span>}>
              <div className="text-xs text-muted-foreground">{str(s.how_to_reach)}</div>
              <div className="text-sm">{str(s.change)}</div>
            </PlanItem>
          ))}</Checklist>
        );
      }
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
    case 'ui_feature':
      return (
        <div className="space-y-2">
          <Field label="Outcome">{str(p.outcome)}</Field>
          <div><Label>Screens</Label>
            <Checklist>{list(p.screens).map((s) => (
              <PlanItem key={str(s.id)} type={type} item={s} entries={entries} cwd={cwd} text={<span className="font-medium">{str(s.name)}</span>}>
                <div className="text-xs text-muted-foreground">{`${str(s.how_to_reach)}${s.existed === true ? ' · existed' : ' · new'}`}</div>
                <div className="text-sm">{str(s.shows)}</div>
              </PlanItem>
            ))}</Checklist>
          </div>
        </div>
      );
    case 'render_feature':
      return (
        <div className="space-y-2">
          <Field label="Outcome">{str(p.outcome)}</Field>
          <div><Label>Scenes</Label>
            <Checklist>{list(p.scenes).map((s) => (
              <PlanItem key={str(s.id)} type={type} item={s} entries={entries} cwd={cwd} text={<span className="font-medium">{str(s.name)}</span>}>
                <div className="text-xs text-muted-foreground">
                  {`${str(s.scene)} · camera: ${str(s.camera)}${s.existed === true ? ' · existed' : ' · new'}${s.reference === true ? ' · reference image asked for' : ''}`}
                </div>
                <div className="text-sm">{str(s.shows)}</div>
              </PlanItem>
            ))}</Checklist>
          </div>
        </div>
      );
    case 'ui_bug':
      return (
        <div className="space-y-2">
          <PlanView type="bug" plan={p} />
          <div><Label>Screens</Label>
            <Checklist>{list(p.screens).map((s) => (
              <PlanItem key={str(s.id)} type={type} item={s} entries={entries} cwd={cwd} text={<span className="font-medium">{str(s.name)}</span>}>
                <div className="text-xs text-muted-foreground">{str(s.how_to_reach)}</div>
              </PlanItem>
            ))}</Checklist>
          </div>
        </div>
      );
    case 'render_bug':
      return (
        <div className="space-y-2">
          <PlanView type="bug" plan={p} />
          <div><Label>Scenes</Label>
            <Checklist>{list(p.scenes).map((s) => (
              <PlanItem key={str(s.id)} type={type} item={s} entries={entries} cwd={cwd} text={<span className="font-medium">{str(s.scene)}</span>}>
                <div className="text-xs text-muted-foreground">{`Camera: ${str(s.camera)}${s.reference === true ? ' · reference image asked for' : ''}`}</div>
              </PlanItem>
            ))}</Checklist>
          </div>
        </div>
      );
    case 'render_change':
      return (
        <div><Label>Scenes</Label>
          <Checklist>{list(p.scenes).map((s) => (
            <PlanItem key={str(s.id)} type={type} item={s} entries={entries} cwd={cwd} text={<span className="font-medium">{str(s.scene)}</span>}>
              <div className="text-xs text-muted-foreground">{`Camera: ${str(s.camera)}${s.reference === true ? ' · reference image asked for' : ''}`}</div>
              <div className="text-sm">{str(s.change)}</div>
            </PlanItem>
          ))}</Checklist>
        </div>
      );
    case 'optimization':
      // Once a target is measured, the plan reads as the before/after table.
      if (entries?.size) return <OptimizationResultTable plan={p} result={{ targets: [...entries.values()] }} />;
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
      return <div><Label>Questions</Label>{items('questions')}</div>;
    case 'refactor':
      return (
        <div className="space-y-2">
          <Field label="Change">{str(p.change)}</Field>
          <Field label="Reason">{str(p.reason)}</Field>
          <div><Label>Invariants</Label>{items('invariants')}</div>
        </div>
      );
    case 'tests':
      return <div><Label>Behaviors</Label>{items('behaviors')}</div>;
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
            <PlanItem key={str(s.id)} type={type} item={s} entries={entries} cwd={cwd} text={str(s.expected)}><Bullets items={strings(s.steps)} ordered /></PlanItem>
          ))}</Checklist>
        </div>
      );
    case 'docs':
      return (
        <div className="space-y-2">
          <Field label="Audience">{str(p.audience)}</Field>
          <div><Label>Pages</Label>
            <Checklist>{list(p.pages).map((page) => (
              <PlanItem key={str(page.id)} type={type} item={page} entries={entries} cwd={cwd} text={<span className="font-mono text-xs">{str(page.path)}</span>}>
                <div className="text-sm">{str(page.change)}</div>
              </PlanItem>
            ))}</Checklist>
          </div>
        </div>
      );
    case 'chore':
      return <div><Label>Steps</Label>{items('steps')}</div>;
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

/**
 * The visual types: each screen or scene with its images, behind a toggle
 * each, or `inline` where the images are what is being reviewed.
 */
function VisualResult({ type, plan, result, cwd, inline = false }: { type: string; plan: Loose; result: Loose; cwd?: string | null; inline?: boolean }) {
  const key = ITEM_LISTS[type]?.result ?? 'screens';
  const shots = byId(list(result[key]));
  return (
    <div data-testid="task-visual-result" className={inline ? 'space-y-3' : 'space-y-2'}>
      {list(plan[ITEM_LISTS[type]?.plan ?? 'screens']).map((item) => {
        const shot = shots.get(str(item.id));
        const name = itemText(type, item);
        return (
          <div key={str(item.id)} data-testid="ui-screen">
            <div className="text-sm font-medium">{name}</div>
            {shot ? (
              <ShotPair name={name} before={str(shot.before) || undefined} after={str(shot.after)} reference={str(shot.reference) || undefined} cwd={cwd} inline={inline} />
            ) : <Shortfall>No images</Shortfall>}
            {shot && str(shot.notes) && <div className="text-xs text-muted-foreground">{str(shot.notes)}</div>}
          </div>
        );
      })}
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

/** A `plan` task's document. */
function PlanDocument({ result }: { result: Loose }) {
  if (!str(result.document)) return null;
  return (
    <Panel tone="nested" inset="md" data-testid="plan-document">
      <MarkdownBody>{str(result.document)}</MarkdownBody>
    </Panel>
  );
}

export function ResultView({ type, plan, result, cwd, summarised = false }: {
  type: string;
  plan: unknown;
  result: unknown;
  cwd?: string | null;
  /** Shown under a done summary, which already says the root cause and fix, and shows a plan's document. */
  summarised?: boolean;
}) {
  const p = rec(plan);
  const r = rec(result);
  switch (type) {
    case 'optimization':
      return <OptimizationResultTable plan={p} result={r} />;
    case 'feature':
      return (
        <div className="space-y-2">
          <MetList label="Criteria" planned={list(p.criteria)} results={list(r.criteria)} cwd={cwd} />
          {!summarised && <Screenshots result={r} cwd={cwd} />}
        </div>
      );
    case 'general':
      return <MetList label="Done when" planned={list(p.done_when)} results={list(r.done_when)} cwd={cwd} />;
    case 'qa':
      return <MetList label="Scenarios" planned={list(p.scenarios)} results={list(r.scenarios)} cwd={cwd} />;
    case 'chore':
      return <MetList label="Steps" planned={list(p.steps)} results={list(r.steps)} cwd={cwd} />;
    case 'ui_change':
    case 'ui_feature':
    case 'render_change':
    case 'render_feature':
      return <VisualResult type={type} plan={p} result={r} cwd={cwd} />;
    case 'ui_bug':
    case 'render_bug':
      return (
        <div className="space-y-2">
          {!summarised && <Field label="Root cause">{str(r.root_cause)}</Field>}
          {!summarised && <Field label="Fix">{str(r.fix)}</Field>}
          <div><Label>{type === 'render_bug' ? 'Scenes' : 'Screens'}</Label><VisualResult type={type} plan={p} result={r} cwd={cwd} /></div>
        </div>
      );
    case 'plan':
      return (
        <div className="space-y-3">
          {!summarised && <PlanDocument result={r} />}
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
          {!summarised && <Field label="Root cause">{str(r.root_cause)}</Field>}
          {!summarised && <Field label="Fix">{str(r.fix)}</Field>}
          <div><Label>Proof</Label><Evidence value={str(r.proof)} cwd={cwd} /></div>
          {strings(r.regression_checked).length > 0 && <div><Label>Regressions checked</Label><Bullets items={strings(r.regression_checked)} /></div>}
          {!summarised && <Screenshots result={r} cwd={cwd} />}
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
export function ownerActions(task: Pick<Task, 'status' | 'sessionId'>): OwnerAction[] {
  const actions: OwnerAction[] = [];
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
 * card shows the review ones; the Tasks tab shows them all.
 */
export function TaskOwnerActions({ task, only, onChanged, className }: {
  task: Task;
  only?: OwnerAction[];
  onChanged?: (task: Task) => void;
  className?: string;
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
    <div className={cn('space-y-2', className)} data-testid="task-actions">
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
  create: 'Created', start: 'Started', block: 'Blocked', unblock: 'Unblocked', amend: 'Plan changed',
  check: 'Checked', done: 'Finished', cancel: 'Cancelled', take: 'Taken', approve: 'Approved', reopen: 'Reopened',
  undo_amend: 'Change undone', release: 'Released', note: 'Note added',
};

function Section({ label, children }: { label: string; children: ReactNode }) {
  return <section className="space-y-1.5"><Label>{label}</Label>{children}</section>;
}

/** The types whose plan starts with a heading of its own (Outcome, Steps, Symptom…). */
const PLAN_HEADED: ReadonlySet<string> = new Set([
  'bug', 'feature', 'general', 'ui_feature', 'render_feature', 'ui_bug', 'render_bug', 'render_change', 'plan',
  'investigation', 'refactor', 'tests', 'review', 'qa', 'docs', 'chore',
]);

/** A plan under a "Plan" heading, unless it starts with a heading of its own: never two stacked. */
function PlanSection({ type, children }: { type: string; children: ReactNode }) {
  if (PLAN_HEADED.has(type)) return <section data-testid="task-plan" className="space-y-1.5">{children}</section>;
  return <Section label="Plan">{children}</Section>;
}

/** A plan field's value in a line: words as they are, a list joined. */
function fieldValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '(none)';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join('; ');
  return JSON.stringify(value);
}

/**
 * A proposed plan change: only the items added, removed and changed, and the
 * other fields that changed (plan-diff.ts). Never both whole plans.
 */
export function AmendDiff({ type, plan, amend, reason }: { type: string; plan: unknown; amend: unknown; reason?: string | null }) {
  // Checks are shown check by check below, not as a changed field.
  const listKey = ITEM_LISTS[type]?.plan;
  const diff = planDiff(type, withoutChecks(plan, listKey), withoutChecks(amend, listKey));
  const checks = checkDiff(plan, amend, listKey);
  const names = new Map(list(rec(amend)[listKey ?? '']).concat(list(rec(plan)[listKey ?? ''])).map((item) => [str(item.id), itemText(type, item)]));
  const itemName = (id: string) => (id === 'plan' ? 'The plan' : names.get(id) || id);
  const rows: ReactNode[] = [];
  const row = (key: string, change: string, icon: ReactNode, body: ReactNode) => rows.push(
    <li key={key} data-testid="task-amend-change" data-change={change} className="flex gap-2 py-1">
      <span aria-hidden className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1 break-words text-sm">{body}</div>
    </li>,
  );
  const plus = <Plus className="size-4 text-[var(--color-success-accent)]" />;
  const minus = <Minus className="size-4 text-[var(--color-warning-accent)]" />;
  const pencil = <Pencil className="size-3.5 text-muted-foreground" />;
  for (const item of diff.added) row(`+${item.id}`, 'added', plus, <><span className="sr-only">Added: </span>{item.after || item.id}</>);
  for (const item of diff.removed) row(`-${item.id}`, 'removed', minus, <><span className="sr-only">Removed: </span><span className="text-muted-foreground line-through">{item.before || item.id}</span></>);
  for (const item of diff.changed) row(`~${item.id}`, 'changed', pencil, (
    <>
      {item.before !== item.after ? (
        <>
          <span className="text-muted-foreground line-through">{item.before}</span>
          <span className="block">{item.after}</span>
        </>
      ) : <span>{item.after || item.id}</span>}
      {item.fields.length > 0 && <span className="block text-xs text-muted-foreground">{`Changed: ${item.fields.map(fieldName).join(', ')}`}</span>}
    </>
  ));
  for (const field of diff.fields) row(`f:${field.key}`, 'field', pencil, (
    <>
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{fieldName(field.key)}</span>
      <span className="block text-muted-foreground line-through">{fieldValue(field.before)}</span>
      <span className="block">{fieldValue(field.after)}</span>
    </>
  ));
  return (
    <div className="space-y-2">
      {reason && (
        <div data-testid="task-amend-reason" className="text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Reason</span>
          <p className="whitespace-pre-wrap break-words">{reason}</p>
        </div>
      )}
      {(rows.length > 0 || !checks.length) && (
        <ul data-testid="task-amend-diff" className="divide-y divide-border/60">
          {rows.length ? rows : <li className="py-1 text-sm text-muted-foreground">No change to the plan</li>}
        </ul>
      )}
      <CheckDiffView diffs={checks} itemName={itemName} />
    </div>
  );
}

/** "6 of 7 met · 1 missed", or nothing for a type without plan items. */
export function countsLine(items: readonly ItemProgress[]): string {
  const { met, missed, total } = itemCounts(items);
  if (!total) return '';
  return `${met} of ${total} met${missed ? ` · ${missed} missed` : ''}`;
}

/**
 * What a finished task came to, short: how many plan items were met, only
 * the missed ones with their reasons, the summary, and the commits with
 * whether they are merged. The whole result sits behind Show all, except
 * what is reviewed by looking at it: a visual task's images are shown as
 * they are, and a plan's document comes first.
 */
export function DoneSummary({ task, cwd, counted = false }: {
  task: Task;
  cwd?: string | null;
  /** The line above already gives the counts (a done line in a chat). */
  counted?: boolean;
}) {
  const result = task.result;
  const items = useMemo(() => itemProgress(task), [task]);
  if (!result) return null;
  const counts = countsLine(items);
  const missed = items.filter((item) => item.state === 'missed');
  const total = items.length;
  const commits = Array.isArray(result.commits) ? result.commits.filter((c): c is string => typeof c === 'string') : [];
  const followups = Array.isArray(result.followups) ? result.followups : [];
  const r = rec(result);
  const shape = shapeOf(task);
  const visual = VISUAL_TYPES.has(shape);
  return (
    <div data-testid="task-done-summary" className="space-y-2">
      {task.type === 'plan' && <PlanDocument result={r} />}
      {!counted && (counts || task.shortfalls) && (
        <div data-testid="task-done-counts" className={cn('flex items-center gap-1.5 text-xs', missed.length || task.shortfalls ? 'text-[var(--color-warning-accent)]' : 'text-muted-foreground')}>
          {(missed.length > 0 || task.shortfalls) && <AlertTriangle aria-hidden className="size-3.5" />}
          {counts || 'Finished with shortfalls'}
        </div>
      )}
      {missed.length > 0 && (
        <Checklist>
          {missed.map((item) => (
            <CheckRow key={item.id} testId="task-missed" itemId={item.id} ok={false} text={item.text}>
              <Shortfall>{item.note}</Shortfall>
            </CheckRow>
          ))}
        </Checklist>
      )}
      {['bug', 'ui_bug', 'render_bug'].includes(shapeOf(task)) && (
        <>
          <Field label="Root cause">{str(r.root_cause)}</Field>
          <Field label="Fix">{str(r.fix)}</Field>
        </>
      )}
      {typeof result.summary === 'string' && result.summary && <p className="whitespace-pre-wrap break-words text-sm">{result.summary}</p>}
      {(task.type === 'feature' || task.type === 'bug') && <Screenshots result={r} cwd={cwd} />}
      {visual && <VisualResult type={shape} plan={rec(task.plan)} result={r} cwd={cwd} inline />}
      {commits.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <Label>Commits</Label>
          {commits.map((sha) => <Badge key={sha} variant="outline" size="sm"><span className="font-mono">{sha.slice(0, 10)}</span></Badge>)}
          <MergeBadge task={task} />
        </div>
      )}
      {visual ? <Followups label="Follow-ups" items={followups as Followup[]} /> : (
        <Collapsible>
          <CollapsibleTriggerRow size="sm" data-testid="task-result-all">{total ? `Show all ${total}` : 'Show the whole result'}</CollapsibleTriggerRow>
          <CollapsibleContent className="space-y-3 pt-2">
            <ResultView type={shape} plan={task.plan} result={withCheckedEntries(task)} cwd={cwd} summarised />
            <Followups label="Follow-ups" items={followups as Followup[]} />
          </CollapsibleContent>
        </Collapsible>
      )}
      {/* What may make the result prove less, read last, right before it is answered. */}
      <CheckFlagsPanel flags={readFlags(task.checkFlags)} testCommand={task.testCommandRun} />
    </div>
  );
}

/** How many plan items a chat card lists before "Show all". */
export const ITEMS_SHOWN = 5;

/** The field a type leads its plan with, drawn as one line above its items. */
const LEAD: Record<string, string> = {
  feature: 'outcome', general: 'outcome', refactor: 'change', docs: 'audience', ui_bug: 'symptom', render_bug: 'symptom',
  ui_feature: 'outcome', render_feature: 'outcome',
};

/**
 * The plan as a chat card shows it: one line per item, ticked live as it is
 * checked, cut short with an ellipsis (the whole text is its tooltip and is in
 * the task's detail). More than five fold behind "Show all". A type with no
 * plan items is short enough to show as it is.
 */
export function CompactPlan({ task }: { task: Task }) {
  const [all, setAll] = useState(false);
  const items = useMemo(() => itemProgress(task), [task]);
  const shape = shapeOf(task);
  if (!ITEM_LISTS[shape]) return <PlanView type={shape} plan={task.plan} />;
  const lead = LEAD[shape] ? str(rec(task.plan)[LEAD[shape]!]) : '';
  const shown = all ? items : items.slice(0, ITEMS_SHOWN);
  return (
    <div className="space-y-1">
      {lead && <Tooltip label={lead}><p tabIndex={0} className="truncate text-sm text-foreground">{lead}</p></Tooltip>}
      <ul data-testid="task-plan-items" className="space-y-0.5">
        {shown.map((item) => {
          const Icon = item.declined !== undefined ? CircleSlash : item.state === 'open' ? Circle : item.state === 'met' ? Check : AlertTriangle;
          const why = item.declined !== undefined ? `Declined: ${item.declined}` : item.note;
          return (
            <Tooltip key={item.id} label={why ? `${item.text} — ${why}` : item.text}>
            <li data-testid="task-plan-item" data-item={item.id} data-full={item.text} data-declined={item.declined} tabIndex={0}
              data-met={item.state === 'open' ? 'pending' : item.state === 'met' ? 'yes' : 'no'}
              className="flex min-w-0 flex-wrap items-center gap-x-2 rounded-sm text-sm sm:flex-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Icon aria-label={item.declined !== undefined ? 'Declined' : item.state === 'met' ? 'Met' : item.state === 'missed' ? 'Missed' : 'Open'} className={cn('size-3.5 shrink-0',
                item.state === 'open' ? 'text-muted-foreground' : item.state === 'met' ? 'text-[var(--color-success-accent)]' : 'text-[var(--color-warning-accent)]')} />
              <span className={cn('min-w-0 truncate', item.state === 'open' && 'text-muted-foreground')}>{item.text}</span>
              {item.declined !== undefined && (
                <span data-testid="task-plan-item-declined" className="min-w-0 basis-full break-words pl-[22px] text-xs text-muted-foreground sm:basis-auto sm:shrink sm:truncate sm:pl-0">{`Declined: ${item.declined}`}</span>
              )}
              {item.checks?.ran && item.state !== 'met' && (
                <span data-testid="task-plan-item-tally" className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{tallyLine(item.checks)}</span>
              )}
            </li>
            </Tooltip>
          );
        })}
      </ul>
      {items.length > ITEMS_SHOWN && (
        <Button type="button" variant="ghost" size="xs" data-testid="task-plan-show-all" aria-expanded={all}
          className="-ml-2 text-muted-foreground" onClick={() => setAll((open) => !open)}>
          {all ? 'Show fewer' : `Show all ${items.length}`}
        </Button>
      )}
    </div>
  );
}

/**
 * The task card. Draws the task as it stands now where the screen knows it
 * (`LiveTasksContext`), and otherwise the snapshot it was given.
 *
 * In a chat (`event` given) it is the one card a task prints, when it is
 * created: the header and its plan items, one line each, ticked live. Every
 * later change prints a one-line row instead (task-event-row.tsx). Without
 * `event` it is the Tasks tab's detail: the whole task.
 */
export function TaskCard({ task: snapshot, event, actions = ['approve', 'reopen'] }: {
  task: Task;
  /** The action that printed this card, for a chat card. */
  event?: string;
  /** Which owner buttons to offer. */
  actions?: OwnerAction[];
}) {
  const live = useLiveTask(snapshot);
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
  // Plan items checked so far, ticked on the plan while the work goes on.
  const shape = shapeOf(task);
  const checked = useMemo(() => recordedEntries({ type: shape, result: null, checks: task.checks }), [shape, task.checks]);
  const counts = countsLine(itemProgress(task));
  const flags = useMemo(() => readFlags(task.checkFlags), [task.checkFlags]);
  const gate = useMemo<CheckGate | null>(() => (gated(task) || flags.length
    ? { runs: task.checkRuns, met: task.checkMet ?? {}, baseline: task.checkBaseline, flags }
    : null), [task, flags]);

  const title = <h4 className={cn('text-sm font-semibold text-foreground', task.status === 'cancelled' && 'text-muted-foreground line-through')}>{task.title}</h4>;
  const header = (
    <header className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">#{task.number}</span>
          <Badge variant="secondary" size="sm"><span>{typeLabel(task.type)}</span></Badge>
          {event && EVENT_LABEL[event] && <span className="text-xs text-muted-foreground">{EVENT_LABEL[event]}</span>}
          <span className="ml-auto flex items-center gap-2">
            {event && counts && <span data-testid="task-card-counts" className="text-xs tabular-nums text-muted-foreground">{counts}</span>}
            <TaskStatusChip status={status} />
          </span>
        </div>
        {event ? (
          <Button type="button" variant="ghost" size="inherit" data-testid="task-card-open" onClick={() => openTaskDetail(task.number)}
            className="block h-auto w-full whitespace-normal rounded-sm text-left hover:bg-transparent hover:underline">
            {title}
          </Button>
        ) : title}
        {task.why && (event
          ? <Tooltip label={task.why}><p tabIndex={0} className="truncate text-xs text-muted-foreground">{task.why}</p></Tooltip>
          : <p className="text-xs text-muted-foreground">{task.why}</p>)}
        <TypeDecisions type={task.type} decisions={task.decisions} />
    </header>
  );

  // In a chat: the header and the plan's items, nothing more. What happens
  // to the task later is told by one-line rows, and the detail has the rest.
  if (event) return (
    <div data-testid="task-card" data-task-type={task.type} data-task-status={status} data-compact="yes" className="space-y-2">
      {header}
      {task.claimShape && <ClaimShapeLink shape={task.claimShape} projectId={task.projectId} />}
      <CompactPlan task={task} />
    </div>
  );

  return (
    <div data-testid="task-card" data-task-type={task.type} data-task-status={status} className="space-y-3">
      {header}

      {task.status === 'blocked' && task.blocked && (
        <Panel tone="attention" inset="sm" data-testid="task-blocked" className="space-y-1">
          <Field label="Blocked by">{task.blocked.cause}</Field>
          <Field label="Needed to continue">{task.blocked.needed_to_resume}</Field>
        </Panel>
      )}

      {task.status === 'cancelled' && task.cancelReason && (
        <Panel tone="default" inset="sm"><Field label="Cancelled">{task.cancelReason}</Field></Panel>
      )}

      {result ? (
        <>
          <Section label="Result"><DoneSummary task={task} cwd={cwd} /></Section>
          {/* The answer to a result sits right after it. */}
          {reviewing && (
            <TaskOwnerActions task={task} only={actions.filter((a) => a === 'approve' || a === 'reopen')} onChanged={setActed} />
          )}
          <Collapsible>
            <CollapsibleTriggerRow size="sm">Plan</CollapsibleTriggerRow>
            <CollapsibleContent className="pt-2"><CheckGateProvider gate={gate}><PlanView type={shape} plan={task.plan} /></CheckGateProvider></CollapsibleContent>
          </Collapsible>
        </>
      ) : (
        <PlanSection type={shape}>
          <CheckGateProvider gate={gate}><PlanView type={shape} plan={task.plan} entries={checked} cwd={cwd} /></CheckGateProvider>
          <FlagLines flags={flagsFor(flags, undefined)} />
        </PlanSection>
      )}

      <TaskCells task={task} />

      <Section label="Notes">
        <NotesView
          testId="task-notes"
          notes={task.notes ?? []}
          onAdd={async (text) => {
            const { task: next } = await tasksApi.act(task.projectId, task.number, 'note', { text });
            setActed(next);
          }}
        />
      </Section>

      {reviewing && !result && (
        <TaskOwnerActions task={task} only={actions.filter((a) => a === 'approve' || a === 'reopen')} onChanged={setActed} />
      )}
    </div>
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
  const pending = proposal.status === 'pending';
  const { projectId, id } = snapshot;
  const proposalGate = useMemo<CheckGate>(() => ({ flags: readFlags(proposal.checkFlags) }), [proposal.checkFlags]);

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

  return (
    <div data-testid="task-proposal" data-proposal-id={id} data-proposal-status={proposal.status} className="space-y-3">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Proposed task</span>
          <Badge variant="secondary" size="sm"><span>{typeLabel(proposal.type)}</span></Badge>
        </div>
        <h4 className={cn('text-sm font-semibold text-foreground', proposal.status === 'cancelled' && 'text-muted-foreground line-through')}>{proposal.title}</h4>
        {proposal.why && <p className="text-xs text-muted-foreground">{proposal.why}</p>}
        <TypeDecisions type={proposal.type} decisions={proposal.decisions} />
      </header>
      <PlanSection type={shapeOf(proposal)}>
        <CheckGateProvider gate={proposalGate}><PlanView type={shapeOf(proposal)} plan={proposal.plan} /></CheckGateProvider>
        <FlagLines flags={flagsFor(proposalGate.flags ?? [], undefined)} />
      </PlanSection>
      <ProposalCells proposal={proposal} />
      {pending ? (
        <ProposalActions projectId={projectId} id={id} onAnswered={setProposal} />
      ) : (
        <p data-testid="proposal-answer" className="text-xs text-muted-foreground">{proposal.status === 'pending' ? '' : ANSWERED[proposal.status](proposal)}</p>
      )}
    </div>
  );
}

/** The owner's three answers to a proposal, wherever it is answered from. */
export function ProposalActions({ projectId, id, onAnswered, className }: {
  projectId: string;
  id: number;
  onAnswered?: (proposal: TaskProposal) => void;
  className?: string;
}) {
  const [busy, setBusy] = useState<ProposalChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const answer = async (choice: ProposalChoice) => {
    setBusy(choice);
    setError(null);
    try {
      const answered = await tasksApi.answerProposal(projectId, id, choice);
      onAnswered?.(answered.proposal);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap gap-2" data-testid="proposal-actions">
        <Button type="button" size="sm" disabled={busy !== null} loading={busy === 'create'} onClick={() => void answer('create')}>Create task</Button>
        <Button type="button" size="sm" variant="outline" disabled={busy !== null} loading={busy === 'just_do_it'} onClick={() => void answer('just_do_it')}>Just do it</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy !== null} loading={busy === 'cancel'} onClick={() => void answer('cancel')}>Cancel</Button>
      </div>
      {error && <div role="alert" className="text-xs text-destructive">{`Couldn't answer. ${error}`}</div>}
    </div>
  );
}
