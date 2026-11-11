'use client';

/**
 * The project's Tasks tab (docs/tasks.md, "Front end"): every task, grouped by
 * status, with a detail panel holding the card, its history and the owner's
 * actions.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { AlertTriangle, ListTodo, MessageSquarePlus, Plus, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTriggerRow } from '@/components/ui/collapsible';
import { Panel } from '@/components/ui/panel';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ReadFailed } from '@/components/ui/read-failed';
import { Row } from '@/components/ui/row';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { tasks as tasksApi } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { useLiveSessions, type LiveSession } from '@/workbench/live';
import { ComposerPrefillContext, prefillChat } from '@/workbench/tasks/composer-prefill';
import { startTaskIn } from '@/workbench/tasks/new-task';
import { isStale, STALE_REASON } from '@/workbench/tasks/stale';
import { TaskCard, TaskOwnerActions, TaskStatusChip, shownStatus } from '@/workbench/tasks/task-card';
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

const EVENT_LABEL: Record<string, string> = {
  created: 'Created', started: 'Started', blocked: 'Blocked', unblocked: 'Unblocked',
  amend_proposed: 'Plan change proposed', amend_approved: 'Plan change approved', amend_rejected: 'Plan change rejected',
  done: 'Finished', submitted: 'Submitted for review', approved: 'Approved', reopened: 'Reopened',
  cancelled: 'Cancelled', taken: 'Moved to chat', released: 'Released',
};

/** The words an event carries worth showing: a note, a reason, a cause. */
function eventDetail(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object' || payload === null) return '';
  const p = payload as Record<string, unknown>;
  for (const key of ['note', 'reason', 'cause', 'summary']) {
    if (typeof p[key] === 'string' && p[key]) return p[key] as string;
  }
  return '';
}

function History({ events }: { events: TaskEvent[] | null }) {
  if (events === null) return <Spinner className="size-4 text-muted-foreground" />;
  if (!events.length) return <p className="text-xs text-muted-foreground">No history</p>;
  return (
    <ol data-testid="task-history" className="space-y-1.5">
      {[...events].sort((a, b) => b.seq - a.seq).map((event) => (
        <li key={event.seq} className="flex gap-2 text-xs">
          <time className="w-36 shrink-0 tabular-nums text-muted-foreground" dateTime={new Date(event.at).toISOString()}>
            {new Date(event.at).toLocaleString()}
          </time>
          <div className="min-w-0">
            <span className="font-medium text-foreground">{EVENT_LABEL[event.kind] ?? event.kind}</span>
            <span className="text-muted-foreground">{` · ${event.actor === 'owner' ? 'Owner' : 'Agent'}`}</span>
            {eventDetail(event.payload) && <div className="whitespace-pre-wrap break-words text-muted-foreground">{eventDetail(event.payload)}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function TaskDetail({ task, onClose, onOpenChat }: {
  task: Task;
  onClose: () => void;
  onOpenChat?: (sessionId: string) => void;
}) {
  const [events, setEvents] = useState<TaskEvent[] | null>(null);
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
          <span className="text-sm font-medium">{`Task #${task.number}`}</span>
          {task.sessionId && onOpenChat && (
            <Button type="button" variant="ghost" size="xs" onClick={() => onOpenChat(task.sessionId!)}>Open chat</Button>
          )}
          <Button type="button" variant="ghost" size="icon" aria-label="Close" className="ml-auto size-8" onClick={onClose}>
            <X />
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <TaskCard task={task} />
          <TaskOwnerActions task={task} only={['cancel', 'release']} />
          <section className="space-y-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">History</h3>
            <History events={events} />
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
 */
function NewTaskButton({ projectId, onOpenChat, onNewChat }: {
  projectId: string;
  onOpenChat: (sessionId: string) => void;
  onNewChat?: () => void;
}) {
  const live = useLiveSessions();
  const chats = useMemo(
    () => live
      .filter((s) => s.projectId === projectId)
      .map((s) => ({ id: s.id, name: s.name || s.title || 'Untitled chat' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [live, projectId],
  );
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline" data-testid="new-task">
          <Plus aria-hidden />
          New task
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1" data-testid="new-task-chats">
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Start the task in</p>
        {onNewChat && (
          <Row gap="md" inset="sm" radius="md" data-testid="new-task-new-chat" onClick={() => { setOpen(false); onNewChat(); }}>
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
                startTaskIn(chat.id);
                onOpenChat(chat.id);
              }}
            >
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
  const [reason, setReason] = useState(STALE_REASON);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await tasksApi.act(task.projectId, task.number, 'cancel', { reason: reason.trim() });
      setOpen(false);
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^API error: \d+\s*/, ''));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) { setReason(STALE_REASON); setError(null); }
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" size="xs" variant="ghost" className="mx-2 shrink-0" data-testid="task-row-cancel" aria-label={`Cancel task #${task.number}`}>
          Cancel
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="space-y-2">
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) void send();
          }}
        >
          <Textarea autoFocus rows={2} aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="destructive" disabled={!reason.trim()} loading={busy}>Cancel task</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Back</Button>
          </div>
          {error && <div role="alert" className="text-xs text-destructive">{`Couldn't cancel task. ${error}`}</div>}
        </form>
      </PopoverContent>
    </Popover>
  );
}

export default function TasksTab({ projectId, selected: shown, onSelect, onOpenChat, onNewChat }: {
  projectId: string;
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
}) {
  const { tasks, loaded, error, refetch } = useTasks(projectId);
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
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
            <Select value={filterValue(filter)} onValueChange={(value) => setFilter(filterFrom(value))}>
              <SelectTrigger className="h-8 w-56" aria-label="Chat" data-testid="tasks-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All chats</SelectItem>
                <SelectItem value="unassigned">Unassigned</SelectItem>
                {holders.map(([id, name]) => <SelectItem key={id} value={`session:${id}`}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">{`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}`}</span>
            {onOpenChat && <NewTaskButton projectId={projectId} onOpenChat={onOpenChat} onNewChat={onNewChat} />}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
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
                    open={open[group.status] ?? !FOLDED.has(group.status)}
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
                              className="min-h-10 min-w-0 flex-1"
                            >
                              <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">#{task.number}</span>
                              <Badge variant="secondary" size="sm" className="shrink-0"><span>{typeLabel(task.type)}</span></Badge>
                              <span className={cn('min-w-0 flex-1 truncate text-sm', task.status === 'cancelled' && 'text-muted-foreground line-through')}>{task.title}</span>
                              <span className="hidden max-w-48 shrink-0 truncate text-xs text-muted-foreground sm:inline">{sessionName(task, sessions)}</span>
                              {stale.has(task.number) && (
                                <Badge variant="warning" appearance="light" size="sm" data-testid="task-row-stale" className="shrink-0"><span>Stale</span></Badge>
                              )}
                              {task.pendingAmend && (
                                <Badge variant="warning" appearance="light" size="sm" data-testid="task-row-amend" className="shrink-0"><span>Plan change</span></Badge>
                              )}
                              {task.shortfalls && (
                                <AlertTriangle role="img" aria-label="Finished with shortfalls" data-testid="task-row-shortfalls" className="size-3.5 shrink-0 text-[var(--color-warning-accent)]" />
                              )}
                              <TaskStatusChip status={shownStatus(task, task.sessionId ? sessions.get(task.sessionId)?.state : undefined)} className="shrink-0" />
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
