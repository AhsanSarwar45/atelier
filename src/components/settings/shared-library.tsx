'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, Check, CircleHelp, Eye, FileDown, Pencil, Pin, Plus, RotateCcw, Save, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Panel } from '@/components/ui/panel';
import { Picker } from '@/components/ui/picker';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Collapsible, CollapsibleContent, CollapsibleTriggerRow } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { request } from '@/lib/api';
import { buildCustomization, nextEntryName, suggestedItemId } from '@/lib/shared-guidance';
import { cn } from '@/lib/utils';
import { sendCommand } from '@/workbench/use-session';
import { AgentMemories } from './agent-memories';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { ActionBar, BackToList, DetailEmpty, DetailHeader, Document, Fact, Label, ListEmpty, ListGroup, ListHeader, ListRow, MasterDetail, MoreMenu, StateDot, type Action, type Tone } from './library-list';

type Condition = { op: string; path?: string; text?: string; pattern?: string; pointer?: string; key?: string; value?: unknown; name?: string; conditions?: Condition[]; condition?: Condition };
type Kind = 'instruction' | 'skill' | 'output_style';
type Category = Kind | 'command' | 'memory';
interface Item { id: string; name: string; description: string; kind: Kind; content: string; when: Condition; requires: string[]; automatic: boolean; parameters: Record<string, string>; resources: Record<string, string>; bundle: string }
interface Override { disabled?: boolean; content?: string | null; when?: Condition | null; automatic?: boolean | null; parameters?: Record<string, string> }
interface Library { general_instructions?: string; items: Item[]; overrides: Record<string, Override>; output_style?: string | null }
interface Evaluation { matched: boolean | null; reason: string; children: Evaluation[] }
interface Row { item: Item; source: string; customized: boolean; state: string; evaluation: Evaluation; missing: string[]; folder_source?: string; folder?: { source: string; directory: string; revision: string } }
interface Answer { library: Library; revision: string; source_revision: string; resolved: { revision: string; items: Row[] }; guidance: string; orphaned?: string[]; inherited: Item[] }
const names: Record<Category, string> = { instruction: 'Instructions', skill: 'Skills', command: 'Commands', output_style: 'Output styles', memory: 'Memories' };
// Memory reaches chats as resolved instructions; it is edited in its own view.
const memoryItem = (id: string) => id.startsWith('atelier-memory-');
const states: Record<string, string> = { available: 'Available', not_applicable: 'Inactive', unknown: 'Unknown', unavailable: 'Missing requirements', invalid: 'Invalid', disabled: 'Disabled', not_selected: 'Not selected', conflict: 'ID conflict' };
const tones: Record<string, Tone> = { available: 'good', not_applicable: 'quiet', unknown: 'warn', unavailable: 'warn', invalid: 'bad', disabled: 'quiet', not_selected: 'quiet', conflict: 'bad' };
const sources: Record<string, string> = { global: 'Global', project: 'This project', 'built-in': 'Built-in' };
/** Pinned entries that are not library items: the always-on instruction text. */
const GENERAL = '__general';
const conditionNames: Record<string, string> = { always: 'Always', all: 'All conditions', any: 'Any condition', not: 'Not', file_exists: 'File exists', folder_exists: 'Folder exists', file_contains: 'File contains text', file_matches: 'Filename matches pattern', file_regex: 'File matches regular expression', within: 'Inside folder of matching file', dependency: 'Package declares dependency', json_exists: 'JSON value exists', json_equals: 'JSON value equals', toml_equals: 'TOML value equals', yaml_equals: 'YAML value equals', project_beads: 'Project has a board' };
function newCondition(op: string): Condition {
  if (op === 'file_matches') return { op, pattern: '**/*.rs' };
  if (op === 'file_regex') return { op, path: '', pattern: '' };
  if (op === 'within') return { op, pattern: '**/package.json', condition: { op: 'dependency', path: 'package.json', name: '' } };
  if (op === 'all' || op === 'any') return { op, conditions: [{ op: 'file_exists', path: 'package.json' }] };
  if (op === 'not') return { op, condition: { op: 'file_exists', path: 'package.json' } };
  if (op === 'always' || op === 'project_beads') return { op };
  if (op === 'dependency') return { op, path: 'package.json', name: '' };
  if (op === 'file_contains') return { op, path: '', text: '' };
  if (op === 'json_exists') return { op, path: '', pointer: '' };
  if (op === 'toml_equals') return { op, path: 'Cargo.toml', key: '', value: '' };
  if (op.endsWith('_equals')) return { op, path: '', pointer: '', value: '' };
  return { op, path: '' };
}
function Conditions({ value, onChange, depth = 0 }: { value: Condition; onChange: (v: Condition) => void; depth?: number }) {
  const patch = (p: Partial<Condition>) => onChange({ ...value, ...p });
  return <div className="min-w-0 space-y-2" data-testid="condition-builder">
    <Picker className="min-w-0 [&>span]:truncate" label="Condition" value={value.op} onChange={op => onChange(newCondition(op))} choices={Object.entries(conditionNames).filter(([op]) => depth < 7 || !['all', 'any', 'not', 'within'].includes(op)).map(([value, label]) => ({ value, label }))} />
    {'pattern' in value && <Input aria-label="Match pattern" value={value.pattern} onChange={e => patch({ pattern: e.target.value })} />}
    {'path' in value && <Input aria-label="Condition path" placeholder="e.g. package.json" value={value.path} onChange={e => patch({ path: e.target.value })} />}
    {'text' in value && <Input aria-label="Containing text" placeholder="Text to find" value={value.text} onChange={e => patch({ text: e.target.value })} />}
    {'name' in value && <Input aria-label="Dependency name" placeholder="e.g. next" value={value.name} onChange={e => patch({ name: e.target.value })} />}
    {'pointer' in value && <Input aria-label="JSON pointer" placeholder="e.g. /scripts/test" value={value.pointer} onChange={e => patch({ pointer: e.target.value })} />}
    {'key' in value && <Input aria-label="TOML key" placeholder="e.g. package.name" value={value.key} onChange={e => patch({ key: e.target.value })} />}
    {'value' in value && <Input aria-label="Expected value" placeholder="Text, number, true or false" value={typeof value.value === 'string' ? value.value : JSON.stringify(value.value)} onChange={e => { let v: unknown = e.target.value; try { v = JSON.parse(e.target.value); } catch { /* plain text */ } patch({ value: v }); }} />}
    {value.condition && <div className="min-w-0 border-l border-border/60 pl-3"><Conditions value={value.condition} depth={depth + 1} onChange={condition => patch({ condition })} /></div>}
    {value.conditions && <div className="min-w-0 space-y-3 border-l border-border/60 pl-3">{value.conditions.map((condition, index) => <div key={index} className="min-w-0 space-y-2"><div className="flex items-center justify-between gap-2"><span className="text-xs text-t-muted">Condition {index + 1}</span><Button variant="ghost" size="icon" aria-label="Remove condition" disabled={value.conditions!.length === 1} onClick={() => patch({ conditions: value.conditions!.filter((_, i) => i !== index) })}><Trash2 className="size-4" /></Button></div><Conditions value={condition} depth={depth + 1} onChange={changed => patch({ conditions: value.conditions!.map((c, i) => i === index ? changed : c) })} /></div>)}<Button variant="ghost" size="sm" onClick={() => patch({ conditions: [...value.conditions!, { op: 'file_exists', path: '' }] })}><Plus className="size-4" />Add condition</Button></div>}
  </div>;
}
/** Why an item does or does not apply, one line per condition that decided it. */
function Evidence({ value }: { value: Evaluation }) {
  const Icon = value.matched === null ? CircleHelp : value.matched ? Check : X;
  return <div className="min-w-0 text-sm">
    <span className="flex items-start gap-1.5"><Icon aria-hidden="true" className={cn('mt-0.5 size-3.5 shrink-0', value.matched === null ? 'text-[var(--color-warning-accent)]' : value.matched ? 'text-[var(--color-success-accent)]' : 'text-t-muted')} /><span className="min-w-0 break-words">{value.reason}</span></span>
    {value.children.length > 0 && <div className="ml-1.5 mt-1 space-y-1 border-l border-border/60 pl-3">{value.children.map((child, i) => <Evidence key={i} value={child} />)}</div>}
  </div>;
}
function Entries({ label, value, onChange, defaults = {} }: { label: string; value: Record<string, string>; onChange: (v: Record<string, string>) => void; defaults?: Record<string, string> }) {
  const entries = Object.entries(value);
  const update = (index: number, key: string, text: string) => {
    if (entries.some(([existing], i) => i !== index && existing === key)) return;
    onChange(Object.fromEntries(entries.map((pair, i) => i === index ? [key, text] : pair)));
  };
  return <fieldset className="min-w-0 space-y-2"><legend className="mb-1 text-sm font-medium">{label}</legend>{entries.map(([key, text], i) => <Panel key={i} tone="frame" inset="none" className="min-w-0 space-y-1.5 p-2" data-testid="library-entry"><div className="flex min-w-0 items-center gap-1.5"><Input size="sm" className="min-w-0 flex-1 font-mono" aria-label={`${label} name`} disabled={Object.hasOwn(defaults, key)} value={key} onChange={e => update(i, e.target.value, text)} /><Button variant="ghost" size="icon" className="shrink-0" aria-label={Object.hasOwn(defaults, key) ? `Reset ${label.toLowerCase()} to global` : `Remove ${label.toLowerCase()}`} disabled={Object.hasOwn(defaults, key) && defaults[key] === text} onClick={() => Object.hasOwn(defaults, key) ? update(i, key, defaults[key]) : onChange(Object.fromEntries(entries.filter((_, n) => i !== n)))}>{Object.hasOwn(defaults, key) ? <RotateCcw className="size-4" /> : <Trash2 className="size-4" />}</Button></div><Textarea aria-label={`${label} value`} className="min-h-16 font-mono text-xs" value={text} onChange={e => update(i, key, e.target.value)} /></Panel>)}<Button variant="ghost" size="sm" onClick={() => onChange({ ...value, [nextEntryName(value)]: '' })}><Plus className="size-4" />Add {label.toLowerCase()}</Button></fieldset>;
}
function EditorSection({ label, children }: { label: string; children: ReactNode }) {
  return <section aria-label={label} data-testid="editor-section" className="min-w-0 space-y-4">{children}</section>;
}
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="block space-y-1.5 text-sm"><span className="font-medium">{label}</span>{children}{hint && <span className="block text-xs text-t-muted">{hint}</span>}</label>;
}
const matches = (query: string, ...text: string[]) => !query.trim() || text.some(t => t.toLowerCase().includes(query.trim().toLowerCase()));

