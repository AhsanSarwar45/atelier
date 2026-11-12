'use client';

/**
 * One line in a chat for each change to a task after it was created
 * (docs/tasks.md, "Front end"): an icon, the task's number and what happened,
 * e.g. `Checked “Button works” — met`. Only the create card shows the plan.
 *
 * While the change still waits on the owner (a plan change not yet answered,
 * a finished task in review) its buttons sit on the line, and once the line
 * is unfolded, after what they decide on. A plan change and a finished task
 * unfold to what they changed and came to, a visual check to its images.
 * Clicking the line opens the task's detail in the Tasks tab; Back returns
 * to the chat.
 */
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';

import {
  AlertTriangle, Ban, Check, ChevronDown, CircleCheckBig, Hand, LogOut, PencilLine, Play, RotateCcw, type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { cn } from '@/lib/utils';
import { useLiveSessions } from '@/workbench/live';
import { openTaskDetail } from '@/workbench/tasks/open-task';
import { diffLine, planDiff, same, type PlanDiff } from '@/workbench/tasks/plan-diff';
import { ITEM_LISTS, VISUAL_TYPES, entryOutcome, itemProgress, itemText, recordedEntries } from '@/workbench/tasks/progress';
import { AmendDiff, DoneSummary, ShotPair, TaskOwnerActions, countsLine } from '@/workbench/tasks/task-card';
import type { OwnerAction, Task, TaskEventDetail } from '@/workbench/tasks/types';
import { useLiveTask } from '@/workbench/tasks/use-tasks';

type Loose = Record<string, unknown>;
const rec = (value: unknown): Loose => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Loose : {});
const list = (value: unknown): Loose[] => (Array.isArray(value) ? value.map(rec) : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/**
 * Whether the change this row tells of still waits on the owner, read from
 * the task now: the same plan change still pending, or the same result still
 * in review. Once answered, here or anywhere, the buttons go.
 */
export function waitsOnOwner(event: string, printed: Task, now: Task): boolean {
  if (event === 'amend') return printed.pendingAmend != null && same(now.pendingAmend, printed.pendingAmend);
  if (event === 'done') return printed.status === 'review' && now.status === 'review' && same(now.result, printed.result);
  return false;
}

/** How a change that waited on the owner was answered, once it was. */
export function answer(event: string, printed: Task, now: Task): string {
  if (waitsOnOwner(event, printed, now)) return '';
  if (event === 'amend' && printed.pendingAmend) {
    if (same(now.plan, printed.pendingAmend)) return 'Approved';
    if (now.pendingAmend == null) return 'Rejected';
  }
  if (event === 'done' && printed.status === 'review') {
    // A later done replaced this result, so this one was sent back, whatever the task says now.
    if (!same(now.result, printed.result)) return 'Reopened';
    if (now.status === 'done') return 'Approved';
    if (now.status !== 'review') return 'Reopened';
  }
  return '';
}

const ICON: Record<string, LucideIcon> = {
  start: Play, unblock: Play, check: Check, block: AlertTriangle, amend: PencilLine, done: CircleCheckBig,
  cancel: Ban, take: Hand, approve: CircleCheckBig, reopen: RotateCcw, approve_amend: Check, reject_amend: Ban, release: LogOut,
};

/** The checked item's name and outcome, from what the change recorded or else from the task. */
function checked(task: Task, detail: TaskEventDetail): { name: string; met: boolean | null; reason: string } | null {
  const id = str(detail.item);
  if (!id) return null;
  const lists = ITEM_LISTS[task.type];
  const item = lists ? list(rec(task.plan)[lists.plan]).find((row) => str(row.id) === id) : undefined;
  const name = (item && itemText(task.type, item)) || id;
  const entry = recordedEntries(task).get(id);
  const outcome = item && entry ? entryOutcome(task.type, item, entry) : null;
  const met = typeof detail.met === 'boolean' ? detail.met : outcome ? outcome.state === 'met' : null;
  return { name, met, reason: str(detail.reason) || (outcome?.state === 'missed' ? outcome.note : '') };
}

/** A plan change counted, for a line whose diff is open under it: `+1 / −1 / 1 changed`. */
export function diffCounts(diff: PlanDiff): string {
  const parts: string[] = [];
  if (diff.added.length) parts.push(`+${diff.added.length}`);
  if (diff.removed.length) parts.push(`−${diff.removed.length}`);
  if (diff.changed.length) parts.push(`${diff.changed.length} changed`);
  if (diff.fields.length) parts.push(`${diff.fields.length} ${diff.fields.length === 1 ? 'field' : 'fields'} changed`);
  return parts.join(' / ') || 'no change';
}

/**
 * What the line says, for the task as it was printed. `unfolded` when what it
 * changed is open under it, so the line counts rather than repeats it.
 */
export function eventText(event: string, task: Task, detail: TaskEventDetail = {}, unfolded = false): string {
  switch (event) {
    case 'start': return 'Started';
    case 'unblock': return 'Unblocked';
    case 'take': return 'Taken by this chat';
    case 'release': return 'Released';
    case 'approve': return 'Approved';
    case 'approve_amend': return 'Plan change approved';
    case 'reject_amend': return 'Plan change rejected';
    case 'check': {
      const item = checked(task, detail);
      if (!item) return 'Checked a plan item';
      const outcome = item.met === null ? '' : item.met ? ' — met' : ` — missed${item.reason ? `: ${item.reason}` : ''}`;
      return `Checked “${item.name}”${outcome}`;
    }
    case 'block': {
      const cause = str(detail.cause) || task.blocked?.cause || '';
      return cause ? `Blocked: ${cause}` : 'Blocked';
    }
    case 'amend': {
      if (!task.pendingAmend) return 'Plan change';
      const diff = planDiff(task.type, task.plan, task.pendingAmend);
      return `Plan change: ${unfolded ? diffCounts(diff) : diffLine(diff)}`;
    }
    case 'done': {
      const counts = countsLine(itemProgress(task));
      const head = task.status === 'review' ? 'Done, ready for review' : 'Done';
      return counts ? `${head} · ${counts}` : task.shortfalls ? `${head} · with shortfalls` : head;
    }
    case 'cancel': {
      const reason = str(detail.reason) || task.cancelReason || '';
      return reason ? `Cancelled: ${reason}` : 'Cancelled';
    }
    case 'reopen': {
      const note = str(detail.note);
      return note ? `Reopened: ${note}` : 'Reopened';
    }
    default: return event;
  }
}

/** Whether the row starts unfolded: only a finished task waiting on the owner's review. */
export function rowOpensByDefault(event: string, waiting: boolean): boolean {
  return event === 'done' && waiting;
}

export function TaskEventRow({ task: printed, event, detail = {} }: { task: Task; event: string; detail?: TaskEventDetail }) {
  const live = useLiveTask(printed);
  const [acted, setActed] = useState<Task | null>(null);
  const now = acted && acted.updatedAt >= live.updatedAt ? acted : live;
  const waiting = waitsOnOwner(event, printed, now);
  const [open, setOpen] = useState(() => rowOpensByDefault(event, waiting));
  const sessions = useLiveSessions();
  const cwd = (printed.sessionId ? sessions.find((s) => s.id === printed.sessionId)?.cwd : null) ?? null;
  const text = useMemo(() => eventText(event, printed, detail, open), [event, printed, detail, open]);
  const answered = answer(event, printed, now);
  const item = event === 'check' ? checked(printed, detail) : null;
  const Icon = item?.met === false ? AlertTriangle : ICON[event] ?? Check;
  const warn = event === 'block' || (event === 'check' && item?.met === false) || (event === 'done' && printed.shortfalls);

  // What the line unfolds to, if anything.
  let more: ReactNode = null;
  if (event === 'amend' && printed.pendingAmend) {
    more = <AmendDiff type={printed.type} plan={printed.plan} amend={printed.pendingAmend} />;
  } else if (event === 'done' && printed.result) {
    // The result as printed, with the merge state as it is now.
    more = <DoneSummary task={same(now.result, printed.result) ? { ...printed, merged: now.merged } : printed} cwd={cwd} counted />;
  } else if (event === 'block' && str(detail.needed_to_resume)) {
    more = <div className="text-sm"><span className="text-muted-foreground">Needed to continue: </span>{str(detail.needed_to_resume)}</div>;
  } else if (event === 'check' && VISUAL_TYPES.has(printed.type) && item) {
    const entry = recordedEntries(printed).get(str(detail.item));
    if (entry) more = <ShotPair name={item.name} before={str(entry.before) || undefined} after={str(entry.after)} reference={str(entry.reference) || undefined} cwd={cwd} inline />;
  }

  // A bare label (Started, Approved) sits on the task's own line rather than on a line of its own.
  const short = !more && !waiting && text.length <= 28;
  const only: OwnerAction[] = event === 'amend' ? ['approve_amend', 'reject_amend'] : event === 'done' ? ['approve', 'reopen'] : [];
  // The owner's buttons: after what they decide on when it is open, on the line when it is folded.
  const buttons = waiting && only.length > 0
    ? <TaskOwnerActions task={now} only={only} onChanged={setActed} className="flex justify-end" />
    : null;
  const unfolded = open && !!more;
  // A click anywhere on the line opens the task, except on its buttons.
  const openFromLine = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, a, textarea, input, form')) return;
    openTaskDetail(printed.number);
  };

  return (
    <Panel inset="none" data-testid="task-event" data-event={event} data-task={printed.number} data-waiting={waiting ? 'yes' : 'no'}
      className="my-1 max-w-4xl">
      {/* The line's own button is the keyboard way in; the rest of the line is a bigger target for a pointer. */}
      <div className="cursor-pointer space-y-1 px-3 py-1.5" onClick={openFromLine}>
        {/* Which task, always: the icon, number and title, with the chevron at the end when there is more. */}
        <div className="flex min-h-6 min-w-0 items-center gap-2">
          <Icon aria-hidden className={cn('size-4 shrink-0', warn ? 'text-[var(--color-warning-accent)]'
            : event === 'done' || event === 'approve' || (event === 'check' && item?.met) ? 'text-[var(--color-success-accent)]' : 'text-muted-foreground')} />
          {short && <span data-testid="task-event-text" className="shrink-0 text-sm">{text}</span>}
          <span className="shrink-0 font-mono text-xs text-muted-foreground">#{printed.number}</span>
          {short ? (
            <Button type="button" variant="ghost" size="inherit" data-testid="task-event-open" onClick={() => openTaskDetail(printed.number)}
              className="block min-w-0 flex-1 truncate text-left text-sm font-normal text-muted-foreground hover:bg-transparent hover:underline">
              {printed.title}
            </Button>
          ) : <span data-testid="task-event-title" className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{printed.title}</span>}
          {answered && <Badge variant="secondary" appearance="light" size="sm" data-testid="task-event-answer" className="shrink-0"><span>{answered}</span></Badge>}
          {more && (
            <Button type="button" variant="ghost" size="none" data-testid="task-event-toggle" aria-expanded={open}
              aria-label={open ? 'Hide details' : 'Show details'} className="-my-1 size-6 shrink-0 text-muted-foreground" onClick={() => setOpen((o) => !o)}>
              <ChevronDown aria-hidden className={cn('size-4 transition-transform', open && 'rotate-180')} />
            </Button>
          )}
        </div>
        {/* What happened, under it across the card's whole width, when it is more than a word or two. */}
        {!short && (
          <Button type="button" variant="ghost" size="inherit" data-testid="task-event-open"
            onClick={() => openTaskDetail(printed.number)}
            className="block h-auto w-full whitespace-normal text-left text-sm font-normal hover:bg-transparent hover:underline">
            <span data-testid="task-event-text" className="break-words">{text}</span>
          </Button>
        )}
        {!unfolded && buttons}
      </div>
      {unfolded && (
        <div data-testid="task-event-more" className="space-y-2 border-t border-border/60 px-3 py-2">
          {more}
          {buttons}
        </div>
      )}
    </Panel>
  );
}
