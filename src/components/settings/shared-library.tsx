'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, BookOpen, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Panel } from '@/components/ui/panel';
import { Picker } from '@/components/ui/picker';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { request } from '@/lib/api';
import { buildCustomization, nextEntryName, suggestedItemId } from '@/lib/shared-guidance';
import { sendCommand } from '@/workbench/use-session';

type Condition = { op: string; path?: string; text?: string; pattern?: string; pointer?: string; key?: string; value?: unknown; name?: string; conditions?: Condition[]; condition?: Condition };
type Kind = 'instruction' | 'skill' | 'output_style';
type Category = Kind | 'command';
interface Item { id: string; name: string; description: string; kind: Kind; content: string; when: Condition; requires: string[]; automatic: boolean; parameters: Record<string, string>; resources: Record<string, string>; bundle: string }
interface Override { disabled?: boolean; content?: string | null; when?: Condition | null; automatic?: boolean | null; parameters?: Record<string, string> }
interface Library { general_instructions?: string; items: Item[]; overrides: Record<string, Override>; output_style?: string | null }
interface Evaluation { matched: boolean | null; reason: string; children: Evaluation[] }
interface Row { item: Item; source: string; customized: boolean; state: string; evaluation: Evaluation; missing: string[]; folder_source?: string; folder?: { source: string; directory: string; revision: string } }
interface Answer { library: Library; revision: string; source_revision: string; resolved: { revision: string; items: Row[] }; guidance: string; orphaned?: string[]; inherited: Item[] }
const names: Record<Category, string> = { instruction: 'Instructions', skill: 'Skills', command: 'Commands', output_style: 'Output styles' };
const descriptions: Record<Kind, string> = { instruction: 'Standing guidance included in every applicable conversation.', skill: 'Reusable procedures agents can discover or you can invoke by name.', output_style: 'Choose how answers are written. Only one shared style applies at a time.' };
function EditorSection({ step, title, description, children }: { step: string; title: string; description: string; children: ReactNode }) {
  return <Panel inset="none" asChild><section aria-label={title} data-testid="editor-section"><header className="flex gap-3 border-b border-border/40 px-4 py-4"><span className="text-sm font-medium text-t-muted" aria-hidden="true">{step}</span><div><h3 className="font-semibold">{title}</h3><p className="mt-1 text-sm text-t-secondary">{description}</p></div></header><div className="min-w-0 space-y-5 p-4">{children}</div></section></Panel>;
}
const states: Record<string, string> = { available: 'Available', not_applicable: 'Does not apply', unknown: 'Needs evaluation', unavailable: 'Missing requirements', invalid: 'Invalid folder', disabled: 'Disabled here', not_selected: 'Not selected', conflict: 'ID conflict' };
const conditionNames: Record<string, string> = { always: 'Always', all: 'All conditions', any: 'Any condition', not: 'Not', file_exists: 'File exists', folder_exists: 'Folder exists', file_contains: 'File contains text', file_matches: 'Filename matches pattern', file_regex: 'File matches regular expression', within: 'In the folder of any matching file', dependency: 'Package declares dependency', json_exists: 'JSON value exists', json_equals: 'JSON value equals', toml_equals: 'TOML value equals', yaml_equals: 'YAML value equals', project_beads: 'Project has a board' };
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
  return <div className="min-w-0 space-y-3" data-testid="condition-builder">
    <Picker className="min-w-0 [&>span]:truncate" label="Condition" value={value.op} onChange={op => onChange(newCondition(op))} choices={Object.entries(conditionNames).filter(([op]) => depth < 7 || !['all', 'any', 'not', 'within'].includes(op)).map(([value, label]) => ({ value, label }))} />
    {'pattern' in value && <Input aria-label="Match pattern" value={value.pattern} onChange={e => patch({ pattern: e.target.value })} />}
    {'path' in value && <Input aria-label="Condition path" placeholder="Relative to this checkout, e.g. package.json" value={value.path} onChange={e => patch({ path: e.target.value })} />}
    {'text' in value && <Input aria-label="Containing text" value={value.text} onChange={e => patch({ text: e.target.value })} />}
    {'name' in value && <Input aria-label="Dependency name" placeholder="e.g. next" value={value.name} onChange={e => patch({ name: e.target.value })} />}
    {'pointer' in value && <Input aria-label="JSON pointer" placeholder="e.g. /scripts/test" value={value.pointer} onChange={e => patch({ pointer: e.target.value })} />}
    {'key' in value && <Input aria-label="TOML key" placeholder="e.g. package.name" value={value.key} onChange={e => patch({ key: e.target.value })} />}
    {'value' in value && <Input aria-label="Expected value" placeholder="Text, number, true or false" value={typeof value.value === 'string' ? value.value : JSON.stringify(value.value)} onChange={e => { let v: unknown = e.target.value; try { v = JSON.parse(e.target.value); } catch { /* plain text */ } patch({ value: v }); }} />}
    {value.condition && <div className="min-w-0 border-l border-border/60 pl-3"><Conditions value={value.condition} depth={depth + 1} onChange={condition => patch({ condition })} /></div>}
    {value.conditions && <div className="min-w-0 space-y-4 border-l border-border/60 pl-3">{value.conditions.map((condition, index) => <div key={index} className="min-w-0 space-y-2"><div className="flex items-center justify-between gap-2"><span className="text-xs text-t-muted">Condition {index + 1}</span><Button variant="ghost" size="icon" aria-label="Remove condition" disabled={value.conditions!.length === 1} onClick={() => patch({ conditions: value.conditions!.filter((_, i) => i !== index) })}><Trash2 className="size-4" /></Button></div><Conditions value={condition} depth={depth + 1} onChange={changed => patch({ conditions: value.conditions!.map((c, i) => i === index ? changed : c) })} /></div>)}<Button variant="ghost" size="sm" onClick={() => patch({ conditions: [...value.conditions!, { op: 'file_exists', path: '' }] })}><Plus className="mr-1 size-4" />Add condition</Button></div>}
  </div>;
}
function Evidence({ value }: { value: Evaluation }) {
  return <div className="text-xs text-t-secondary"><span>{value.matched === null ? '?' : value.matched ? '✓' : '—'} {value.reason}</span>{value.children.map((child, i) => <div key={i} className="ml-3 mt-1 border-l border-border pl-2"><Evidence value={child} /></div>)}</div>;
}
function Entries({ label, value, onChange, defaults = {} }: { label: string; value: Record<string, string>; onChange: (v: Record<string, string>) => void; defaults?: Record<string, string> }) {
  const entries = Object.entries(value);
  const update = (index: number, key: string, text: string) => {
    if (entries.some(([existing], i) => i !== index && existing === key)) return;
    onChange(Object.fromEntries(entries.map((pair, i) => i === index ? [key, text] : pair)));
  };
  return <fieldset className="min-w-0 space-y-3"><legend className="mb-2 text-sm font-medium">{label}</legend><div className="space-y-4">{entries.map(([key, text], i) => <div key={i} className="min-w-0 space-y-2 border-b border-border/40 pb-4" data-testid="library-entry"><div className="flex min-w-0 items-center gap-2"><Input className="min-w-0 flex-1" aria-label={`${label} name`} disabled={Object.hasOwn(defaults, key)} value={key} onChange={e => update(i, e.target.value, text)} /><Button variant="ghost" size="icon" className="shrink-0" aria-label={Object.hasOwn(defaults, key) ? `Reset ${label.toLowerCase()} to global` : `Remove ${label.toLowerCase()}`} disabled={Object.hasOwn(defaults, key) && defaults[key] === text} onClick={() => Object.hasOwn(defaults, key) ? update(i, key, defaults[key]) : onChange(Object.fromEntries(entries.filter((_, n) => i !== n)))}>{Object.hasOwn(defaults, key) ? <RotateCcw className="size-4" /> : <Trash2 className="size-4" />}</Button></div><Textarea aria-label={`${label} value`} value={text} onChange={e => update(i, key, e.target.value)} /></div>)}</div><Button variant="ghost" size="sm" onClick={() => onChange({ ...value, [nextEntryName(value)]: '' })}><Plus className="mr-1 size-4" />Add {label.toLowerCase()}</Button></fieldset>;
}

