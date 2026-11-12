'use client';

/**
 * The project's Tasks tab (docs/tasks.md, "Front end"): every task, grouped by
 * status, with a detail panel holding the card, its history and the owner's
 * actions.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { AlertTriangle, Ban, ListTodo, LogOut, MessageSquare, MessageSquarePlus, MoreHorizontal, Plus, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTriggerRow } from '@/components/ui/collapsible';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Panel } from '@/components/ui/panel';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ReadFailed } from '@/components/ui/read-failed';
import { Row } from '@/components/ui/row';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import { toast } from '@/hooks/use-toast';
import { cellFrom } from '@/lib/address';
import { tasks as tasksApi } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { useProjectChats } from '@/workbench/grids/create-task';
import GridsView from '@/workbench/grids/grids-view';
import { claimShapeLabel } from '@/workbench/grids/task-cells';
import { useLiveSessions, type LiveSession } from '@/workbench/live';
import { ComposerPrefillContext, prefillChat } from '@/workbench/tasks/composer-prefill';
import { lineForNewChat, NEW_TASK_LINE, startTaskIn } from '@/workbench/tasks/new-task';
import { same } from '@/workbench/tasks/plan-diff';
import { isStale, STALE_REASON } from '@/workbench/tasks/stale';
import { MergeBadge, TaskCard, TaskStatusChip, ownerActions, shownStatus, type ShownStatus } from '@/workbench/tasks/task-card';
import { eventText } from '@/workbench/tasks/task-event-row';
import { STATUS_LABEL, typeLabel, type Task, type TaskEvent, type TaskStatus } from '@/workbench/tasks/types';
import { byNumber, LiveTasksContext, useTasks } from '@/workbench/tasks/use-tasks';

/** The order the groups are drawn in. */
export const GROUP_ORDER: TaskStatus[] = ['in_progress', 'review', 'blocked', 'todo', 'done', 'cancelled'];
/** Groups that start folded: finished work is looked up, not watched. */
const FOLDED: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled']);

/** All tasks, the ones no chat holds, or one chat's. */
export type SessionFilter = 'all' | 'unassigned' | { session: string };

export function filterTasks(tasks: Task[], filter: SessionFilter): Task[] {
  if (filter === 'all') return tasks;
  if (filter === 'unassigned') return tasks.filter((task) => !task.sessionId);
  return tasks.filter((task) => task.sessionId === filter.session);
}

export interface TaskGroup { status: TaskStatus; label: string; tasks: Task[] }

/** Tasks by status, in `GROUP_ORDER`; newest number first within a group. Empty groups are left out. */
export function groupTasks(tasks: Task[]): TaskGroup[] {
  return GROUP_ORDER.flatMap((status) => {
    const found = tasks.filter((task) => task.status === status).sort((a, b) => b.number - a.number);
    return found.length ? [{ status, label: STATUS_LABEL[status], tasks: found }] : [];
  });
}

const filterValue = (filter: SessionFilter) => (typeof filter === 'string' ? filter : `session:${filter.session}`);
const filterFrom = (value: string): SessionFilter =>
  value === 'all' || value === 'unassigned' ? value : { session: value.replace(/^session:/, '') };

function sessionName(task: Task, sessions: ReadonlyMap<string, LiveSession>): string {
  if (!task.sessionId) return 'Unassigned';
  const live = sessions.get(task.sessionId);
  return task.sessionTitle || live?.name || live?.title || 'Untitled chat';
}

/** A stored event's kind, as the chat's task rows name the same change. */
const CHAT_EVENT: Record<string, string> = {
  started: 'start', checked: 'check', blocked: 'block', unblocked: 'unblock', amend_proposed: 'amend',
  amend_approved: 'approve_amend', amend_rejected: 'reject_amend', done: 'done', submitted: 'done',
  approved: 'approve', reopened: 'reopen', cancelled: 'cancel', released: 'release',
};
/** The changes a chat row has no words for, or words that only fit inside the chat. */
const OWN_LABEL: Record<string, string> = { created: 'Created', taken: 'Moved to another chat' };

