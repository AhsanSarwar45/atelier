/**
 * Project settings > Workflows: the project's automated flows, listed, and
 * one of them open in the editor (`&pitem=<id>`, or `new` for a draft).
 *
 * The list and the editor are separate pages rather than the library's two
 * panes: a workflow is a sequence of stages that needs the width to read.
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ReadFailed } from '@/components/ui/read-failed';
import { Spinner } from '@/components/ui/spinner';
import { request } from '@/lib/api';
import type { CommandInfo } from '@/workbench/protocol';

import { Label, ListEmpty, ListGroup, ListHeader, ListRow } from './library-list';
import { useOpenItem } from './item-page';
import { WorkflowEditor } from './workflows-editor';

export type StageKind = 'agent' | 'command' | 'wait' | 'approval';
export interface Route { outcome: string; to: string }
/** The owner's gates an agent stage passes by itself. */
export interface StageAuto { plan: boolean; done: boolean; questions: boolean }
export interface Stage { id: string; name: string; kind: StageKind; prompt: string; max_attempts?: number; routes: Route[]; auto?: StageAuto }
export interface Workflow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: { kind: 'manual' | 'schedule'; every_minutes?: number; items?: string };
  setup: { branch?: string; base?: string };
  stages: Stage[];
}
export interface WorkflowsAnswer { workflows: Workflow[]; revision: string; commands: CommandInfo[] }

export const NEW_WORKFLOW = 'new';

/** A name as an ID the server accepts: lowercase letters, digits and hyphens. */
export function slugOf(name: string, taken: Iterable<string>, fallback: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || fallback;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function triggerSummary(workflow: Workflow): string {
  return workflow.trigger.kind === 'schedule' ? `Every ${workflow.trigger.every_minutes ?? '?'} min` : 'Manual';
}

export function stageCount(n: number): string {
  return n === 1 ? '1 stage' : `${n} stages`;
}

export function WorkflowsSettings({ projectId, projectPath, item, onItem }: {
  projectId: string;
  projectPath: string;
  item?: string | null;
  onItem?: (item: string | null) => void;
}) {
  const [open, setOpen] = useOpenItem(item, onItem);
  const [answer, setAnswer] = useState<WorkflowsAnswer>();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  // A new workflow's first save gives it an address of its own, which opens
  // a fresh editor; this carries the "Saved" across to it.
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const url = `/api/settings/workflows?${new URLSearchParams({ path: projectPath })}`;

  const load = useCallback(async (signal?: AbortSignal) => {
    setError('');
    try {
      const response = await request(url, { signal });
      if (!response.ok) throw new Error(await response.text());
      const next = (await response.json()) as WorkflowsAnswer;
      if (!signal?.aborted) setAnswer(next);
    } catch (e) {
      if (!signal?.aborted) setError(e instanceof Error ? e.message : String(e));
    }
  }, [url]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /** Saves the whole list; the server refuses a stale one. */
  const persist = useCallback(async (workflows: Workflow[]) => {
    if (!answer) throw new Error('Workflows are still loading');
    const response = await request(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflows, revision: answer.revision }),
    });
    if (!response.ok) throw new Error(await response.text());
    setAnswer((await response.json()) as WorkflowsAnswer);
  }, [answer, url]);

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    return (answer?.workflows ?? []).filter((w) => !words || w.name.toLowerCase().includes(words));
  }, [answer, query]);

  let body;
  if (error && !answer) {
    body = <ReadFailed what="Couldn't load workflows" why={error} onRetry={() => void load()} />;
  } else if (!answer) {
    body = <div className="flex justify-center py-12"><Spinner /></div>;
  } else if (open && (open === NEW_WORKFLOW || answer.workflows.some((w) => w.id === open))) {
    body = (
      <WorkflowEditor
        key={open}
        id={open}
        workflows={answer.workflows}
        commands={answer.commands}
        projectId={projectId}
        projectPath={projectPath}
        onSave={persist}
        justSaved={justSaved === open}
        onSaved={(id) => { setJustSaved(id); setOpen(id); }}
        onBack={() => setOpen(null)}
      />
    );
  } else {
    body = (
      <>
        <ListHeader query={query} onQuery={setQuery} placeholder="Search workflows">
          <Button size="sm" onClick={() => setOpen(NEW_WORKFLOW)}>
            <Plus className="size-3.5" />
            <Label>New workflow</Label>
          </Button>
        </ListHeader>
        {answer.workflows.length === 0 ? (
          <ListEmpty>
            <span className="block font-medium text-t-secondary">No workflows yet</span>
            <span className="mt-1 block">Create one to get started.</span>
          </ListEmpty>
        ) : shown.length === 0 ? (
          <ListEmpty>No results</ListEmpty>
        ) : (
          <ListGroup>
            {shown.map((workflow) => (
              <ListRow
                key={workflow.id}
                testId={`workflow-row-${workflow.id}`}
                title={workflow.name}
                subtitle={`${triggerSummary(workflow)} · ${stageCount(workflow.stages.length)}`}
                tone={workflow.enabled ? 'good' : 'quiet'}
                stateLabel={workflow.enabled ? 'Enabled' : 'Disabled'}
                showState
                selected={false}
                onSelect={() => setOpen(workflow.id)}
              />
            ))}
          </ListGroup>
        )}
      </>
    );
  }

  return <div data-testid="workflows-settings" className="mx-auto w-full min-w-0 max-w-3xl">{body}</div>;
}