export function SharedLibrary({ projectPath, projectInstructions }: { projectPath?: string; projectInstructions?: ReactNode }) {
  const [answer, setAnswer] = useState<Answer>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [category, setCategory] = useState<Category>('instruction');
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('guidance') === 'output_style') setCategory('output_style');
  }, []);
  const kind: Kind = category === 'command' ? 'skill' : category;
  const projectRules = !!projectPath && kind === 'instruction';
  const itemLabel = category === 'command' ? 'command' : kind === 'output_style' ? 'output style' : kind;
  const [draft, setDraft] = useState<Item>();
  const [idEdited, setIdEdited] = useState(false);
  const [editing, setEditing] = useState<Row>();
  const [folderRevision, setFolderRevision] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<{ row: Row; revision?: string; source?: string; files?: number }>();
  const [deleteError, setDeleteError] = useState('');
  const [preview, setPreview] = useState('');
  const [projects, setProjects] = useState<{ name: string; path: string; localPath?: string }[]>([]);
  const [imports, setImports] = useState<{ name: string; path: string; category: string }[]>();
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
  async function persist(library: Library) {
    if (!answer) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ library, revision: answer.revision, source_revision: answer.source_revision }) });
      if (!response.ok) throw new Error(await response.text());
      setAnswer(await response.json()); if (draft?.kind === 'skill') setCategory(draft.automatic ? 'skill' : 'command'); setDraft(undefined); setEditing(undefined); setNotice('Saved. New and reconnected chats receive these changes.');
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
      setDeleting(undefined);
      setNotice(`Deleted ${row.item.name}. ${archive ? `Recoverable folder archive: ${archive}. ` : ''}New and reconnected chats receive this change; existing snapshots retain their copy.`);
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
      setCategory(draft.automatic ? 'skill' : 'command'); setDraft(undefined); setEditing(undefined); setFolderRevision(undefined);
      await load(); setNotice('Saved. Supporting files were preserved. New and reconnected chats receive these changes.');
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  }
  function create(content = '', name = '') {
    setEditing(undefined); setImports(undefined); setIdEdited(false);
    setDraft({ id: suggestedItemId(name, answer?.resolved.items.map(r => r.item.id) ?? []), name, content, description: '', kind, when: { op: 'always' }, requires: [], automatic: category !== 'command', parameters: {}, resources: {}, bundle: '' });
  }
  async function importNative() {
    try {
      const result = await sendCommand<{ files: { name: string; path: string; category: string }[] }>({ type: 'agent-files.list', ...(projectPath ? { projectPath } : {}) });
      setImports(result.files.filter(f => ['instructions', 'skills', 'commands', 'output-styles', 'rules'].includes(f.category)));
    } catch (e) { setError(String(e)); }
  }
  async function copyNative(file: { name: string; path: string; category: string }) {
    try {
      const result = await sendCommand<{ content: string; truncated?: boolean }>({ type: 'agent-files.read', path: file.path, ...(projectPath ? { projectPath } : {}) });
      if (result.truncated) throw new Error('This file is too large to import completely.');
      create(result.content, file.name);
      setNotice('Imported a copy. The native original still loads independently; review and retire it yourself after migration. Supporting files must be added under Resources.');
    } catch (e) { setError(String(e)); }
  }
  const inherited = editing?.source === 'global' && !!projectPath;
  const folderEditing = !!editing?.folder_source && !inherited;
  const source = inherited ? answer?.inherited.find(item => item.id === editing?.item.id) : undefined;
  const patch = (change: Partial<Item>) => setDraft(d => d ? { ...d, ...change } : d);
  const rows = answer?.resolved.items.filter(r => r.item.id !== 'atelier-general-instructions' && r.item.kind === kind && (kind !== 'skill' || (category === 'command' ? !r.item.automatic : r.item.automatic))) ?? [];
  return <div className="space-y-5" data-testid="shared-library">
    {!draft && <div><div className="flex items-center gap-2"><BookOpen className="size-5 text-t-muted" /><h2 className="text-lg font-semibold">Agent guidance</h2><Badge>{projectPath ? 'This project' : 'Global'}</Badge></div><p className="mt-2 text-sm text-t-secondary">{projectPath ? 'Manage this project’s instructions, skills, commands and styles.' : 'Manage guidance shared by all projects, across every provider.'}</p></div>}
    {error && <Panel role="alert" tone="danger" className="text-sm">{error}<Button variant="ghost" onClick={() => { setDraft(undefined); setEditing(undefined); void load(); }}>Discard draft and reload</Button></Panel>}
    {notice && <p role="status" className="text-sm text-t-secondary">{notice}</p>}
    {!answer && !error && <p>Loading library…</p>}
    {answer && <>
      {answer.orphaned?.map(id => <Panel key={id} tone="attention" className="text-sm">Source removed: {id}. {!projectRules && <Button variant="ghost" disabled={!!draft || saving} onClick={() => { const library = structuredClone(answer.library); delete library.overrides[id]; void persist(library); }}>Forget customization</Button>}</Panel>)}
      {!draft && <><div className="flex flex-wrap gap-1 border-b border-border/60 pb-2" role="group" aria-label="Library categories">{Object.entries(names).map(([id, label]) => <Button key={id} variant={category === id ? 'secondary' : 'ghost'} aria-pressed={category === id} onClick={() => { setCategory(id as Category); setImports(undefined); }}>{label}</Button>)}</div></>}
      <div hidden={!!draft || kind !== 'instruction'} className="space-y-6">{projectPath ? projectInstructions : <><GeneralInstructions saved={answer.library.general_instructions ?? ''} saving={saving} onSave={text => persist({ ...answer.library, general_instructions: text })} /><div className="border-t border-border/60 pt-6"><h3 className="font-semibold">Reusable instructions</h3><p className="mt-1 text-sm text-t-secondary">Create rules here. Their conditions determine which projects receive them.</p></div></>}</div>
      {!draft && !projectRules && <div className="flex flex-wrap items-start justify-between gap-3"><p className="max-w-sm text-sm text-t-secondary">{category === 'command' ? 'Procedures you run explicitly from the chat composer. Commands are never chosen automatically by the agent.' : descriptions[kind]}</p><div className="flex flex-wrap gap-2"><Button onClick={() => create()}><Plus className="mr-1 size-4" />Add {itemLabel}</Button><Button variant="ghost" onClick={() => void importNative()}>Import native file</Button></div></div>}
      {!draft && kind === 'output_style' && <Panel className="space-y-2"><span className="text-sm font-medium">Selected output style</span><Picker label="Selected output style" disabled={saving} value={answer.library.output_style ?? '__inherit'} onChange={value => void persist({ ...answer.library, output_style: value === '__inherit' ? null : value })} choices={[{ value: '__inherit', label: projectPath ? 'Use global selection' : 'No style selected' }, { value: '', label: 'No shared output style' }, ...answer.resolved.items.filter(r => r.item.kind === 'output_style' && (projectPath || r.source !== 'project')).map(r => ({ value: r.item.id, label: r.item.name }))]} /><p className="text-xs text-t-muted">Applies to new and reconnected chats. Shared across providers. Claude’s native output-style selection is ignored in Atelier.</p></Panel>}
      {!draft && projectPath && kind === 'skill' && <Panel className="space-y-2"><h3 className="font-medium">Choose what this project can use</h3><p className="text-sm text-t-secondary">Switch off any {category === 'command' ? 'command' : 'skill'} this project does not need. This keeps its files and customizations, and changes nothing globally or in other projects.</p><p className="text-xs text-t-muted">Applies to new and reconnected chats, including explicit invocations. Switching on still respects conditions and required tools.</p></Panel>}
      {imports && <Panel tone="frame" className="space-y-2"><p className="text-sm">Choose a file to copy into {names[category].toLowerCase()}.</p>{imports.length === 0 && <p className="text-sm">No native files found.</p>}{imports.map(f => <Button key={f.path} variant="ghost" className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => void copyNative(f)}>{f.name} · {f.category}</Button>)}<Button variant="outline" onClick={() => setImports(undefined)}>Cancel import</Button></Panel>}
      {projectRules ? <ProjectInstructionSummary rows={answer.resolved.items.filter(row => row.item.kind === 'instruction')} /> : draft ? <section className="min-w-0 space-y-6" aria-label="Library item editor" data-testid="library-editor">
        <header className="space-y-3"><Button variant="ghost" size="sm" disabled={saving} onClick={() => { if (window.confirm('Discard this draft and return to the library?')) { setDraft(undefined); setEditing(undefined); } }}><ArrowLeft className="mr-2 size-4" />Back to {names[category].toLowerCase()}</Button><div className="flex flex-wrap items-center gap-2"><h2 className="text-xl font-semibold">{inherited ? 'Customize' : editing ? 'Edit' : 'New'} {itemLabel}</h2><Badge>{projectPath ? 'This project only' : 'All projects'}</Badge></div><p className="text-sm text-t-secondary">{inherited ? 'Overrides affect only this project. Unchanged fields keep following the global version.' : projectPath ? 'This guidance belongs to this project and is shared by its providers.' : 'Changes are shared with every project that inherits this item.'}</p></header>
        <EditorSection step="1" title="What it does" description={draft.kind === 'output_style' ? 'Describe how the agent should write its answers.' : 'Give this guidance a clear name and tell the agent what to do.'}>
          <label className="block space-y-2 text-sm"><span className="font-medium">Name{inherited ? ' · inherited' : ''}</span><Input aria-label="Item name" disabled={inherited} value={draft.name} placeholder="e.g. Release check" onChange={e => patch({ name: e.target.value, ...(!editing && !idEdited ? { id: suggestedItemId(e.target.value, answer.resolved.items.map(r => r.item.id)) } : {}) })} /></label>
          <label className="block space-y-2 text-sm"><span className="font-medium">{draft.kind === 'skill' && draft.automatic ? 'When should the agent choose this skill?' : 'Short description'}{inherited ? ' · inherited' : ''}</span><Input aria-label="Item description" disabled={inherited} value={draft.description} placeholder={draft.kind === 'skill' ? 'e.g. Before releasing a package' : 'Optional summary for the library'} onChange={e => patch({ description: e.target.value })} /></label>
          <label className="block space-y-2 text-sm"><span className="font-medium">{draft.kind === 'output_style' ? 'Writing guidelines' : 'Instructions'}</span><Textarea aria-label="Item content" className="min-h-40 font-mono text-sm" value={draft.content} onChange={e => patch({ content: e.target.value })} />{inherited && <span className="block text-xs text-t-muted">Editing replaces the global instructions for this project.</span>}</label>
        </EditorSection>
        <EditorSection step="2" title="When it applies" description="Limit where this guidance is available. Conditions are evaluated for each project.">
          {draft.kind === 'skill' && <div className="space-y-2"><label className="flex items-start gap-3 text-sm"><Checkbox className="mt-0.5 shrink-0" checked={draft.automatic} onCheckedChange={checked => patch({ automatic: checked === true })} /><span className="font-medium">Allow automatic selection by the agent</span></label><p className="pl-7 text-xs text-t-secondary">{draft.automatic ? 'The agent can discover this skill from its description. You can also invoke it directly.' : 'Manual only. Invoke this skill directly from the chat composer.'}</p><p className="break-all pl-7 font-mono text-xs text-t-muted">/skill:{draft.id}</p></div>}
          <fieldset className="min-w-0 space-y-2"><legend className="mb-2 text-sm font-medium">Available when</legend><Conditions value={draft.when} onChange={when => patch({ when })} /></fieldset>
        </EditorSection>
        <Panel inset="none" asChild><details data-testid="editor-support"><summary className="cursor-pointer px-4 py-4"><span className="ml-1 font-semibold">3 · Supporting material</span><span className="mt-1 block text-sm text-t-secondary">{Object.keys(draft.parameters).length} parameters{folderEditing ? ' · Scripts and assets preserved' : draft.kind === 'skill' ? ` · ${Object.keys(draft.resources).length} resources` : ''} · Optional</span></summary><div className="min-w-0 space-y-6 border-t border-border/40 p-4"><p className="text-sm text-t-secondary">Use {'{{parameter-name}}'} in instructions to insert a reusable value.{inherited ? ' Reset inherited values to global defaults, or add project-only values.' : ''}</p><Entries label="Parameters" value={draft.parameters} defaults={source?.parameters} onChange={parameters => patch({ parameters })} />{draft.kind === 'skill' && (folderEditing ? <div className="space-y-2"><h4 className="text-sm font-medium">Scripts and assets</h4><p className="text-sm text-t-secondary">Saving preserves every supporting file. To edit scripts, references or binary assets, use the skill folder.</p><p className="break-all font-mono text-xs">{editing?.folder_source}</p></div> : !inherited ? <div className="space-y-3"><p className="text-sm text-t-secondary">Resources are supporting text files the agent reads on demand.</p><Entries label="Resources" value={draft.resources} onChange={resources => patch({ resources })} /></div> : <div className="space-y-2"><h4 className="text-sm font-medium">Resources · inherited</h4><p className="text-xs text-t-secondary">Edit resource files in the global library.</p>{Object.keys(draft.resources).map(name => <p key={name} className="break-all font-mono text-xs">{name}</p>)}</div>)}</div></details></Panel>
        <Panel inset="none" asChild><details data-testid="editor-advanced"><summary className="cursor-pointer px-4 py-4"><span className="ml-1 font-semibold">4 · Advanced settings</span><span className="mt-1 block text-sm text-t-secondary">{folderEditing ? 'Identifier and required tools' : 'Identifier, required tools, and bundle'}</span></summary><div className="space-y-5 border-t border-border/40 p-4"><label className="block space-y-2 text-sm"><span className="font-medium">Identifier</span><Input aria-label="Item ID" disabled={!!editing} value={draft.id} onChange={e => { setIdEdited(true); patch({ id: e.target.value }); }} /><span className="block text-xs text-t-muted">Generated from the name. Used in shortcuts and project overrides; fixed after saving.</span></label><label className="block space-y-2 text-sm"><span className="font-medium">Required tools{inherited ? ' · inherited' : ''}</span><Input aria-label="Required executables" disabled={inherited} placeholder="e.g. git, npm" value={draft.requires.join(', ')} onChange={e => patch({ requires: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} /><span className="block text-xs text-t-muted">Comma-separated executables. Missing tools make this item unavailable.</span></label>{!folderEditing && <label className="block space-y-2 text-sm"><span className="font-medium">Bundle{inherited ? ' · inherited' : ''}</span><Input aria-label="Bundle" disabled={inherited} placeholder="Optional grouping name" value={draft.bundle} onChange={e => patch({ bundle: e.target.value })} /></label>}</div></details></Panel>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4"><p className="text-xs text-t-muted">Applies to new and reconnected chats.</p><div className="flex gap-2"><Button variant="outline" disabled={saving} onClick={() => { setDraft(undefined); setEditing(undefined); }}>Cancel</Button><Button disabled={saving || !draft.id || !draft.name.trim()} onClick={() => {
          if (folderEditing) { void persistFolder(); return; }
          if (!editing && answer.library.items.some(item => item.id === draft.id)) { setError('This ID already exists. Choose a different ID or edit the existing item.'); return; }
          const library = structuredClone(answer.library);
          if (inherited) {
            if (!source) { setError('The global source has changed. Reload before customizing it.'); return; }
            const prior = library.overrides[draft.id] ?? {};
            library.overrides[draft.id] = buildCustomization(draft, source, prior.disabled);
          } else { library.items = [...library.items.filter(i => i.id !== draft.id), draft]; }
          void persist(library);
        }}><Save className="mr-1 size-4" />{saving ? 'Saving…' : 'Save item'}</Button></div></footer>
      </section> : <div className="space-y-3">{rows.length === 0 && <Panel tone="frame" className="text-sm text-t-secondary">No {names[category].toLowerCase()} yet. Add one to share it across providers.</Panel>}{rows.map(row => <Panel key={row.item.id} tone="frame" className="space-y-2" data-testid={`library-item-${row.item.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-medium">{row.item.name}</h3><p className="text-xs text-t-muted">{row.source}{row.customized ? ' · customized here' : ''}{row.item.bundle ? ` · ${row.item.bundle}` : ''}{row.item.kind === 'skill' ? ` · /skill:${row.item.id}` : ''}</p></div><Badge>{states[row.state] ?? row.state}</Badge></div>
        {projectPath && row.item.kind === 'skill' && row.source !== 'built-in' && <Button variant="outline" size="sm" role="switch" aria-checked={!answer.library.overrides[row.item.id]?.disabled} aria-label={`Enable ${row.item.name} for this project`} disabled={saving} onClick={() => setProjectSkillEnabled(row.item.id, !!answer.library.overrides[row.item.id]?.disabled)}><span aria-hidden="true" className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 ${answer.library.overrides[row.item.id]?.disabled ? 'bg-t-muted/40' : 'bg-primary'}`}><span className={`size-4 rounded-full bg-background ${answer.library.overrides[row.item.id]?.disabled ? '' : 'translate-x-4'}`} /></span>{answer.library.overrides[row.item.id]?.disabled ? 'Off for this project' : 'On for this project'}</Button>}
        {row.item.description && <p className="text-sm text-t-secondary">{row.item.description}</p>}
        {row.folder_source && <p className="break-all text-xs text-t-secondary">Folder-backed skill. Edit instructions and settings here; scripts and assets stay in <code>{row.folder_source}</code>.</p>}
        <details><summary className="cursor-pointer text-xs text-t-secondary">Why? · Inspect content</summary><div className="mt-2 space-y-2"><Evidence value={row.evaluation} />{row.missing.length > 0 && <p className="text-xs">Missing: {row.missing.join(', ')}</p>}<pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-surface-overlay p-3 text-xs">{row.item.content}</pre></div></details>
        {row.source !== 'built-in' && !(row.source === 'project' && !projectPath) && <div className="flex flex-wrap gap-2">
          {(!row.folder_source || row.state !== 'invalid') && <Button variant="outline" size="sm" disabled={saving} onClick={() => void edit(row)}>{projectPath && row.source === 'global' ? 'Customize' : 'Edit'}</Button>}
          {projectPath && row.source === 'global' ? <>{row.item.kind !== 'skill' && <Button variant="ghost" size="sm" disabled={saving} onClick={() => void persist({ ...answer.library, overrides: { ...answer.library.overrides, [row.item.id]: { ...answer.library.overrides[row.item.id], disabled: row.state !== 'disabled' } } })}>{row.state === 'disabled' ? 'Enable here' : 'Disable here'}</Button>}{row.customized && <Button variant="ghost" size="sm" disabled={saving} onClick={() => { const library = structuredClone(answer.library); delete library.overrides[row.item.id]; void persist(library); }}>Reset to global</Button>}</> : <Button variant="ghost" size="sm" className="text-danger" disabled={saving} onClick={() => void prepareDelete(row)}>Delete…</Button>}
        </div>}
      </Panel>)}</div>}
      {!draft && <details className="border-t border-border/40 pt-4"><summary className="cursor-pointer text-sm font-medium">Preview and diagnostics</summary><div className="mt-4 space-y-4">{!projectPath && <div className="space-y-2"><span className="text-sm">Evaluate for project</span><Picker label="Evaluate for project" value={preview} onChange={setPreview} choices={[{ value: '', label: 'Choose a project to explain conditions' }, ...projects.filter(p => !(p.localPath || p.path).startsWith('dolt://')).map(p => ({ value: p.localPath || p.path, label: p.name }))]} /></div>}<h3 className="text-sm font-medium">Saved session preview</h3><p className="break-all text-xs text-t-muted">Revision {answer.resolved.revision}. Instructions and the selected style are included; skills are loaded on use. Current chats retain their connection’s snapshot.</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{answer.guidance}</pre></div></details>}
    </>}
    <Dialog open={!!deleting} onOpenChange={open => { if (!open && !saving) setDeleting(undefined); }}>
      <DialogContent role="alertdialog" hideClose>
        <DialogTitle>Delete {deleting?.row.item.name}?</DialogTitle>
        <DialogDescription>
          {projectPath ? 'This removes the item owned by this project.' : 'This removes the global item for every project that inherits it.'}
          {deleting?.row.folder_source ? <><span className="mt-2 block">The entire skill folder, including scripts and assets, will move to a recoverable archive outside the active library.</span><span className="mt-2 block break-all font-mono text-xs">{deleting.source ?? deleting.row.folder_source}</span>{deleting.files !== undefined && <span className="mt-1 block">{deleting.files} files or links included.</span>}</> : <span className="mt-2 block">This deletes the saved library entry. There is no undo button.</span>}
          <span className="mt-2 block">Existing chat snapshots retain their copy until reconnected.</span>
        </DialogDescription>
        {deleteError && <div role="alert" className="text-sm text-danger"><p>{deleteError}</p><Button variant="ghost" disabled={saving} onClick={() => { setDeleting(undefined); void load(); }}>Reload settings</Button></div>}
        <DialogFooter><Button variant="outline" disabled={saving} onClick={() => setDeleting(undefined)}>Cancel</Button><Button variant="destructive" disabled={saving || !!deleteError || (!!deleting?.row.folder_source && !deleting.revision)} onClick={() => void deleteItem()}>{saving ? 'Please wait…' : `Delete ${deleting?.row.item.kind === 'skill' ? deleting.row.item.automatic ? 'skill' : 'command' : deleting?.row.item.kind === 'output_style' ? 'output style' : 'instruction'}`}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
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
  return <section aria-label="Global instructions" className="space-y-3"><h3 className="font-semibold">Global instructions</h3><p className="text-sm text-t-secondary">Your shared CLAUDE.md / AGENTS.md guidance for all projects and providers. Included automatically, alongside each project's instructions.</p><label className="block"><span className="sr-only">Global instructions</span><Textarea className="min-h-48 font-mono text-sm" value={text} onChange={event => setText(event.target.value)} /></label><Button disabled={saving || text === saved} onClick={() => void onSave(text)}>Save global instructions</Button></section>;
}

