'use client';

/**
 * The task types a project's tasks may use (docs/tasks.md, "Task types"),
 * for the install (no project) or for one project: each type with its
 * description and default items, and a switch that turns it on or off in this
 * scope. Agents add and edit types with `atelier task types`; the owner sees
 * each change as a card in the chat and can undo it there.
 */
import { useCallback, useEffect, useState } from 'react';

import { SettingsGroup } from '@/components/settings/section';
import { Badge } from '@/components/ui/badge';
import { ReadFailed } from '@/components/ui/read-failed';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { tasks as tasksApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { failure } from '@/workbench/grids/cell-detail';
import { onWorkbench } from '@/workbench/live-wire';
import type { TaskTypeInfo, TaskTypesListing } from '@/workbench/tasks/types';

/** Whether a `workbench` frame says task types changed. */
function typesChanged(data: string, projectId?: string | null): boolean {
  if (!data.includes('taskTypes.changed')) return false;
  try {
    const frame = JSON.parse(data) as { projectId?: unknown };
    return !projectId || frame.projectId === projectId;
  } catch {
    return false;
  }
}

/** The type every task can fall back on, which cannot be turned off. */
const ALWAYS_ON = 'general';

export function TaskTypesSettings({ projectId }: { projectId?: string | null }) {
  const scope = projectId ? 'project' : 'install';
  const [listing, setListing] = useState<TaskTypesListing | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const reread = useCallback(() => setRound((n) => n + 1), []);

  useEffect(() => {
    let gone = false;
    tasksApi.typesListing(projectId)
      .then((read) => { if (!gone) { setListing(read); setUnread(null); } })
      .catch((e) => { if (!gone) setUnread(failure(e)); });
    return () => { gone = true; };
  }, [projectId, round]);

  useEffect(() => onWorkbench({ frame: (data) => { if (typesChanged(data, projectId)) reread(); }, dropped: () => {} }), [projectId, reread]);

  const turn = async (name: string, on: boolean) => {
    setBusy(name);
    setRefused(null);
    try {
      await tasksApi.changeTypes(projectId, { action: on ? 'enable' : 'disable', scope, name });
      reread();
    } catch (e) {
      setRefused(`Couldn't turn ${name} ${on ? 'on' : 'off'}. ${failure(e)}`);
    } finally {
      setBusy(null);
    }
  };

  if (unread) return <ReadFailed what="The task types could not be read." why={unread} onRetry={reread} />;
  if (!listing) return <Spinner />;
  const offInstall = new Set(listing.offInstall ?? []);
  const rows: Array<{ type: TaskTypeInfo | null; name: string; on: boolean }> = [
    ...listing.types.map((type) => ({ type, name: type.name, on: true })),
    ...(listing.off ?? []).map((name) => ({ type: null, name, on: false })),
  ];
  return (
    <SettingsGroup
      title="Task types"
      description={projectId
        ? 'The types this project\'s tasks may use. A project gets the types set for all projects, and can add its own and turn any off.'
        : 'The types every project\'s tasks may use. A project can add its own and turn any off.'}
      data-testid="task-types-settings"
    >
      {refused && <div role="alert" className="px-3 py-2 text-sm text-destructive">{refused}</div>}
      {rows.map(({ type, name, on }) => {
        const locked = name === ALWAYS_ON || (scope === 'project' && offInstall.has(name));
        const items = type?.items ?? [];
        return (
          <div key={name} data-testid="task-type-row" data-name={name} data-on={on ? 'yes' : 'no'} className="flex gap-3 px-3 py-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn('font-mono text-sm', on ? 'text-t-primary' : 'text-t-tertiary')}>{name}</span>
                {type?.custom && <Badge variant="secondary" size="sm"><span>Custom</span></Badge>}
                {scope === 'project' && offInstall.has(name) && <span className="text-xs text-t-tertiary">Off for all projects</span>}
              </div>
              {type?.description && <p className="text-xs text-t-tertiary">{type.description}</p>}
              {items.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-xs text-t-secondary" aria-label={`${name} default items`}>
                  {items.map((item) => <li key={item.id}>{item.text}</li>)}
                </ul>
              )}
            </div>
            <div className="flex shrink-0 items-start gap-2 pt-0.5">
              {busy === name && <Spinner size="2xs" />}
              <Switch aria-label={name} checked={on} disabled={locked || busy !== null} onCheckedChange={(next) => void turn(name, next)} />
            </div>
          </div>
        );
      })}
    </SettingsGroup>
  );
}
