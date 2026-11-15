/**
 * A workflow's runs (docs/designs/workflows.md): the Run dialog that starts
 * the workflow on items its Items command lists, and the list of runs that
 * follows each one from stage to stage.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Play, Workflow as WorkflowIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ToolButton } from '@/components/shell';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Panel } from '@/components/ui/panel';
import { Spinner } from '@/components/ui/spinner';
import { request } from '@/lib/api';

import { StateDot } from './library-list';
import { AgentFields, type WorkflowAgent } from './workflow-agent';
import type { Workflow } from './workflows-settings';

type Item = Record<string, unknown>;
export interface WorkflowRun {
  id: string;
  workflow: string;
  item: Item;
  stage: string;
  status: 'queued' | 'running' | 'waiting' | 'needs_owner' | 'done' | 'stopped';
  sessionId?: string | null;
  note?: string | null;
}

const API = '/api/workbench/workflow-runs';
const STATUS: Record<WorkflowRun['status'], { label: string; tone: 'good' | 'quiet' | 'warn' }> = {
  queued: { label: 'Queued', tone: 'quiet' },
  running: { label: 'Running', tone: 'good' },
  waiting: { label: 'Waiting', tone: 'quiet' },
  needs_owner: { label: 'Needs you', tone: 'warn' },
  done: { label: 'Done', tone: 'good' },
  stopped: { label: 'Stopped', tone: 'quiet' },
};

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
/** What tells items apart, as the server keys them. */
function itemKey(item: Item): string {
  for (const key of ['identifier', 'id', 'key', 'branchName', 'url']) {
    if (text(item[key])) return text(item[key]);
  }
  return JSON.stringify(item);
}

async function act(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await request(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(text(answer.error) || `Request failed (${response.status})`);
  return answer;
}

/** The runs of one workflow, kept fresh while they are shown. */
export function useWorkflowRuns(projectPath: string, workflow: string) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const load = useCallback(async () => {
    const response = await request(`${API}?${new URLSearchParams({ projectPath })}`);
    if (!response.ok) return;
    const answer = (await response.json()) as { runs: WorkflowRun[] };
    setRuns(answer.runs.filter((run) => run.workflow === workflow));
  }, [projectPath, workflow]);
  useEffect(() => {
    void load();
    const every = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(every);
  }, [load]);
  return { runs, reload: load };
}