function ProjectInstructionSummary({ rows }: { rows: Row[] }) {
  const globals = rows.filter(row => row.source === 'global');
  const applied = globals.filter(row => row.state === 'available');
  const inactive = globals.filter(row => row.state !== 'available');
  const existing = rows.filter(row => row.source === 'project');
  const builtins = rows.filter(row => row.source === 'built-in');
  const list = (items: Row[]) => items.map(row => <div key={row.item.id} className="space-y-2 border-b border-border/40 py-3 last:border-0" data-testid={`library-item-${row.item.id}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{row.item.name}</h4><Badge>{row.state === 'available' ? 'Included' : states[row.state] ?? row.state}</Badge></div>
    <Evidence value={row.evaluation} />
    {row.customized && <p className="text-xs text-t-muted">A previously saved project override is preserved for this rule.</p>}
    {row.missing.length > 0 && <p className="text-xs">Missing: {row.missing.join(', ')}</p>}
    <details><summary className="cursor-pointer text-xs text-t-secondary">View instructions</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{row.item.content}</pre></details>
  </div>);
  return <section className="space-y-4 border-t border-border/60 pt-6" aria-label="Applied global guidance" data-testid="project-instruction-summary">
    <div><h3 className="font-semibold">Applied global guidance</h3><p className="mt-1 text-sm text-t-secondary">Read-only. Global rules apply according to their conditions. Create and edit them in global settings.</p><a className="mt-2 inline-block text-sm text-primary underline underline-offset-4" href="/settings?section=library">Manage global instructions</a></div>
    {applied.length ? <div>{list(applied)}</div> : <p className="text-sm text-t-muted">No global instructions apply to this project.</p>}
    {inactive.length > 0 && <details><summary className="cursor-pointer text-sm">Not applied · {inactive.length}</summary>{list(inactive)}</details>}
    {existing.length > 0 && <details><summary className="cursor-pointer text-sm">Previously saved project rules · {existing.length}</summary><p className="mt-2 text-xs text-t-secondary">These older rules are preserved, including their conditions. New project guidance belongs in Project instructions above.</p>{list(existing)}</details>}
    {builtins.length > 0 && <details><summary className="cursor-pointer text-sm">Built-in guidance</summary>{list(builtins)}</details>}
  </section>;
}