export function SharedLibrary({ projectPath, projectInstructions }: { projectPath?: string; projectInstructions?: ReactNode }) {
  const [answer, setAnswer] = useState<Answer>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [category, setCategory] = useState<Category>('instruction');
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get('guidance');
    if (asked === 'output_style' || asked === 'memory') setCategory(asked);
  }, []);
  const memoryView = category === 'memory';
  const kind: Kind = category === 'command' ? 'skill' : category === 'memory' ? 'instruction' : category;
  const projectRules = !!projectPath && kind === 'instruction';
  const itemLabel = category === 'command' ? 'command' : kind === 'output_style' ? 'output style' : kind;
  const [draft, setDraft] = useState<Item>();
  const [idEdited, setIdEdited] = useState(false);
  const [editing, setEditing] = useState<Row>();
  const [folderRevision, setFolderRevision] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<{ row: Row; revision?: string; source?: string; files?: number }>();
  // Leaving a draft throws it away, so it is asked about first.
  const [discarding, setDiscarding] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [preview, setPreview] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [projects, setProjects] = useState<{ name: string; path: string; localPath?: string }[]>([]);
  const [imports, setImports] = useState<{ name: string; path: string; category: string }[]>();
  // The entry each tab has open, so coming back to a tab finds it where it was.
  const [chosen, setChosen] = useState<Partial<Record<Category, string>>>({});
  // On a phone the list and the document take turns; this is the document's turn.
  const [opened, setOpened] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [query, setQuery] = useState('');
  const url = `/api/settings/library?${new URLSearchParams(projectPath ? { path: projectPath } : preview ? { preview } : {})}`;
  const load = useCallback(async (signal?: AbortSignal) => {
    try { const response = await request(url, { signal }); if (!response.ok) throw new Error(await response.text()); const next = await response.json(); if (!signal?.aborted) { setAnswer(next); setError(''); } }
    catch (e) { if (!signal?.aborted) setError(String(e)); }
  }, [url]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  useEffect(() => { if (!projectPath) void request('/api/projects').then(r => r.json()).then(setProjects).catch(() => {}); }, [projectPath]);
  useEffect(() => {
    if (!draft) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [draft]);
  function choose(next: Category) { setCategory(next); setImports(undefined); setQuery(''); setOpened(false); setMemoryOpen(false); }
  function select(key: string) { setChosen(c => ({ ...c, [category]: key })); setImports(undefined); setOpened(true); }
  async function persist(library: Library) {
    if (!answer) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ library, revision: answer.revision, source_revision: answer.source_revision }) });
      if (!response.ok) throw new Error(await response.text());
      setAnswer(await response.json());
      if (draft) {
        const home: Category = draft.kind === 'skill' ? draft.automatic ? 'skill' : 'command' : draft.kind;
        setCategory(home); setChosen(c => ({ ...c, [home]: draft.id }));
      }
      setDraft(undefined); setEditing(undefined); setNotice('Saved. New chats will use the changes.');
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  }
  function folderUrl(id: string) {
    return `/api/settings/library/skill?${new URLSearchParams({ id, ...(projectPath ? { path: projectPath } : {}) })}`;
  }
  function setProjectSkillEnabled(id: string, enabled: boolean) {
    if (!answer || !projectPath) return;
    const library = structuredClone(answer.library);
    const override = { ...library.overrides[id] };
    if (enabled) delete override.disabled;
    else override.disabled = true;
    if (Object.keys(override).length) library.overrides[id] = override;
    else delete library.overrides[id];
    void persist(library);
  }
  async function prepareDelete(row: Row) {
    setDeleteError(''); setDeleting({ row });
    if (!row.folder_source) return;
    setSaving(true);
    try {
      const response = await request(folderUrl(row.item.id).replace('/skill?', '/skill/delete?'));
      if (!response.ok) throw new Error(await response.text());
      setDeleting({ row, ...await response.json() });
    } catch (e) { setDeleteError(String(e)); } finally { setSaving(false); }
  }
  async function deleteItem() {
    if (!deleting || !answer) return;
    const { row, revision } = deleting;
    setSaving(true); setDeleteError(''); setNotice('');
    try {
      let archive: string | undefined;
      if (row.folder_source) {
        const response = await request(folderUrl(row.item.id).replace('/skill?', '/skill/delete?'), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision }) });
        if (!response.ok) throw new Error(await response.text());
        archive = (await response.json()).archive;
        await load();
      } else {
        const library = { ...answer.library, items: answer.library.items.filter(i => i.id !== row.item.id), output_style: answer.library.output_style === row.item.id ? '' : answer.library.output_style };
        const response = await request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ library, revision: answer.revision, source_revision: answer.source_revision }) });
        if (!response.ok) throw new Error(await response.text());
        setAnswer(await response.json());
      }
      setDeleting(undefined); setOpened(false);
      setNotice(`Deleted ${row.item.name}.${archive ? ` Archived to ${archive}.` : ''}`);
    } catch (e) { setDeleteError(String(e)); } finally { setSaving(false); }
  }
  async function edit(row: Row) {
    setError(''); setNotice(''); setFolderRevision(undefined);
    if (row.folder_source && !(projectPath && row.source === 'global')) {
      setSaving(true);
      try {
        const response = await request(folderUrl(row.item.id));
        if (!response.ok) throw new Error(await response.text());
        const source: { item: Item; revision: string } = await response.json();
        setFolderRevision(source.revision); setEditing(row); setDraft(source.item);
      } catch (e) { setError(String(e)); } finally { setSaving(false); }
    } else {
      setEditing(row); setDraft(structuredClone(!projectPath ? answer?.library.items.find(i => i.id === row.item.id) ?? row.item : row.item));
    }
  }
  async function persistFolder() {
    if (!draft || !folderRevision) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await request(folderUrl(draft.id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: draft, revision: folderRevision }) });
      if (!response.ok) throw new Error(await response.text());
      const home: Category = draft.automatic ? 'skill' : 'command';
      setCategory(home); setChosen(c => ({ ...c, [home]: draft.id })); setDraft(undefined); setEditing(undefined); setFolderRevision(undefined);
      await load(); setNotice('Saved. New chats will use the changes.');
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  }
  function create(content = '', name = '') {
    setEditing(undefined); setImports(undefined); setIdEdited(false);
    setDraft({ id: suggestedItemId(name, answer?.resolved.items.map(r => r.item.id) ?? []), name, content, description: '', kind, when: { op: 'always' }, requires: [], automatic: category !== 'command', parameters: {}, resources: {}, bundle: '' });
  }
  async function importNative() {
    try {
      const result = await sendCommand<{ files: { name: string; path: string; category: string }[] }>({ type: 'agent-files.list', ...(projectPath ? { projectPath } : {}) });
      setImports(result.files.filter(f => ['instructions', 'skills', 'commands', 'output-styles', 'rules'].includes(f.category))); setOpened(true);
    } catch (e) { setError(String(e)); }
  }
  async function copyNative(file: { name: string; path: string; category: string }) {
    try {
      const result = await sendCommand<{ content: string; truncated?: boolean }>({ type: 'agent-files.read', path: file.path, ...(projectPath ? { projectPath } : {}) });
      if (result.truncated) throw new Error('This file is too large to import completely.');
      create(result.content, file.name);
      setNotice('Imported.');
    } catch (e) { setError(String(e)); }
  }
  const inherited = editing?.source === 'global' && !!projectPath;
  const folderEditing = !!editing?.folder_source && !inherited;
  const source = inherited ? answer?.inherited.find(item => item.id === editing?.item.id) : undefined;
  const patch = (change: Partial<Item>) => setDraft(d => d ? { ...d, ...change } : d);
  const all = useMemo(() => answer?.resolved.items.filter(r => r.item.id !== 'atelier-general-instructions' && !memoryItem(r.item.id)) ?? [], [answer]);
  const inCategory = (r: Row, c: Category) => c === 'command' ? r.item.kind === 'skill' && !r.item.automatic : c === 'skill' ? r.item.kind === 'skill' && r.item.automatic : r.item.kind === c;
  const counts = Object.fromEntries((Object.keys(names) as Category[]).map(c => [c, all.filter(r => inCategory(r, c)).length])) as Record<Category, number>;
  const rows = all.filter(r => inCategory(r, category));

  if (draft && answer) return <div className="mx-auto max-w-6xl" data-testid="shared-library">
    {error && <Panel role="alert" tone="danger" className="mb-4 space-y-2 text-sm"><p>{error}</p><Button variant="outline" size="sm" onClick={() => { setDraft(undefined); setEditing(undefined); void load(); }}>Reload</Button></Panel>}
    {notice && <p role="status" className="mb-4 text-sm text-t-secondary">{notice}</p>}
    <section className="min-w-0" aria-label="Library item editor" data-testid="library-editor">
      <header className="sticky -top-4 z-10 -mx-4 mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-border/40 bg-surface-base/95 px-4 py-3 backdrop-blur sm:-top-6 sm:-mx-6 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" aria-label={`Back to ${names[category].toLowerCase()}`} disabled={saving} onClick={() => setDiscarding(true)}><ArrowLeft className="size-4" /></Button>
          <h2 className="truncate text-base font-semibold">{inherited ? 'Customize' : editing ? 'Edit' : 'New'} {itemLabel}</h2>
          <Badge variant="outline" size="sm">{projectPath ? 'This project only' : 'All projects'}</Badge>
        </div>
        <div className="flex gap-2"><Button variant="ghost" disabled={saving} onClick={() => { setDraft(undefined); setEditing(undefined); }}><X className="size-4 sm:hidden" /><Label>Cancel</Label></Button><Button disabled={saving || !draft.id || !draft.name.trim()} onClick={() => {
          if (folderEditing) { void persistFolder(); return; }
          if (!editing && answer.library.items.some(item => item.id === draft.id)) { setError('This ID is already in use.'); return; }
          const library = structuredClone(answer.library);
          if (inherited) {
            if (!source) { setError('The global item has changed. Reload and try again.'); return; }
            const prior = library.overrides[draft.id] ?? {};
            library.overrides[draft.id] = buildCustomization(draft, source, prior.disabled);
          } else { library.items = [...library.items.filter(i => i.id !== draft.id), draft]; }
          void persist(library);
        }}><Save className="size-4" /><Label>{saving ? 'Saving…' : 'Save'}</Label></Button></div>
      </header>
      {inherited && <p className="mb-6 text-sm text-t-secondary">Overrides the global version for this project only.</p>}
      <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <EditorSection label="Details">
          <Field label={`Name${inherited ? ' (inherited)' : ''}`}><Input aria-label="Item name" disabled={inherited} value={draft.name} placeholder="e.g. Release check" onChange={e => patch({ name: e.target.value, ...(!editing && !idEdited ? { id: suggestedItemId(e.target.value, answer.resolved.items.map(r => r.item.id)) } : {}) })} /></Field>
          <Field label={`Description${inherited ? ' (inherited)' : ''}`}><Textarea aria-label="Item description" rows={2} className="min-h-0 resize-y" disabled={inherited} value={draft.description} placeholder={draft.kind === 'skill' && draft.automatic ? 'When to use this skill' : 'Optional'} onChange={e => patch({ description: e.target.value })} /></Field>
          <Field label="Content" hint={inherited ? 'Overrides the global content for this project.' : undefined}><Textarea aria-label="Item content" className="min-h-[max(20rem,calc(100dvh-26rem))] font-mono text-sm leading-relaxed" value={draft.content} onChange={e => patch({ content: e.target.value })} /></Field>
        </EditorSection>
        <div className="min-w-0 space-y-6 xl:border-l xl:border-border/40 xl:pl-6">
          <EditorSection label="Settings">
            {draft.kind === 'skill' && <div className="space-y-1.5"><label className="flex items-start gap-2.5 text-sm"><Checkbox className="mt-0.5 shrink-0" checked={draft.automatic} onCheckedChange={checked => patch({ automatic: checked === true })} /><span className="font-medium">Use automatically</span></label><p className="pl-[1.625rem] text-xs text-t-muted">{draft.automatic ? 'Or run it manually with ' : 'Run it manually with '}<code className="break-all">/skill:{draft.id}</code></p></div>}
            <fieldset className="min-w-0 space-y-1.5"><legend className="mb-1.5 text-sm font-medium">Condition</legend><Conditions value={draft.when} onChange={when => patch({ when })} /></fieldset>
          </EditorSection>
          <Collapsible data-testid="editor-support" className="min-w-0 border-t border-border/40 pt-4"><CollapsibleTriggerRow className="w-full">Parameters and files<span className="ml-auto text-xs font-normal text-t-muted">{Object.keys(draft.parameters).length + (folderEditing ? 0 : Object.keys(draft.resources).length) || 'None'}</span></CollapsibleTriggerRow><CollapsibleContent className="min-w-0 space-y-5 pt-4"><p className="text-xs text-t-muted">Use {'{{name}}'} in the content to insert a parameter.</p><Entries label="Parameters" value={draft.parameters} defaults={source?.parameters} onChange={parameters => patch({ parameters })} />{draft.kind === 'skill' && (folderEditing ? <div className="space-y-1"><h4 className="text-sm font-medium">Scripts and assets</h4><p className="text-xs text-t-muted">Edit these in the skill folder:</p><p className="break-all font-mono text-xs">{editing?.folder_source}</p></div> : !inherited ? <div className="space-y-1.5"><Entries label="Resources" value={draft.resources} onChange={resources => patch({ resources })} /></div> : <div className="space-y-1"><h4 className="text-sm font-medium">Resources (inherited)</h4><p className="text-xs text-t-muted">Edit these in the global library.</p>{Object.keys(draft.resources).map(name => <p key={name} className="break-all font-mono text-xs">{name}</p>)}</div>)}</CollapsibleContent></Collapsible>
          <Collapsible data-testid="editor-advanced" className="min-w-0 border-t border-border/40 pt-4"><CollapsibleTriggerRow className="w-full">Advanced</CollapsibleTriggerRow><CollapsibleContent className="space-y-4 pt-4"><Field label="ID" hint="Can’t be changed after saving."><Input aria-label="Item ID" className="font-mono" disabled={!!editing} value={draft.id} onChange={e => { setIdEdited(true); patch({ id: e.target.value }); }} /></Field><Field label={`Required tools${inherited ? ' (inherited)' : ''}`} hint="Comma-separated"><Input aria-label="Required executables" disabled={inherited} placeholder="e.g. git, npm" value={draft.requires.join(', ')} onChange={e => patch({ requires: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} /></Field>{!folderEditing && <Field label={`Bundle${inherited ? ' (inherited)' : ''}`}><Input aria-label="Bundle" disabled={inherited} placeholder="Optional" value={draft.bundle} onChange={e => patch({ bundle: e.target.value })} /></Field>}</CollapsibleContent></Collapsible>
        </div>
      </div>
    </section>
    <AlertDialog open={discarding} onOpenChange={setDiscarding}>
      <AlertDialogContent>
        <AlertDialogTitle>Discard changes?</AlertDialogTitle>
        <AlertDialogDescription>Your changes will be lost.</AlertDialogDescription>
        <AlertDialogFooter><AlertDialogCancel>Keep editing</AlertDialogCancel><AlertDialogAction onClick={() => { setDraft(undefined); setEditing(undefined); }}>Discard</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;

  const general = !projectPath && answer ? <GeneralInstructions saved={answer.library.general_instructions ?? ''} saving={saving} onSave={text => persist({ ...answer.library, general_instructions: text })} /> : projectInstructions;
  const owned = (row: Row) => row.source !== 'built-in' && !(row.source === 'project' && !projectPath);
  const actions = (row: Row) => {
    if (!answer || !owned(row)) return undefined;
    const primary: Action | undefined = !row.folder_source || row.state !== 'invalid' ? { label: projectPath && row.source === 'global' ? 'Customize' : 'Edit', icon: <Pencil className="size-3.5" />, run: () => void edit(row) } : undefined;
    const rest: Action[] = [];
    if (projectPath && row.source === 'global') {
      if (row.item.kind !== 'skill') rest.push({ label: row.state === 'disabled' ? 'Enable' : 'Disable', run: () => void persist({ ...answer.library, overrides: { ...answer.library.overrides, [row.item.id]: { ...answer.library.overrides[row.item.id], disabled: row.state !== 'disabled' } } }) });
      if (row.customized) rest.push({ label: 'Reset', icon: <RotateCcw className="size-3.5" />, run: () => { const library = structuredClone(answer.library); delete library.overrides[row.item.id]; void persist(library); } });
    } else rest.push({ label: 'Delete', icon: <Trash2 className="size-3.5" />, destructive: true, run: () => void prepareDelete(row) });
    return <ActionBar primary={primary} rest={rest} disabled={saving} />;
  };
  // With no project to check against, a condition has nothing to be true of yet:
  // that is the normal case on the global screen, not a warning.
  const unchecked = (row: Row) => !projectPath && !preview && row.state === 'unknown';
  const stateOf = (row: Row) => unchecked(row) ? 'Conditional' : projectRules && row.state === 'available' ? 'Active' : kind === 'output_style' && row.state === 'available' ? 'Active' : states[row.state] ?? row.state;
  const toneOf = (row: Row): Tone => unchecked(row) ? 'quiet' : tones[row.state] ?? 'quiet';
  const rowDetail = (row: Row) => <article className="min-w-0" data-testid="library-detail" data-item={row.item.id}>
    <DetailHeader title={row.item.name} actions={projectRules ? undefined : actions(row)} meta={<>
      <span className="inline-flex items-center gap-1.5"><StateDot tone={toneOf(row)} />{stateOf(row)}</span>
      <span>{sources[row.source] ?? row.source}</span>
      {row.customized && <span>Customized</span>}
      {row.item.kind === 'skill' && <code className="text-t-secondary">/skill:{row.item.id}</code>}
      {row.item.bundle && <span>{row.item.bundle}</span>}
    </>} />
    <div className="space-y-5 pt-4">
      {row.item.description && <p className="text-sm text-t-secondary">{row.item.description}</p>}
      <dl className="space-y-3">
        <Fact label="Conditions"><Evidence value={row.evaluation} /></Fact>
        {row.missing.length > 0 && <Fact label="Missing"><span className="font-mono text-xs">{row.missing.join(', ')}</span></Fact>}
        {row.folder_source && <Fact label="Folder"><span className="block break-all font-mono text-xs text-t-secondary">{row.folder_source}</span></Fact>}
        {projectRules && row.customized && <Fact label="Override"><span className="text-xs text-t-muted">This project has a saved override.</span></Fact>}
      </dl>
      <Document label={`${row.item.name} content`}>{row.item.content}</Document>
      {projectRules && row.source === 'global' && <p className="text-sm"><Button mode="link" underlined="solid" size="inherit" asChild><a href="/settings?section=library">Edit global instructions</a></Button></p>}
    </div>
  </article>;

  // The list: what the tab holds, grouped by where each entry comes from.
  const visible = rows.filter(r => matches(query, r.item.name, r.item.id, r.item.description));
  const bySource = (list: Row[]) => (['project', 'global', 'built-in'] as const).map(s => ({ key: s, title: s === 'global' ? (projectPath ? 'Global' : 'Custom') : sources[s], rows: list.filter(r => r.source === s) })).filter(g => g.rows.length);
  const projectGroups = projectRules ? (() => {
    const globals = visible.filter(r => r.source === 'global');
    const applied = globals.filter(r => r.state === 'available'), inactive = globals.filter(r => r.state !== 'available');
    const older = visible.filter(r => r.source === 'project'), builtins = visible.filter(r => r.source === 'built-in');
    return [{ key: 'applied', title: 'Active', rows: applied }, { key: 'inactive', title: `Inactive · ${inactive.length}`, rows: inactive }, { key: 'older', title: `Legacy project rules · ${older.length}`, rows: older }, { key: 'built-in', title: 'Built-in', rows: builtins }].filter(g => g.rows.length);
  })() : [];
  const groups = projectRules ? projectGroups : bySource(visible);
  const pinned = kind === 'instruction' && !!general && matches(query, projectPath ? 'Project instructions' : 'Global instructions');
  const keys = [...(pinned ? [GENERAL] : []), ...groups.flatMap(g => g.rows.map(r => r.item.id))];
  const current = keys.includes(chosen[category] ?? '') ? chosen[category]! : keys[0];
  const currentRow = rows.find(r => r.item.id === current);
  const override = (id: string) => answer?.library.overrides[id];
  const list = <>
    <ListHeader query={query} onQuery={setQuery} placeholder={`Search ${names[category].toLowerCase()}`}>
      {!projectRules && <>
        <Button variant="ghost" size="icon" className="max-sm:hidden" aria-label="Import" title="Import CLAUDE.md, AGENTS.md or skill files" onClick={() => void importNative()}><FileDown className="size-4" /></Button>
        <Button size="sm" aria-label={`Add ${itemLabel}`} onClick={() => create()}><Plus className="size-3.5" /><Label>New</Label></Button>
      </>}
    </ListHeader>
    {kind === 'output_style' && answer && <Panel tone="frame" inset="none" className="mb-3 space-y-1.5 p-2.5"><span className="text-xs font-medium text-t-muted">Active style</span><Picker label="Selected output style" disabled={saving} value={answer.library.output_style ?? (projectPath ? '__inherit' : '')} onChange={value => void persist({ ...answer.library, output_style: value === '__inherit' ? null : value })} choices={[...(projectPath ? [{ value: '__inherit', label: 'Use global setting' }] : []), { value: '', label: 'None' }, ...answer.resolved.items.filter(r => r.item.kind === 'output_style' && (projectPath || r.source !== 'project')).map(r => ({ value: r.item.id, label: r.item.name }))]} /></Panel>}
        {pinned && <ListGroup><ListRow testId="library-item-general" title={projectPath ? 'Project instructions' : 'Global instructions'} subtitle={projectPath ? 'This project only' : 'Shared by all projects'} tone="good" stateLabel="Always active" icon={<Pin aria-hidden="true" className="size-3 shrink-0 text-t-muted" />} selected={current === GENERAL} onSelect={() => select(GENERAL)} /></ListGroup>}
    <div data-testid={projectRules ? 'project-instruction-summary' : undefined}>
      {groups.map(g => <ListGroup key={g.key} title={groups.length > 1 || pinned || projectRules ? g.title : undefined}>{g.rows.map(row => <ListRow key={row.item.id} testId={`library-item-${row.item.id}`} title={row.item.name} subtitle={row.item.description || (row.item.kind === 'skill' ? `/skill:${row.item.id}` : undefined)} tone={toneOf(row)} stateLabel={stateOf(row) + (row.customized ? ' · Customized' : '')} showState={row.state !== 'available' || kind === 'output_style'} selected={current === row.item.id} onSelect={() => select(row.item.id)}
        trailing={projectPath && row.item.kind === 'skill' && row.source !== 'built-in' ? <Switch checked={!override(row.item.id)?.disabled} aria-label={`Enable ${row.item.name} for this project`} disabled={saving} onCheckedChange={on => setProjectSkillEnabled(row.item.id, on)} /> : undefined} />)}</ListGroup>)}
    </div>
    {!pinned && !groups.length && <ListEmpty>{query ? 'No results' : `No ${names[category].toLowerCase()} yet.`}</ListEmpty>}
  </>;
  const importer = imports && <section className="min-w-0" aria-label="Import">
    <DetailHeader title="Import" meta={<span>Creates a copy. The original file stays where it is.</span>} actions={<Button variant="ghost" size="sm" onClick={() => setImports(undefined)}>Cancel</Button>} />
    <div className="pt-3">{imports.length === 0 ? <p className="py-6 text-center text-sm text-t-muted">No files found</p> : <ul className="space-y-px">{imports.map(f => <li key={f.path}><Button variant="ghost" className="h-auto w-full justify-start whitespace-normal py-2 text-left" onClick={() => void copyNative(f)}>{f.name} · {f.category}</Button></li>)}</ul>}</div>
  </section>;
  const detail = <>
    <BackToList onBack={() => { setOpened(false); setImports(undefined); }} label={names[category]} />
    {importer}
    {/* Kept mounted in every category, so an unsaved draft survives a switch. */}
    {general && <div hidden={kind !== 'instruction' || !!imports || current !== GENERAL} className="min-w-0">{general}</div>}
    {!imports && currentRow && rowDetail(currentRow)}
    {!imports && !currentRow && current !== GENERAL && <DetailEmpty>{rows.length ? 'Select an item' : `No ${names[category].toLowerCase()} yet`}</DetailEmpty>}
  </>;

  const focused = memoryView ? memoryOpen : opened;
  return <div className="mx-auto flex max-w-6xl flex-col gap-5 max-sm:gap-3" data-testid="shared-library">
    {error && <Panel role="alert" tone="danger" className="space-y-2 text-sm"><p>{error}</p><Button variant="outline" size="sm" onClick={() => { setDraft(undefined); setEditing(undefined); void load(); }}>Reload</Button></Panel>}
    {notice && <p role="status" className="text-sm text-t-secondary">{notice}</p>}
    {!answer && !error && <p className="text-sm text-t-muted">Loading…</p>}
    {answer && <>
      {answer.orphaned?.map(id => <Panel key={id} tone="attention" className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>Global item deleted: <code>{id}</code></span>{!projectRules && <Button variant="ghost" size="sm" disabled={saving} onClick={() => { const library = structuredClone(answer.library); delete library.overrides[id]; void persist(library); }}>Remove override</Button>}</Panel>)}
      {/* A phone has no room for five tabs or the page heading the top bar
          already shows, so there it is one picker naming the open list. While
          an item is open the item gets the whole screen. */}
      <div className={cn('flex items-center gap-2 sm:hidden', focused && 'hidden')}>
        <Select value={category} onValueChange={id => choose(id as Category)}>
          <SelectTrigger className="min-w-0 flex-1" aria-label="Category"><SelectValue /></SelectTrigger>
          <SelectContent>{(Object.keys(names) as Category[]).map(id => <SelectItem key={id} value={id}>{names[id]}</SelectItem>)}</SelectContent>
        </Select>
        <MoreMenu><DropdownMenuItem onSelect={() => setPreviewing(true)}><Eye className="size-4" />View prompt</DropdownMenuItem>{!memoryView && !projectRules && <DropdownMenuItem onSelect={() => void importNative()}><FileDown className="size-4" />Import</DropdownMenuItem>}</MoreMenu>
      </div>
      {/* The screen heads the page, so the tabs and the page's tools share one row. */}
      <div className={cn('flex flex-wrap items-center justify-between gap-2 border-b border-border/60 pb-2 max-sm:hidden', focused && 'max-lg:hidden')}>
        <ToggleGroup type="single" size="sm" className="flex-wrap justify-start gap-1" aria-label="Library categories" value={category} onValueChange={id => { if (id) choose(id as Category); }}>{(Object.keys(names) as Category[]).map(id => <ToggleGroupItem key={id} value={id} aria-label={names[id]} className="gap-1.5">{names[id]}{id !== 'memory' && counts[id] + (id === 'instruction' && general ? 1 : 0) > 0 && <span aria-hidden="true" className="text-[0.6875rem] tabular-nums text-t-muted">{counts[id] + (id === 'instruction' && general ? 1 : 0)}</span>}</ToggleGroupItem>)}</ToggleGroup>
        <div className="flex min-h-9 flex-wrap items-center gap-2">
        {!projectPath && !memoryView && <Picker className="w-56 [&>span]:truncate" label="Preview for project" value={preview} onChange={setPreview} choices={[{ value: '', label: 'Preview for project…' }, ...projects.filter(p => !(p.localPath || p.path).startsWith('dolt://')).map(p => ({ value: p.localPath || p.path, label: p.name }))]} />}
        <Button variant="outline" size="sm" onClick={() => setPreviewing(true)}><Eye className="size-4" />View prompt</Button>
        </div>
      </div>
      {memoryView ? <AgentMemories projectPath={projectPath} onChange={() => void load()} onOpenChange={setMemoryOpen} /> : <MasterDetail label={names[category]} open={opened} list={list} detail={detail} />}
    </>}
    <Dialog open={previewing} onOpenChange={setPreviewing}>
      <DialogContent className="sm:max-w-3xl" data-testid="library-preview">
        <DialogTitle>Prompt preview</DialogTitle>
        <DialogDescription>What a new chat starts with. Skills load when used.</DialogDescription>
        {answer && <><p className="break-all text-xs text-t-muted">Revision {answer.resolved.revision}</p><Panel asChild inset="none" className="max-h-[60vh] overflow-auto p-4"><pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{answer.guidance}</pre></Panel></>}
      </DialogContent>
    </Dialog>
    <AlertDialog open={!!deleting} onOpenChange={open => { if (!open && !saving) setDeleting(undefined); }}>
      <AlertDialogContent>
        <AlertDialogTitle>Delete {deleting?.row.item.name}?</AlertDialogTitle>
        <AlertDialogDescription>
          {projectPath ? 'It will be removed from this project.' : 'It will be removed from all projects.'}
          {deleting?.row.folder_source ? <><span className="mt-2 block">The skill folder will be moved to the archive.</span><span className="mt-2 block break-all font-mono text-xs">{deleting.source ?? deleting.row.folder_source}</span>{deleting.files !== undefined && <span className="mt-1 block">{deleting.files} files</span>}</> : <span className="mt-2 block">This can’t be undone.</span>}
        </AlertDialogDescription>
        {deleteError && <div role="alert" className="text-sm text-danger"><p>{deleteError}</p><Button variant="ghost" disabled={saving} onClick={() => { setDeleting(undefined); void load(); }}>Reload settings</Button></div>}
        <AlertDialogFooter><AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel><Button variant="destructive" disabled={saving || !!deleteError || (!!deleting?.row.folder_source && !deleting.revision)} onClick={() => void deleteItem()}>{saving ? 'Deleting…' : `Delete ${deleting?.row.item.kind === 'skill' ? deleting.row.item.automatic ? 'skill' : 'command' : deleting?.row.item.kind === 'output_style' ? 'output style' : 'instruction'}`}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}

function GeneralInstructions({ saved, saving, onSave }: { saved: string; saving: boolean; onSave: (text: string) => Promise<void> }) {
  const [text, setText] = useState(saved);
  useEffect(() => setText(saved), [saved]);
  useEffect(() => {
    if (text === saved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [text, saved]);
  return <section aria-label="Global instructions" className="min-w-0">
    <DetailHeader title="Global instructions" meta={<><span className="inline-flex items-center gap-1.5"><StateDot tone="good" />Always active</span><span>Shared by all projects</span></>} actions={<Button size="sm" disabled={saving || text === saved} onClick={() => void onSave(text)}><Save className="size-3.5" /><span aria-hidden="true" className="max-sm:hidden">Save</span><span className="sr-only">Save global instructions</span></Button>} />
    <label className="mt-4 block"><span className="sr-only">Global instructions</span><Textarea className="min-h-[max(24rem,calc(100dvh-22rem))] font-mono text-sm leading-relaxed" value={text} onChange={event => setText(event.target.value)} /></label>
  </section>;
}