export function RunDialog({ open, onOpenChange, workflow, projectId, projectPath, onStarted }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflow: Workflow;
  projectId: string;
  projectPath: string;
  onStarted: () => void;
}) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [agent, setAgent] = useState<WorkflowAgent | undefined>(workflow.agent);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setItems(null);
    setPicked(new Set());
    setError('');
    act({ action: 'items', projectPath, workflow: workflow.id })
      .then((answer) => { if (live) setItems((answer.items as Item[]) ?? []); })
      .catch((e: Error) => { if (live) { setItems([]); setError(e.message); } });
    return () => { live = false; };
  }, [open, projectPath, workflow.id]);
  // Each time the dialog opens it starts from the workflow's own agent.
  const savedAgent = JSON.stringify(workflow.agent ?? null);
  useEffect(() => {
    if (open) setAgent(JSON.parse(savedAgent) ?? undefined);
  }, [open, savedAgent]);

  async function start() {
    setStarting(true);
    setError('');
    try {
      const chosen = (items ?? []).filter((item) => picked.has(itemKey(item)));
      await act({ action: 'start', projectId, projectPath, workflow: workflow.id, items: chosen, agent });
      onStarted();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Run {workflow.name}</DialogTitle>
          <DialogDescription>Each item gets its own worktree and chat.</DialogDescription>
        </DialogHeader>
        {items === null ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : items.length === 0 && !error ? (
          <p className="py-4 text-sm text-t-muted">No items to run.</p>
        ) : (
          <ul className="max-h-80 min-w-0 space-y-1 overflow-y-auto">
            {items.map((item) => {
              const key = itemKey(item);
              const id = `run-item-${key.replace(/[^a-zA-Z0-9-]/g, '-')}`;
              return (
                <li key={key} className="flex min-w-0 items-center gap-3 rounded-md px-2 py-1.5 hover:bg-surface-hover">
                  <Checkbox
                    id={id}
                    checked={picked.has(key)}
                    onCheckedChange={(on) => setPicked((now) => {
                      const next = new Set(now);
                      if (on) next.add(key); else next.delete(key);
                      return next;
                    })}
                  />
                  <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer truncate text-sm">
                    <span className="font-medium">{key}</span>
                    {text(item.title) && <span className="text-t-secondary"> {text(item.title)}</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <div className="min-w-0 border-t border-border pt-2">
          <AgentFields agent={agent} onChange={setAgent} projectId={projectId} projectPath={projectPath} idPrefix="run" />
        </div>
        {error && <Panel tone="danger" role="alert" className="break-words text-sm text-danger">{error}</Panel>}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={starting || picked.size === 0 || !agent || !!error && !items?.length} onClick={() => void start()}>
            <Play className="size-3.5" />
            Start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RunsList({ runs, workflow, projectId, onChanged }: {
  runs: WorkflowRun[];
  workflow: Workflow;
  projectId: string;
  onChanged: () => void;
}) {
  const [error, setError] = useState('');
  async function run(action: 'continue' | 'stop', id: string) {
    setError('');
    try {
      await act({ action, run: id });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  if (runs.length === 0) return null;
  return (
    <section className="mt-8 min-w-0" data-testid="workflow-runs">
      <h2 className="mb-2 text-sm font-semibold text-t-secondary">Runs</h2>
      {error && <Panel tone="danger" role="alert" className="mb-2 text-sm text-danger">{error}</Panel>}
      <ul className="divide-y divide-border rounded-lg border border-border">
        {runs.map((r) => {
          const status = STATUS[r.status] ?? STATUS.running;
          const stage = workflow.stages.find((s) => s.id === r.stage)?.name ?? r.stage;
          return (
            <li key={r.id} data-testid="workflow-run" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">
                  <span className="font-medium">{itemKey(r.item)}</span>
                  {text(r.item.title) && <span className="text-t-secondary"> {text(r.item.title)}</span>}
                </div>
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-t-muted">
                  <StateDot tone={status.tone} />
                  <span>{status.label}</span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{stage}</span>
                </div>
                {r.note && <p className="mt-0.5 break-words text-xs text-t-muted">{r.note}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {r.status === 'needs_owner' && (
                  <Button size="sm" variant="outline" onClick={() => void run('continue', r.id)}>Continue</Button>
                )}
                {(r.status === 'queued' || r.status === 'running' || r.status === 'waiting' || r.status === 'needs_owner') && (
                  <Button size="sm" variant="ghost" onClick={() => void run('stop', r.id)}>Stop</Button>
                )}
                {r.sessionId && (
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`/project?id=${encodeURIComponent(projectId)}&tab=chat&chat=${encodeURIComponent(r.sessionId)}`}>Open chat</Link>
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The chat toolbar's way to start a workflow: a menu of the project's
 *  workflows, each opening its Run dialog. */
export function WorkflowsToolButton({ projectId, projectPath }: { projectId: string; projectPath: string }) {
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState<Workflow | null>(null);
  const [running, setRunning] = useState(false);
  // Read each time the menu opens, so a workflow saved in settings shows.
  const load = useCallback(async () => {
    setError('');
    try {
      const response = await request(`/api/settings/workflows?${new URLSearchParams({ path: projectPath })}`);
      if (!response.ok) throw new Error(`Couldn’t load workflows (${response.status})`);
      setWorkflows(((await response.json()) as { workflows: Workflow[] }).workflows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectPath]);
  return (
    <>
      <DropdownMenu onOpenChange={(open) => { if (open) void load(); }}>
        <DropdownMenuTrigger asChild>
          <ToolButton icon={<WorkflowIcon />} label="Run a workflow" className="h-10 w-10 sm:h-8 sm:w-8" data-testid="run-workflow" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Run a workflow</DropdownMenuLabel>
          {error ? (
            <p className="px-2 py-1.5 text-sm text-danger">{error}</p>
          ) : workflows === null ? (
            <div className="flex justify-center py-2"><Spinner /></div>
          ) : workflows.length === 0 ? (
            <DropdownMenuItem asChild>
              <Link href={`/project?id=${encodeURIComponent(projectId)}&settings=workflows`}>No workflows yet. Add one in settings</Link>
            </DropdownMenuItem>
          ) : (
            workflows.map((w) => (
              <DropdownMenuItem key={w.id} onSelect={() => { setChosen(w); setRunning(true); }}>
                <Play className="size-3.5" />
                <span className="truncate">{w.name}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {chosen && (
        <RunDialog open={running} onOpenChange={setRunning} workflow={chosen} projectId={projectId} projectPath={projectPath} onStarted={() => {}} />
      )}
    </>
  );
}
