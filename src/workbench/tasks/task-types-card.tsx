'use client';

/**
 * The `taskTypes` chat widget (docs/tasks.md, "Task types"): the line an
 * agent's `atelier task types create|edit|disable|enable` prints, saying what
 * changed, with an Undo for that change. The server refuses the Undo once a
 * later change was made, and the line says why.
 */
import { useEffect, useState } from 'react';

import { ListChecks } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { tasks as tasksApi } from '@/lib/api';
import { failure } from '@/workbench/grids/cell-detail';
import type { TaskTypesWidget } from '@/workbench/tasks/types';

export function TaskTypesCard({ widget }: { widget: TaskTypesWidget }) {
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A change undone before this card was drawn (another card, a reload).
  useEffect(() => {
    let gone = false;
    tasksApi.typesListing(widget.projectId)
      .then((read) => { if (!gone && read.undone?.[widget.scope]?.includes(widget.change)) setUndone(true); })
      .catch(() => {});
    return () => { gone = true; };
  }, [widget.projectId, widget.scope, widget.change]);
  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      await tasksApi.changeTypes(widget.projectId, { action: 'undo', scope: widget.scope, id: widget.change });
      setUndone(true);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel inset="none" data-testid="task-types-card" className="my-1 max-w-4xl">
      <div className="space-y-1 px-3 py-1.5">
        <div className="flex min-h-6 min-w-0 items-start gap-2">
          <ListChecks aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-sm">Task types</span>
          <span className="min-w-0 flex-1 break-words text-sm text-muted-foreground">{widget.summary}</span>
          {undone
            ? <Badge variant="secondary" appearance="light" size="sm" className="shrink-0"><span>Undone</span></Badge>
            : <Button type="button" size="sm" variant="ghost" className="-my-1 shrink-0" loading={busy} disabled={busy} onClick={() => void undo()}>Undo</Button>}
        </div>
        {error && <div role="alert" className="text-xs text-destructive">{`Couldn't undo. ${error}`}</div>}
      </div>
    </Panel>
  );
}
