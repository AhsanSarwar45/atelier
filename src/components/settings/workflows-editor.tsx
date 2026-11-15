/**
 * One workflow, edited: its trigger, the worktree each item gets, and the
 * stages an item moves through, drawn top to bottom as the flow they are.
 *
 * A stage's prompt is written in the chat's own box, so `@` offers the
 * project's files, skills, tasks and chats as it does in a chat. `/` offers
 * the library's skills too, but writes each as `@skill:id`: a prompt is read
 * as a whole, and a `/skill:` command only runs at the start of a message.
 */
'use client';

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { EditorView } from '@codemirror/view';
import { ArrowDown, ArrowLeft, ArrowRight, Bot, ChevronRight, GripVertical, Hourglass, Play, Plus, Save, SquareTerminal, Trash2, UserCheck, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { ComposerEditor, ComposerFrame } from '@/workbench/composer-editor';
import { commandFeed, mentionCompletions } from '@/workbench/composer-files';
import type { CommandInfo } from '@/workbench/protocol';
import { useDescribeReference } from '@/workbench/reference-names';

import { DetailHeader, Label, MoreMenu, StateDot } from './library-list';
import { SettingRow, SettingsGroup } from './section';
import { AgentFields } from './workflow-agent';
import { RunDialog, RunsList, useWorkflowRuns } from './workflow-runs';
import { NEW_WORKFLOW, slugOf, stageCount, triggerSummary, type Stage, type StageAuto, type StageKind, type Workflow } from './workflows-settings';

const KINDS: { value: StageKind; label: string; icon: typeof Bot; prompt: string; placeholder: string }[] = [
  { value: 'agent', label: 'Agent', icon: Bot, prompt: 'Prompt', placeholder: 'Describe the work. Type @ for skills and files' },
  { value: 'command', label: 'Command', icon: SquareTerminal, prompt: 'Command', placeholder: 'Shell command to run' },
  { value: 'wait', label: 'Wait', icon: Hourglass, prompt: 'Check', placeholder: 'Command that prints the current status' },
  { value: 'approval', label: 'Approval', icon: UserCheck, prompt: 'Message', placeholder: 'What to ask before continuing' },
];
const kindOf = (kind: StageKind) => KINDS.find((k) => k.value === kind)!;

/** What an agent stage can do without waiting for the owner. */
const AUTO: { key: keyof StageAuto; label: string }[] = [
  { key: 'plan', label: 'Approve plan' },
  { key: 'done', label: 'Approve finished work' },
  { key: 'questions', label: 'Answer questions' },
];
const NO_AUTO: StageAuto = { plan: false, done: false, questions: false };

/** A workflow as text with its keys sorted: the server's copy lists fields in
 *  its own order, and a field added in the editor comes last. */
function sameShape(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) =>
    field && typeof field === 'object' && !Array.isArray(field)
      ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => a.localeCompare(b)))
      : field);
}

const BLANK: Workflow = { id: '', name: '', enabled: false, trigger: { kind: 'manual' }, setup: {}, stages: [] };