const rec = (value: unknown): Record<string, unknown> =>
  (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

/**
 * One history line in the chat rows' words (task-event-row.tsx), read
 * against the task as it is now: a checked item by its text, not its id.
 */
export function historyText(event: Pick<TaskEvent, 'kind' | 'payload'>, task: Task): string {
  if (OWN_LABEL[event.kind]) return OWN_LABEL[event.kind]!;
  const kind = CHAT_EVENT[event.kind];
  if (!kind) return event.kind;
  const payload = rec(event.payload);
  if (kind === 'amend') {
    // The proposal against the plan now; once approved the two are the same and there is nothing to show.
    const plan = rec(payload.plan);
    return Object.keys(plan).length && !same(task.plan, plan) ? eventText(kind, { ...task, pendingAmend: plan }) : 'Plan change proposed';
  }
  if (kind === 'done') return eventText(kind, { ...task, status: event.kind === 'submitted' ? 'review' : 'done' });
  return eventText(kind, task, payload);
}

/** Today's entries by their time, older ones by their date; never the seconds. */
export function historyTime(at: number, now: number = Date.now()): string {
  const when = new Date(at);
  const today = new Date(now);
  if (when.toDateString() === today.toDateString()) return when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return when.toLocaleDateString([], {
    month: 'short', day: 'numeric', ...(when.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function History({ events, task }: { events: TaskEvent[] | null; task: Task }) {
  if (events === null) return <Spinner className="size-4 text-muted-foreground" />;
  if (!events.length) return <p className="text-xs text-muted-foreground">No history</p>;
  const now = Date.now();
  return (
    <ol data-testid="task-history" className="space-y-1.5">
      {[...events].sort((a, b) => b.seq - a.seq).map((event) => (
        <li key={event.seq} className="flex gap-3 text-xs">
          <Tooltip label={new Date(event.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}>
            <time className="w-16 shrink-0 tabular-nums text-muted-foreground" dateTime={new Date(event.at).toISOString()}>
              {historyTime(event.at, now)}
            </time>
          </Tooltip>
          <p className="min-w-0 whitespace-pre-wrap break-words">
            <span className="text-foreground">{historyText(event, task)}</span>
            <span className="text-muted-foreground">{` · ${event.actor === 'owner' ? 'Owner' : 'Agent'}`}</span>
          </p>
        </li>
      ))}
    </ol>
  );
}

const failure = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^API error: \d+\s*/, '');

/** The owner's cancel, with its reason: in the detail, and on a stale row. */
function CancelForm({ task, initial = '', onDone, onBack }: {
  task: Task;
  initial?: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const [reason, setReason] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await tasksApi.act(task.projectId, task.number, 'cancel', { reason: reason.trim() });
      onDone();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-2"
      data-testid="task-cancel-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) void send();
      }}
    >
      <Textarea autoFocus rows={2} aria-label="Reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={!reason.trim()} loading={busy}>Cancel task</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>Back</Button>
      </div>
      {error && <div role="alert" className="text-xs text-destructive">{`Couldn't cancel task. ${error}`}</div>}
    </form>
  );
}

/** Release and Cancel task: used now and then, so kept in the header's More menu. */
function TaskMenu({ task, onCancel, onError }: { task: Task; onCancel: () => void; onError: (message: string | null) => void }) {
  const can = ownerActions(task);
  if (!can.includes('release') && !can.includes('cancel')) return null;
  const release = async () => {
    onError(null);
    try {
      await tasksApi.act(task.projectId, task.number, 'release');
    } catch (e) {
      onError(`Couldn't release task. ${failure(e)}`);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label="More" data-testid="task-more" className="size-8">
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {can.includes('release') && (
          <DropdownMenuItem data-testid="task-release" onSelect={() => void release()}>
            <LogOut aria-hidden />
            Release
          </DropdownMenuItem>
        )}
        {can.includes('cancel') && (
          <DropdownMenuItem data-testid="task-cancel" variant="destructive" onSelect={onCancel}>
            <Ban aria-hidden />
            Cancel task
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskDetail({ task, onClose, onOpenChat }: {
  task: Task;
  onClose: () => void;
  onOpenChat?: (sessionId: string) => void;
}) {
  const [events, setEvents] = useState<TaskEvent[] | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    tasksApi.get(task.projectId, task.number)
      .then((found) => { if (alive) setEvents(found.events); })
      .catch(() => { if (alive) setEvents([]); });
    return () => { alive = false; };
    // Read again whenever the task itself moves: every move is an event.
  }, [task.projectId, task.number, task.updatedAt]);

  // A follow-up becomes a task in the chat that did the work: the line goes
  // into that chat's composer and the chat opens. With no chat to put it in,
  // it is copied instead.
  const createTask = useCallback((line: string) => {
    if (task.sessionId && onOpenChat) {
      prefillChat(task.sessionId, line);
      onOpenChat(task.sessionId);
      return;
    }
    void copyText(line).then((ok) => toast({ title: ok ? 'Copied' : "Couldn't copy" }));
  }, [task.sessionId, onOpenChat]);

  return (
    <ComposerPrefillContext.Provider value={createTask}>
      <div data-testid="task-detail" className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
          {/* The card under it says which task this is; the header holds what is done to it. */}
          {task.sessionId && onOpenChat && (
            <Button type="button" variant="ghost" size="xs" onClick={() => onOpenChat(task.sessionId!)}>
              <MessageSquare aria-hidden />
              Open chat
            </Button>
          )}
          <span className="ml-auto flex items-center gap-1">
            <TaskMenu task={task} onCancel={() => { setError(null); setCancelling(true); }} onError={setError} />
            <Button type="button" variant="ghost" size="icon" aria-label="Close" className="size-8" onClick={onClose}>
              <X />
            </Button>
          </span>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          {cancelling && <CancelForm task={task} onDone={() => setCancelling(false)} onBack={() => setCancelling(false)} />}
          {error && <div role="alert" className="text-xs text-destructive">{error}</div>}
          <TaskCard task={task} />
          <section className="space-y-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">History</h3>
            <History events={events} task={task} />
          </section>
        </div>
      </div>
    </ComposerPrefillContext.Provider>
  );
}

/**
 * The New task button: pick one of this project's chats, or a new one, and it
 * opens with `@task ` waiting in its composer. The agent makes the task from
 * what the owner writes after it (docs/tasks.md, "Principles").
 *
 * A grid's selection has Create task instead, which makes the task itself
 * (grids/create-task.tsx).
 */
export function NewTaskButton({ projectId, onOpenChat, onNewChat, line = NEW_TASK_LINE, label = 'New task', disabled, testId = 'new-task', size = 'sm' }: {
  projectId: string;
  onOpenChat: (sessionId: string) => void;
  onNewChat?: () => void;
  /** What goes into the chat's composer. */
  line?: string;
  label?: string;
  disabled?: boolean;
  testId?: string;
  size?: 'sm' | 'xs';
}) {
  const chats = useProjectChats(projectId);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size={size} variant="outline" data-testid={testId} disabled={disabled}>
          <Plus aria-hidden />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1" data-testid="new-task-chats">
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Start the task in</p>
        {onNewChat && (
          <Row
            gap="md"
            inset="sm"
            radius="md"
            data-testid="new-task-new-chat"
            onClick={() => {
              setOpen(false);
              lineForNewChat(line === NEW_TASK_LINE ? null : line);
              onNewChat();
            }}
          >
            <MessageSquarePlus className="size-4 shrink-0" aria-hidden />
            <span className="text-sm">New chat</span>
          </Row>
        )}
        <div className="max-h-64 overflow-y-auto">
          {chats.map((chat) => (
            <Row
              key={chat.id}
              gap="md"
              inset="sm"
              radius="md"
              data-testid="new-task-chat"
              data-session={chat.id}
              onClick={() => {
                setOpen(false);
                startTaskIn(chat.id, line);
                onOpenChat(chat.id);
              }}
            >
              <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate text-sm">{chat.name}</span>
            </Row>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Cancel for a stale row: one click opens the reason, already written, and one
 * more sends the owner's cancel.
 */
function StaleCancel({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="xs" variant="ghost" className="mx-2 shrink-0" data-testid="task-row-cancel" aria-label={`Cancel task #${task.number}`}>
          Cancel
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        {/* Mounted afresh on each open, so the reason starts from the written one. */}
        <CancelForm task={task} initial={STALE_REASON} onDone={() => setOpen(false)} onBack={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * Tasks | Grids, at the head of the tab (docs/grids.md, "Front end"): the
 * same switch as the project's Chat | Tasks | Files above it.
 */
function ViewSwitch({ view, onView }: { view: 'tasks' | 'grids'; onView: (view: 'tasks' | 'grids') => void }) {
  return (
    <Tabs value={view} onValueChange={(next) => { if (next === 'tasks' || next === 'grids') onView(next); }}>
      <TabsList aria-label="Show" data-testid="tasks-view">
        <TabsTrigger value="tasks" data-testid="tasks-view-tasks">Tasks</TabsTrigger>
        <TabsTrigger value="grids" data-testid="tasks-view-grids">Grids</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

/** The bar at the head of both views, so switching between them moves nothing. */
const TOOLBAR = 'flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2';

/** A row's status chip, left out where the group's heading already says it. */
function RowStatus({ status, group }: { status: ShownStatus; group: TaskStatus }) {
  return status === group ? null : <TaskStatusChip status={status} className="shrink-0" />;
}

type GridPlace = { grid: string | null; cell?: string | null };

export default function TasksTab(props: Omit<Parameters<typeof TaskList>[0], 'switcher'> & {
  /** Tasks or coverage grids, when the screen holds it (the address's `view`). */
  view?: 'tasks' | 'grids';
  onView?: (view: 'tasks' | 'grids') => void;
  /** The grid open in the Grids view, and its open cell (`ROW:COL`). */
  grid?: string | null;
  cell?: string | null;
  /** Shows another grid or cell, or the grids list. */
  onShowGrid?: (where: GridPlace) => void;
  /** Opens a task from a grid's cell. */
  onOpenTask?: (task: number) => void;
}) {
  const { view: heldView, onView, grid: heldGrid, cell: heldCell, onShowGrid, onOpenTask, ...rest } = props;
  const [ownView, setOwnView] = useState<'tasks' | 'grids'>('tasks');
  const [ownPlace, setOwnPlace] = useState<GridPlace>({ grid: null });
  const view = heldView ?? ownView;
  const grid = heldView === undefined ? ownPlace.grid : heldGrid ?? null;
  const cell = heldView === undefined ? ownPlace.cell ?? null : heldCell ?? null;
  const pickView = (next: 'tasks' | 'grids') => {
    if (heldView === undefined) setOwnView(next);
    onView?.(next);
  };
  const showGrid = (where: GridPlace) => {
    if (heldView === undefined) setOwnPlace(where);
    onShowGrid?.(where);
  };
  const switcher = <ViewSwitch view={view} onView={pickView} />;
  if (view === 'tasks') return <TaskList {...rest} switcher={switcher} />;
  return (
    <div data-testid="grids-tab" className="flex min-h-0 flex-1 flex-col">
      <div className={TOOLBAR}>{switcher}</div>
      <GridsView
        projectId={rest.projectId}
        grid={grid}
        cell={cellFrom(cell)}
        onShow={showGrid}
        onOpenChat={rest.onOpenChat}
        onOpenTask={onOpenTask ?? ((task) => { pickView('tasks'); rest.onSelect?.(task); })}
      />
    </div>
  );
}

function TaskList({ projectId, projectPath, selected: shown, onSelect, onOpenChat, onNewChat, switcher }: {
  projectId: string;
  /** The project's repository, watched so Merged follows a merge. */
  projectPath?: string | null;
  /**
   * The task whose detail is open, when the screen holds it (the address's
   * `task`). Left out, the tab keeps its own.
   */
  selected?: number | null;
  /** Asks for another task to be shown, or none. */
  onSelect?: (task: number | null) => void;
  /** Opens a chat in the Chat tab. */
  onOpenChat?: (sessionId: string) => void;
  /** Opens the New chat dialog, whose chat starts with `@task ` in it. */
  onNewChat?: () => void;
  /** Tasks | Grids, drawn at the head of the list. */
  switcher?: ReactNode;
}) {
  const { tasks, loaded, error, refetch } = useTasks(projectId, null, projectPath);
  const live = useLiveSessions();
  const sessions = useMemo(() => new Map(live.map((s) => [s.id, s])), [live]);
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [own, setOwn] = useState<number | null>(null);
  const selected = shown === undefined ? own : shown;
  const setSelected = useCallback((task: number | null) => {
    if (shown === undefined) setOwn(task);
    onSelect?.(task);
  }, [shown, onSelect]);
  const [open, setOpen] = useState<Partial<Record<TaskStatus, boolean>>>({});

  const holders = useMemo(() => {
    const seen = new Map<string, string>();
    for (const task of tasks) if (task.sessionId && !seen.has(task.sessionId)) seen.set(task.sessionId, sessionName(task, sessions));
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [tasks, sessions]);
  const groups = useMemo(() => groupTasks(filterTasks(tasks, filter)), [tasks, filter]);
  const liveTasks = useMemo(() => byNumber(tasks), [tasks]);
  const chosen = selected === null ? null : liveTasks.get(selected) ?? null;
  // Read once per list: a row turning stale while the tab sits open can wait
  // for the next change.
  const stale = useMemo(() => {
    const now = Date.now();
    return new Set(tasks.filter((task) => isStale(task, now)).map((task) => task.number));
  }, [tasks]);

  return (
    <LiveTasksContext.Provider value={liveTasks}>
      <div data-testid="tasks-tab" className="flex min-h-0 flex-1">
        <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', chosen && 'hidden md:flex')}>
          <div className={TOOLBAR}>
            {switcher}
            {/* On a phone the filter, the count and New task share the line under the switch, the filter taking what is left. */}
            <div className="flex min-w-0 basis-full items-center gap-2 sm:flex-1 sm:basis-auto">
            <Select value={filterValue(filter)} onValueChange={(value) => setFilter(filterFrom(value))}>
              <SelectTrigger className="h-8 min-w-0 flex-1 sm:w-56 sm:flex-none" aria-label="Chat" data-testid="tasks-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All chats</SelectItem>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                {holders.map(([id, name]) => <SelectItem key={id} value={`session:${id}`}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground sm:ml-auto">{`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`}</span>
            {onOpenChat && <NewTaskButton projectId={projectId} onOpenChat={onOpenChat} onNewChat={onNewChat} />}
            </div>
          </div>

          {/* A container, so a row drops its chat name when the list is narrow (the detail open) before its title gives way. */}
          <div className="min-h-0 flex-1 overflow-y-auto p-4 [container-type:inline-size]">
            {error && !tasks.length ? (
              <ReadFailed what="Couldn't load tasks." why={error.message} onRetry={refetch} />
            ) : !loaded ? (
              <div className="flex justify-center p-6"><Spinner className="size-5 text-muted-foreground" /></div>
            ) : !groups.length ? (
              <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
                <ListTodo className="size-6" aria-hidden />
                {tasks.length ? 'No results' : 'No tasks yet'}
              </div>
            ) : (
              <div className="mx-auto max-w-4xl space-y-4">
                {groups.map((group) => (
                  <Collapsible
                    key={group.status}
                    // A folded group opens when it holds the open task, so a
                    // link to a done task shows its row as well as its detail.
                    open={open[group.status] ?? (!FOLDED.has(group.status) || group.tasks.some((task) => task.number === selected))}
                    onOpenChange={(next) => setOpen((was) => ({ ...was, [group.status]: next }))}
                    data-testid="task-group"
                    data-status={group.status}
                  >
                    <CollapsibleTriggerRow size="sm" className="mb-1 font-medium">
                      {group.label}
                      <span className="tabular-nums text-muted-foreground">{group.tasks.length}</span>
                      {group.status === 'todo' && group.tasks.some((task) => stale.has(task.number)) && (
                        <span data-testid="task-group-stale" className="text-xs font-normal tabular-nums text-[var(--color-warning-accent)]">
                          {`${group.tasks.filter((task) => stale.has(task.number)).length} stale`}
                        </span>
                      )}
                    </CollapsibleTriggerRow>
                    <CollapsibleContent>
                      <Panel inset="none" className="overflow-hidden">
                        {group.tasks.map((task) => (
                          // The row is a button, so a stale row's Cancel sits beside it, not in it.
                          <div key={task.number} className="flex items-center border-b border-border/40 last:border-b-0">
                            <Row
                              gap="md"
                              selected={task.number === selected}
                              data-testid="task-row"
                              data-number={task.number}
                              onClick={() => setSelected(task.number)}
                              // On a phone the title takes a line of its own under the number and badges,
                              // rather than being cut to a word between them.
                              className="min-h-10 min-w-0 flex-1 flex-wrap gap-y-1 sm:flex-nowrap"
                            >
                              <span className="shrink-0 font-mono text-xs text-muted-foreground sm:w-10">#{task.number}</span>
                              {/* A column of its own, so the titles after it line up. */}
                              <span className="flex shrink-0 sm:w-28">
                                <Badge variant="secondary" size="sm" className="min-w-0"><span className="truncate">{typeLabel(task.type)}</span></Badge>
                              </span>
                              <span data-testid="task-row-title" className={cn('order-last line-clamp-2 min-w-0 basis-full text-sm sm:order-none sm:line-clamp-none sm:flex-1 sm:basis-auto sm:truncate', task.status === 'cancelled' && 'text-muted-foreground')}>{task.title}</span>
                              {task.claimShape && (
                                <span data-testid="task-row-shape" className="hidden max-w-56 shrink-0 truncate text-xs text-muted-foreground sm:inline">{claimShapeLabel(task.claimShape)}</span>
                              )}
                              <span data-testid="task-row-chat" className="ml-auto hidden max-w-48 shrink-0 truncate text-xs text-muted-foreground [@container(min-width:44rem)]:inline">{sessionName(task, sessions)}</span>
                              <span className="ml-auto flex shrink-0 items-center gap-2 sm:ml-0">
                                {stale.has(task.number) && (
                                  <Badge variant="warning" appearance="light" size="sm" data-testid="task-row-stale" className="shrink-0"><span>Stale</span></Badge>
                                )}
                                {task.pendingAmend && (
                                  <Badge variant="warning" appearance="light" size="sm" data-testid="task-row-amend" className="shrink-0"><span>Plan change</span></Badge>
                                )}
                                {task.shortfalls && (
                                  <AlertTriangle role="img" aria-label="Finished with shortfalls" data-testid="task-row-shortfalls" className="size-3.5 shrink-0 text-[var(--color-warning-accent)]" />
                                )}
                                <MergeBadge task={task} className="shrink-0" />
                                <RowStatus status={shownStatus(task, task.sessionId ? sessions.get(task.sessionId)?.state : undefined)} group={group.status} />
                              </span>
                            </Row>
                            {stale.has(task.number) && <StaleCancel task={task} />}
                          </div>
                        ))}
                      </Panel>
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </div>
            )}
          </div>
        </div>

        {chosen && (
          <aside className="flex min-h-0 w-full flex-col border-l border-border/60 md:w-[min(44rem,55%)]">
            <TaskDetail key={chosen.number} task={chosen} onClose={() => setSelected(null)} onOpenChat={onOpenChat} />
          </aside>
        )}
      </div>
    </LiveTasksContext.Provider>
  );
}
