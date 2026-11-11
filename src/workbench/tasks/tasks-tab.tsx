'use client';

/**
 * The project's Tasks tab (docs/tasks.md, "Front end"): every task, grouped by
 * status, with a detail panel holding the card, its history and the owner's
 * actions.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ListTodo, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTriggerRow } from '@/components/ui/collapsible';
import { Panel } from '@/components/ui/panel';
import { ReadFailed } from '@/components/ui/read-failed';
import { Row } from '@/components/ui/row';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/hooks/use-toast';
import { tasks as tasksApi } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { useLiveSessions, type LiveSession } from '@/workbench/live';
import { ComposerPrefillContext, prefillChat } from '@/workbench/tasks/composer-prefill';
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

export default function TasksTab({ projectId, onOpenChat }: {
  projectId: string;
  /** Opens a chat in the Chat tab. */
  onOpenChat?: (sessionId: string) => void;
}) {
  const { tasks, loaded, error, refetch } = useTasks(projectId);
  const live = useLiveSessions();
  const sessions = useMemo(() => new Map(live.map((s) => [s.id, s])), [live]);
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [selected, setSelected] = useState<number | null>(null);
  const [open, setOpen] = useState<Partial<Record<TaskStatus, boolean>>>({});

  const holders = useMemo(() => {
    const seen = new Map<string, string>();
    for (const task of tasks) if (task.sessionId && !seen.has(task.sessionId)) seen.set(task.sessionId, sessionName(task, sessions));
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [tasks, sessions]);
  const groups = useMemo(() => groupTasks(filterTasks(tasks, filter)), [tasks, filter]);
  const liveTasks = useMemo(() => byNumber(tasks), [tasks]);
  const chosen = selected === null ? null : liveTasks.get(selected) ?? null;

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
                    </CollapsibleTriggerRow>
                    <CollapsibleContent>
                      <Panel inset="none" className="overflow-hidden">
                        {group.tasks.map((task) => (
                          <Row
                            key={task.number}
                            gap="md"
                            ruled
                            selected={task.number === selected}
                            data-testid="task-row"
                            data-number={task.number}
                            onClick={() => setSelected(task.number)}
                            className="min-h-10"
                          >
                            <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">#{task.number}</span>
                            <Badge variant="secondary" size="sm" className="shrink-0"><span>{typeLabel(task.type)}</span></Badge>
                            <span className={cn('min-w-0 flex-1 truncate text-sm', task.status === 'cancelled' && 'text-muted-foreground line-through')}>{task.title}</span>
                            <span className="hidden max-w-48 shrink-0 truncate text-xs text-muted-foreground sm:inline">{sessionName(task, sessions)}</span>
                            <TaskStatusChip status={shownStatus(task, task.sessionId ? sessions.get(task.sessionId)?.state : undefined)} className="shrink-0" />
                          </Row>
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
            <TaskDetail task={chosen} onClose={() => setSelected(null)} onOpenChat={onOpenChat} />
          </aside>
        )}
      </div>
    </LiveTasksContext.Provider>
  );
}