export function WorkflowEditor({ id, workflows, commands, projectId, projectPath, justSaved, onSave, onSaved, onBack }: {
  id: string;
  /** Opened by its own first save, so it starts out saying so. */
  justSaved?: boolean;
  workflows: Workflow[];
  commands: CommandInfo[];
  projectId: string;
  projectPath: string;
  onSave: (workflows: Workflow[]) => Promise<void>;
  onSaved: (id: string) => void;
  onBack: () => void;
}) {
  const isNew = id === NEW_WORKFLOW;
  const saved = useMemo(() => workflows.find((w) => w.id === id) ?? BLANK, [workflows, id]);
  const [draft, setDraft] = useState<Workflow>(() => structuredClone(saved));
  // Stages added since the last save take their ID from their name on saving.
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(justSaved ? 'Saved' : '');
  const [running, setRunning] = useState(false);
  const { runs, reload } = useWorkflowRuns(projectPath, id);
  const [askingDelete, setAskingDelete] = useState(false);
  const dirty = isNew || sameShape(draft) !== sameShape(saved);

  const edit = (change: (w: Workflow) => Workflow) => {
    setDraft((w) => change(w));
    setNotice('');
    setError('');
  };
  const editStage = (stageId: string, change: Partial<Stage>) =>
    edit((w) => ({ ...w, stages: w.stages.map((s) => (s.id === stageId ? { ...s, ...change } : s)) }));

  // One `/` and `@` menu for every stage's box, fed the library's skills;
  // `/` writes a skill as a reference, which works anywhere in the prompt.
  const feed = useMemo(() => commandFeed(), []);
  useEffect(() => feed.set({ commands, pending: false }), [feed, commands]);
  const completions = useMemo(
    () => mentionCompletions(() => ({ cwd: projectPath, project: projectPath, projectId: null, session: null }), feed, { skillsAsReferences: true }),
    [feed, projectPath],
  );
  const describe = useDescribeReference(commands);

  // The pointer drags; the keyboard moves a picked-up stage itself, one place
  // per arrow, so a fast run of keys never outpaces a measurement.
  const sensors = useSensors(useSensor(PointerSensor));
  const [picked, setPicked] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const stageName = (stage: Stage, at: number) => stage.name.trim() || `Stage ${at + 1}`;
  const handleKey = (stageId: string, event: KeyboardEvent) => {
    const at = draft.stages.findIndex((s) => s.id === stageId);
    const stage = draft.stages[at]!;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (picked === stageId) {
        setPicked(null);
        setAnnouncement(`${stageName(stage, at)} dropped at position ${at + 1}`);
      } else {
        setPicked(stageId);
        setAnnouncement(`${stageName(stage, at)} picked up. Use the arrow keys to move it, Space to drop it`);
      }
    } else if (event.key === 'Escape' && picked === stageId) {
      setPicked(null);
      setAnnouncement(`${stageName(stage, at)} dropped at position ${at + 1}`);
    } else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && picked === stageId) {
      event.preventDefault();
      const to = event.key === 'ArrowUp' ? at - 1 : at + 1;
      if (to < 0 || to >= draft.stages.length) return;
      edit((w) => ({ ...w, stages: arrayMove(w.stages, at, to) }));
      setAnnouncement(`${stageName(stage, at)} moved to position ${to + 1}`);
    }
  };
  const reorder = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    edit((w) => {
      const from = w.stages.findIndex((s) => s.id === active.id);
      const to = w.stages.findIndex((s) => s.id === over.id);
      return { ...w, stages: arrayMove(w.stages, from, to) };
    });
  };

  const addStage = () => {
    const stageId = slugOf('stage', draft.stages.map((s) => s.id), 'stage');
    setFresh((f) => new Set(f).add(stageId));
    edit((w) => ({ ...w, stages: [...w.stages, { id: stageId, name: '', kind: 'agent', prompt: '', routes: [] }] }));
  };

  async function save() {
    if (!draft.name.trim()) return setError('Name is required');
    if (draft.stages.some((s) => !s.name.trim())) return setError('Stage name is required');
    if (draft.trigger.kind === 'schedule' && !(draft.trigger.every_minutes && draft.trigger.every_minutes > 0)) {
      return setError('Enter how often the schedule runs');
    }
    const others = workflows.filter((w) => w.id !== id);
    const workflowId = isNew ? slugOf(draft.name, others.map((w) => w.id), 'workflow') : id;
    // New stages are named by what they do; their routes follow the rename.
    const renamed = new Map<string, string>();
    const kept = draft.stages.filter((s) => !fresh.has(s.id)).map((s) => s.id);
    for (const stage of draft.stages) {
      if (!fresh.has(stage.id)) continue;
      const next = slugOf(stage.name, [...kept, ...renamed.values()], 'stage');
      renamed.set(stage.id, next);
    }
    const stages = draft.stages.map((s) => ({
      ...s,
      id: renamed.get(s.id) ?? s.id,
      routes: s.routes.filter((r) => r.outcome.trim() && r.to).map((r) => ({ outcome: r.outcome.trim(), to: renamed.get(r.to) ?? r.to })),
    }));
    const next: Workflow = { ...draft, id: workflowId, name: draft.name.trim(), stages };
    setSaving(true);
    setError('');
    try {
      await onSave(isNew ? [...workflows, next] : workflows.map((w) => (w.id === id ? next : w)));
      setDraft(next);
      setFresh(new Set());
      setNotice('Saved');
      if (workflowId !== id) onSaved(workflowId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      await onSave(workflows.filter((w) => w.id !== id));
      onBack();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  return (
    <div className="min-w-0">
      <Button variant="ghost" size="sm" className="-ml-2 mb-2" onClick={onBack} data-testid="back-to-list">
        <ArrowLeft className="size-4" />
        Workflows
      </Button>
      <DetailHeader
        title={draft.name.trim() || 'New workflow'}
        meta={
          <>
            <span className="inline-flex items-center gap-1.5"><StateDot tone={draft.enabled ? 'good' : 'quiet'} />{draft.enabled ? 'Enabled' : 'Disabled'}</span>
            <span>{triggerSummary(draft)}</span>
            <span>{stageCount(draft.stages.length)}</span>
          </>
        }
        actions={
          <>
            {notice && !dirty && <span role="status" className="text-xs text-t-muted">{notice}</span>}
            <Button size="sm" disabled={saving || (!dirty && !error)} onClick={() => void save()}>
              <Save className="size-3.5" />
              Save
            </Button>
            {!isNew && (
              <Button size="sm" variant="outline" disabled={dirty} title={dirty ? 'Save before running' : undefined} onClick={() => setRunning(true)}>
                <Play className="size-3.5" />
                Run
              </Button>
            )}
            {!isNew && (
              <MoreMenu disabled={saving}>
                <DropdownMenuItem variant="destructive" onSelect={() => setAskingDelete(true)}>
                  <Trash2 />
                  Delete
                </DropdownMenuItem>
              </MoreMenu>
            )}
          </>
        }
      />
      {draft.stages.length > 0 && <FlowStrip stages={draft.stages} />}
      {error && (
        <Panel tone="danger" role="alert" className="mt-4 text-sm text-danger">{error}</Panel>
      )}
      {!isNew && <RunsList runs={runs} workflow={saved} projectId={projectId} onChanged={() => void reload()} />}
      {!isNew && (
        <RunDialog open={running} onOpenChange={setRunning} workflow={saved} projectId={projectId} projectPath={projectPath} onStarted={() => void reload()} />
      )}

      <SettingsGroup title="General" className="mt-6">
        <SettingRow label="Name" htmlFor="workflow-name">
          <Input id="workflow-name" value={draft.name} placeholder="Ticket to merge" onChange={(e) => edit((w) => ({ ...w, name: e.target.value }))} className="w-full sm:w-72" />
        </SettingRow>
        <SettingRow label="Enabled" htmlFor="workflow-enabled">
          <Switch id="workflow-enabled" checked={draft.enabled} onCheckedChange={(enabled) => edit((w) => ({ ...w, enabled }))} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Agent">
        <AgentFields agent={draft.agent} onChange={(agent) => edit((w) => ({ ...w, agent }))} projectId={projectId} projectPath={projectPath} idPrefix="workflow" />
        <SettingRow label="Runs at once" description="More runs wait in a queue" htmlFor="workflow-max-concurrent">
          <Input
            id="workflow-max-concurrent"
            type="number"
            min={1}
            inputMode="numeric"
            value={draft.max_concurrent ?? ''}
            placeholder="1"
            onChange={(e) => edit((w) => ({ ...w, max_concurrent: e.target.value ? Number(e.target.value) : undefined }))}
            className="w-24"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Trigger">
        <SettingRow label="Trigger" htmlFor="workflow-trigger">
          <Select
            value={draft.trigger.kind}
            onValueChange={(kind) => edit((w) => ({ ...w, trigger: { ...w.trigger, kind: kind as Workflow['trigger']['kind'], every_minutes: kind === 'schedule' ? w.trigger.every_minutes ?? 10 : w.trigger.every_minutes } }))}
          >
            <SelectTrigger id="workflow-trigger" aria-label="Trigger" className="w-full sm:w-72"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">Manual</SelectItem>
              <SelectItem value="schedule">Schedule</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        {draft.trigger.kind === 'schedule' && (
          <SettingRow label="Every" htmlFor="workflow-every">
            <div className="flex items-center gap-2">
              <Input
                id="workflow-every"
                type="number"
                min={1}
                inputMode="numeric"
                value={draft.trigger.every_minutes ?? ''}
                onChange={(e) => edit((w) => ({ ...w, trigger: { ...w.trigger, every_minutes: e.target.value ? Number(e.target.value) : undefined } }))}
                className="w-24"
              />
              <span className="text-sm text-t-muted">minutes</span>
            </div>
          </SettingRow>
        )}
        <SettingRow label="Items command" description="Prints the items to work on as JSON" htmlFor="workflow-items" stack>
          <Input
            id="workflow-items"
            value={draft.trigger.items ?? ''}
            placeholder="./scripts/list-items.sh"
            onChange={(e) => edit((w) => ({ ...w, trigger: { ...w.trigger, items: e.target.value || undefined } }))}
            className="w-full font-mono text-xs"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Worktree">
        <SettingRow label="Branch" htmlFor="workflow-branch">
          <Input id="workflow-branch" value={draft.setup.branch ?? ''} placeholder="{{item.branchName}}" onChange={(e) => edit((w) => ({ ...w, setup: { ...w.setup, branch: e.target.value || undefined } }))} className="w-full font-mono text-xs sm:w-72" />
        </SettingRow>
        <SettingRow label="Base branch" htmlFor="workflow-base">
          <Input id="workflow-base" value={draft.setup.base ?? ''} placeholder="main" onChange={(e) => edit((w) => ({ ...w, setup: { ...w.setup, base: e.target.value || undefined } }))} className="w-full font-mono text-xs sm:w-72" />
        </SettingRow>
      </SettingsGroup>

      <section aria-labelledby="workflow-stages" className="mb-8">
        <h2 id="workflow-stages" className="mb-3 text-base font-semibold text-t-primary">Stages</h2>
        {draft.stages.length === 0 && (
          <p className="mb-3 text-sm text-t-muted">No stages yet</p>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}>
          <SortableContext items={draft.stages.map((s) => s.id)} strategy={verticalListSortingStrategy}>
            <ol className="space-y-0">
              {draft.stages.map((stage, at) => (
                <StageCard
                  key={stage.id}
                  stage={stage}
                  number={at + 1}
                  last={at === draft.stages.length - 1}
                  stages={draft.stages}
                  completions={completions}
                  describe={describe}
                  picked={picked === stage.id}
                  onHandleKey={(event) => handleKey(stage.id, event)}
                  onChange={(change) => editStage(stage.id, change)}
                  onRemove={() => edit((w) => ({
                    ...w,
                    stages: w.stages.filter((s) => s.id !== stage.id).map((s) => ({ ...s, routes: s.routes.filter((r) => r.to !== stage.id) })),
                  }))}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
        <p aria-live="assertive" className="sr-only">{announcement}</p>
        <Button variant="outline" className="mt-3 w-full border-dashed" onClick={addStage}>
          <Plus className="size-4" />
          Add stage
        </Button>
      </section>

      <AlertDialog open={askingDelete} onOpenChange={setAskingDelete}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete this workflow?</AlertDialogTitle>
          <AlertDialogDescription>{draft.name || 'This workflow'} will be removed from the project.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The stages at a glance, in order: what kind each is and what it is called. */
function FlowStrip({ stages }: { stages: Stage[] }) {
  return (
    <ol aria-label="Flow" className="mt-4 flex flex-wrap items-center gap-x-1 gap-y-1.5">
      {stages.map((stage, at) => {
        const Icon = kindOf(stage.kind).icon;
        return (
          <li key={stage.id} className="flex min-w-0 items-center gap-1">
            {at > 0 && <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-t-muted" />}
            <span className="inline-flex min-w-0 max-w-48 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-t-secondary">
              <Icon aria-hidden="true" className="size-3.5 shrink-0 text-t-muted" />
              <span className="truncate">{stage.name.trim() || `Stage ${at + 1}`}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function StageCard({ stage, number, last, stages, completions, describe, picked, onHandleKey, onChange, onRemove }: {
  stage: Stage;
  /** Picked up by the keyboard, and moved by its arrows. */
  picked: boolean;
  onHandleKey: (event: KeyboardEvent) => void;
  number: number;
  last: boolean;
  stages: Stage[];
  completions: ReturnType<typeof mentionCompletions>;
  describe: ReturnType<typeof useDescribeReference>;
  onChange: (change: Partial<Stage>) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: stage.id });
  const kind = kindOf(stage.kind);
  const Icon = kind.icon;
  const name = stage.name.trim() || `stage ${number}`;
  // Read once by the box when it is built, like the chat's own.
  const extra = useMemo(() => [completions, EditorView.contentAttributes.of({ 'aria-label': 'Stage prompt' })], [completions]);
  const next = stages[stages.indexOf(stage) + 1];

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid="workflow-stage"
      className={cn('relative pb-3 pl-9 sm:pl-11', isDragging && 'z-10')}
    >
      {/* The rail: the stage's number, and the line on to the next one. */}
      <span aria-hidden="true" className="absolute left-0 top-3 flex size-7 items-center justify-center rounded-full border border-border bg-background text-xs font-semibold tabular-nums text-t-secondary">
        {number}
      </span>
      {!last && <span aria-hidden="true" className="absolute bottom-0 left-[0.8125rem] top-11 w-px bg-border" />}

      <Panel inset="none" className={cn('min-w-0 p-3 transition-shadow', (isDragging || picked) && 'shadow-lg ring-1 ring-primary/30')}>
        <div className="flex min-w-0 items-center gap-2">
          <Button
            ref={setActivatorNodeRef}
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 cursor-grab touch-none text-t-muted active:cursor-grabbing"
            aria-label={`Reorder ${name}`}
            {...attributes}
            {...listeners}
            aria-pressed={picked}
            onKeyDown={onHandleKey}
          >
            <GripVertical className="size-4" />
          </Button>
          <Input
            aria-label="Stage name"
            value={stage.name}
            placeholder="Stage name"
            onChange={(e) => onChange({ name: e.target.value })}
            className="min-w-0 flex-1 font-medium"
          />
          <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-t-muted hover:text-destructive" aria-label={`Delete ${name}`} onClick={onRemove}>
            <Trash2 className="size-4" />
          </Button>
        </div>

        <ToggleGroup
          type="single"
          size="xs"
          aria-label="Stage type"
          value={stage.kind}
          onValueChange={(value) => value && onChange({ kind: value as StageKind })}
          className="mt-3 flex-wrap justify-start"
        >
          {KINDS.map((k) => (
            <ToggleGroupItem key={k.value} value={k.value} aria-label={k.label}>
              <k.icon className="size-3.5 max-sm:hidden" />
              {k.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <div className="mt-3">
          <span className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-t-muted">
            <Icon className="size-3.5" />
            {kind.prompt}
          </span>
          <ComposerFrame testId="stage-prompt" className="max-w-none px-3 py-2 shadow-none">
            <ComposerEditor
              value={stage.prompt}
              onChange={(prompt) => onChange({ prompt })}
              onKey={() => false}
              onFiles={() => {}}
              extra={extra}
              describe={describe}
              placeholder={kind.placeholder}
              testId={`stage-prompt-input-${stage.id}`}
              className={cn('w-full leading-6', stage.kind === 'command' || stage.kind === 'wait' ? 'font-mono text-xs' : undefined)}
            />
          </ComposerFrame>
        </div>

        {stage.kind === 'agent' && (
          <div className="mt-3">
            <span className="mb-1.5 block text-xs font-medium text-t-muted">Automatic</span>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {AUTO.map(({ key, label }) => {
                const auto = stage.auto ?? NO_AUTO;
                const control = `stage-${stage.id}-auto-${key}`;
                return (
                  <div key={key} className="flex items-center gap-2">
                    <Switch id={control} checked={auto[key]} onCheckedChange={(on) => onChange({ auto: { ...auto, [key]: on } })} />
                    <label htmlFor={control} className="text-xs text-t-secondary">{label}</label>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-3">
          <span className="mb-1.5 block text-xs font-medium text-t-muted">Routes</span>
          {stage.routes.length === 0 ? (
            <p className="flex items-center gap-1.5 text-xs text-t-muted">
              <ArrowDown className="size-3.5" />
              Next: {next ? next.name.trim() || `Stage ${number + 1}` : 'Done'}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {stage.routes.map((route, at) => (
                <li key={at} className="flex min-w-0 items-center gap-1.5">
                  <Input
                    aria-label="Outcome"
                    value={route.outcome}
                    placeholder="pass"
                    size="sm"
                    className="w-24 shrink-0 font-mono text-xs sm:w-32"
                    onChange={(e) => onChange({ routes: stage.routes.map((r, i) => (i === at ? { ...r, outcome: e.target.value } : r)) })}
                  />
                  <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-t-muted" />
                  <Select value={route.to || undefined} onValueChange={(to) => onChange({ routes: stage.routes.map((r, i) => (i === at ? { ...r, to } : r)) })}>
                    <SelectTrigger aria-label="Go to" className="h-7 min-w-0 flex-1 text-xs sm:max-w-56"><SelectValue placeholder="Stage" /></SelectTrigger>
                    <SelectContent>
                      {stages.map((s, i) => (
                        <SelectItem key={s.id} value={s.id}>{s.name.trim() || `Stage ${i + 1}`}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0 text-t-muted" aria-label="Remove route" onClick={() => onChange({ routes: stage.routes.filter((_, i) => i !== at) })}>
                    <X className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button type="button" variant="ghost" size="sm" className="-ml-2 mt-1 text-xs" onClick={() => onChange({ routes: [...stage.routes, { outcome: '', to: '' }] })}>
            <Plus className="size-3.5" />
            Add route
          </Button>
        </div>
      </Panel>
    </li>
  );
}
