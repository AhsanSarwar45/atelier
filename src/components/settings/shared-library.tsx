'use client';

import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Plus, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiUrl } from '@/lib/api-base';
import { sendCommand } from '@/workbench/use-session';

type Condition = { op: string; path?: string; text?: string; pattern?: string; pointer?: string; key?: string; value?: unknown; name?: string; conditions?: Condition[]; condition?: Condition };
type Kind = 'instruction' | 'skill' | 'output_style';
interface Item { id: string; name: string; description: string; kind: Kind; content: string; when: Condition; requires: string[]; automatic: boolean; parameters: Record<string, string>; resources: Record<string, string>; bundle: string }
interface Override { disabled?: boolean; content?: string | null; when?: Condition | null; automatic?: boolean | null; parameters?: Record<string, string> }
interface Library { items: Item[]; overrides: Record<string, Override>; output_style?: string | null }
interface Evaluation { matched: boolean | null; reason: string; children: Evaluation[] }
interface Row { item: Item; source: string; customized: boolean; state: string; evaluation: Evaluation; missing: string[] }
interface Answer { library: Library; revision: string; resolved: { revision: string; items: Row[] }; guidance: string; orphaned?: string[] }
const names: Record<Kind, string> = { instruction: 'Instructions', skill: 'Skills', output_style: 'Output styles' };
const states: Record<string, string> = { available: 'Available', not_applicable: 'Does not apply', unknown: 'Needs evaluation', unavailable: 'Missing requirements', disabled: 'Disabled here', not_selected: 'Not selected', conflict: 'ID conflict' };
const selectClass = 'h-9 max-w-full rounded-md border border-border bg-surface-base px-2 text-sm text-t-primary';
const conditionNames: Record<string, string> = { always: 'Always', all: 'All conditions', any: 'Any condition', not: 'Not', file_exists: 'File exists', folder_exists: 'Folder exists', file_contains: 'File contains text', file_matches: 'Filename matches pattern', file_regex: 'File matches regular expression', within: 'In the folder of any matching file', dependency: 'Package declares dependency', json_exists: 'JSON value exists', json_equals: 'JSON value equals', toml_equals: 'TOML value equals', yaml_equals: 'YAML value equals', project_beads: 'Project uses Beads' };
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
  return <div className="space-y-2 rounded-md border border-border/60 p-3" data-testid="condition-builder">
    <select aria-label="Condition" className={selectClass} value={value.op} onChange={e => onChange(newCondition(e.target.value))}>{Object.entries(conditionNames).filter(([op]) => depth < 7 || !['all', 'any', 'not', 'within'].includes(op)).map(([op, name]) => <option key={op} value={op}>{name}</option>)}</select>
    {'pattern' in value && <Input aria-label="Match pattern" value={value.pattern} onChange={e => patch({ pattern: e.target.value })} />}
    {'path' in value && <Input aria-label="Condition path" placeholder="Relative to this checkout, e.g. package.json" value={value.path} onChange={e => patch({ path: e.target.value })} />}
    {'text' in value && <Input aria-label="Containing text" value={value.text} onChange={e => patch({ text: e.target.value })} />}
    {'name' in value && <Input aria-label="Dependency name" placeholder="e.g. next" value={value.name} onChange={e => patch({ name: e.target.value })} />}
    {'pointer' in value && <Input aria-label="JSON pointer" placeholder="e.g. /scripts/test" value={value.pointer} onChange={e => patch({ pointer: e.target.value })} />}
    {'key' in value && <Input aria-label="TOML key" placeholder="e.g. package.name" value={value.key} onChange={e => patch({ key: e.target.value })} />}
    {'value' in value && <Input aria-label="Expected value" placeholder="Text, number, true or false" value={typeof value.value === 'string' ? value.value : JSON.stringify(value.value)} onChange={e => { let v: unknown = e.target.value; try { v = JSON.parse(e.target.value); } catch { /* plain text */ } patch({ value: v }); }} />}
    {value.condition && <Conditions value={value.condition} depth={depth + 1} onChange={condition => patch({ condition })} />}
    {value.conditions?.map((condition, index) => <div key={index} className="flex items-start gap-2"><div className="min-w-0 flex-1"><Conditions value={condition} depth={depth + 1} onChange={changed => patch({ conditions: value.conditions!.map((c, i) => i === index ? changed : c) })} /></div><Button variant="ghost" aria-label="Remove condition" disabled={value.conditions!.length === 1} onClick={() => patch({ conditions: value.conditions!.filter((_, i) => i !== index) })}><Trash2 className="size-4" /></Button></div>)}
    {value.conditions && <Button variant="outline" onClick={() => patch({ conditions: [...value.conditions!, { op: 'file_exists', path: '' }] })}>Add condition</Button>}
  </div>;
}
function Evidence({ value }: { value: Evaluation }) {
  return <div className="text-xs text-t-secondary"><span>{value.matched === null ? '?' : value.matched ? '✓' : '—'} {value.reason}</span>{value.children.map((child, i) => <div key={i} className="ml-3 mt-1 border-l border-border pl-2"><Evidence value={child} /></div>)}</div>;
}
function Entries({ label, value, onChange }: { label: string; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const entries = Object.entries(value);
  const update = (index: number, key: string, text: string) => {
    if (entries.some(([existing], i) => i !== index && existing === key)) return;
    onChange(Object.fromEntries(entries.map((pair, i) => i === index ? [key, text] : pair)));
  };
  return <fieldset className="space-y-2"><legend className="text-sm font-medium">{label}</legend>{entries.map(([key, text], i) => <div key={i} className="space-y-2 rounded border border-border p-2"><div className="flex gap-2"><Input aria-label={`${label} name`} value={key} onChange={e => update(i, e.target.value, text)} /><Button variant="ghost" aria-label={`Remove ${label.toLowerCase()}`} onClick={() => onChange(Object.fromEntries(entries.filter((_, n) => i !== n)))}><Trash2 className="size-4" /></Button></div><Textarea aria-label={`${label} value`} value={text} onChange={e => update(i, key, e.target.value)} /></div>)}<Button variant="outline" onClick={() => onChange({ ...value, [`new-${entries.length + 1}`]: '' })}>Add {label.toLowerCase()}</Button></fieldset>;
}

export function SharedLibrary({ projectPath }: { projectPath?: string }) {
  const [answer, setAnswer] = useState<Answer>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [kind, setKind] = useState<Kind>('instruction');
  const [draft, setDraft] = useState<Item>();
  const [editing, setEditing] = useState<Row>();
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState('');
  const [projects, setProjects] = useState<{ name: string; path: string; localPath?: string }[]>([]);
  const [imports, setImports] = useState<{ name: string; path: string; category: string }[]>();
  const url = apiUrl(`/api/settings/library?${new URLSearchParams(projectPath ? { path: projectPath } : preview ? { preview } : {})}`);
  const load = useCallback(async () => {
    try { const response = await fetch(url); if (!response.ok) throw new Error(await response.text()); setAnswer(await response.json()); setError(''); }
    catch (e) { setError(String(e)); }
  }, [url]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!projectPath) void fetch(apiUrl('/api/projects')).then(r => r.json()).then(setProjects).catch(() => {}); }, [projectPath]);
  useEffect(() => {
    if (!draft) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [draft]);
  async function persist(library: Library) {
    if (!answer) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ library, revision: answer.revision }) });
      if (!response.ok) throw new Error(await response.text());
      setAnswer(await response.json()); setDraft(undefined); setEditing(undefined); setNotice('Saved. New and reconnected chats receive these changes.');
    } catch (e) { setError(String(e)); } finally { setSaving(false); }
  }
  function create(content = '', name = '') {
    setEditing(undefined); setImports(undefined);
    setDraft({ id: '', name, content, description: '', kind, when: { op: 'always' }, requires: [], automatic: true, parameters: {}, resources: {}, bundle: '' });
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
  const patch = (change: Partial<Item>) => setDraft(d => d ? { ...d, ...change } : d);
  const rows = answer?.resolved.items.filter(r => r.item.kind === kind) ?? [];
  return <div className="space-y-5" data-testid="shared-library">
    <div><div className="flex items-center gap-2"><BookOpen className="size-5 text-t-muted" /><h2 className="text-lg font-semibold">Shared library</h2></div><p className="mt-1 text-sm text-t-secondary">{projectPath ? 'Global guidance and this project’s customizations, for every provider.' : 'Instructions, skills and output styles shared across all projects and providers.'}</p></div>
    {error && <div role="alert" className="rounded border border-red-500/40 p-3 text-sm">{error}<Button variant="ghost" onClick={() => { setDraft(undefined); setEditing(undefined); void load(); }}>Discard draft and reload</Button></div>}
    {notice && <p role="status" className="text-sm text-t-secondary">{notice}</p>}
    {!answer && !error && <p>Loading library…</p>}
    {answer && <>
      {answer.orphaned?.map(id => <p key={id} className="rounded border border-border p-2 text-sm">Global source removed: {id}. <Button variant="ghost" disabled={!!draft || saving} onClick={() => { const library = structuredClone(answer.library); delete library.overrides[id]; void persist(library); }}>Forget customization</Button></p>)}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Library categories">{Object.entries(names).map(([id, label]) => <Button key={id} variant={kind === id ? 'primary' : 'outline'} disabled={!!draft} onClick={() => setKind(id as Kind)}>{label}</Button>)}</div>
      {!projectPath && <label className="block space-y-1 text-sm"><span>Evaluate for project</span><select aria-label="Evaluate for project" disabled={!!draft} className={`${selectClass} block w-full`} value={preview} onChange={e => setPreview(e.target.value)}><option value="">Choose a project to explain conditions</option>{projects.filter(p => !(p.localPath || p.path).startsWith('dolt://')).map(p => <option key={p.path} value={p.localPath || p.path}>{p.name}</option>)}</select></label>}
      {kind === 'output_style' && <label className="block space-y-1 text-sm"><span>Selected output style</span><select aria-label="Selected output style" disabled={!!draft || saving} className={`${selectClass} block w-full`} value={answer.library.output_style ?? '__inherit'} onChange={e => void persist({ ...answer.library, output_style: e.target.value === '__inherit' ? null : e.target.value })}><option value="__inherit">{projectPath ? 'Use global selection' : 'No style selected'}</option><option value="">No shared output style</option>{answer.resolved.items.filter(r => r.item.kind === 'output_style' && (projectPath || r.source !== 'project')).map(r => <option key={r.item.id} value={r.item.id}>{r.item.name}</option>)}</select><span className="block text-xs text-t-muted">One shared style is included at a time. Native provider styles may still apply.</span></label>}
      {!draft && <div className="flex flex-wrap gap-2"><Button onClick={() => create()}><Plus className="mr-1 size-4" />Add {kind === 'output_style' ? 'output style' : kind}</Button><Button variant="outline" onClick={() => void importNative()}>Import native file</Button></div>}
      {imports && <div className="space-y-2 rounded border border-border p-3"><p className="text-sm">Choose a file to copy into {names[kind].toLowerCase()}.</p>{imports.length === 0 && <p className="text-sm">No native files found.</p>}{imports.map(f => <Button key={f.path} variant="ghost" className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => void copyNative(f)}>{f.name} · {f.category}</Button>)}<Button variant="outline" onClick={() => setImports(undefined)}>Cancel import</Button></div>}
      {draft ? <div className="space-y-4 rounded-lg border border-border p-4" data-testid="library-editor">
        <h3 className="font-medium">{inherited ? 'Customize for this project' : editing ? 'Edit' : 'Create'} {kind === 'output_style' ? 'output style' : kind}</h3>
        <label className="block space-y-1 text-sm"><span>ID</span><Input aria-label="Item ID" disabled={!!editing} value={draft.id} placeholder="e.g. frontend-review" onChange={e => patch({ id: e.target.value })} /></label>
        <label className="block space-y-1 text-sm"><span>Name</span><Input aria-label="Item name" disabled={inherited} value={draft.name} onChange={e => patch({ name: e.target.value })} /></label>
        <label className="block space-y-1 text-sm"><span>Description · when the agent should use this</span><Input aria-label="Item description" disabled={inherited} value={draft.description} onChange={e => patch({ description: e.target.value })} /></label>
        <label className="block space-y-1 text-sm"><span>{inherited ? 'Content replacement (other global fields remain inherited)' : 'Content'}</span><Textarea aria-label="Item content" className="min-h-48 font-mono text-sm" value={draft.content} onChange={e => patch({ content: e.target.value })} /></label>
        <fieldset className="space-y-2"><legend className="text-sm font-medium">Available when</legend><Conditions value={draft.when} onChange={when => patch({ when })} /></fieldset>
        {draft.kind === 'skill' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.automatic} onChange={e => patch({ automatic: e.target.checked })} />Allow automatic selection by the agent</label>}
        <label className="block space-y-1 text-sm"><span>Requires executables (comma separated)</span><Input aria-label="Required executables" disabled={inherited} placeholder="e.g. git, npm" value={draft.requires.join(', ')} onChange={e => patch({ requires: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} /></label>
        <label className="block space-y-1 text-sm"><span>Bundle (optional grouping)</span><Input aria-label="Bundle" disabled={inherited} value={draft.bundle} onChange={e => patch({ bundle: e.target.value })} /></label>
        <details><summary className="cursor-pointer text-sm">Parameters and supporting resources</summary><div className="mt-3 space-y-4"><p className="text-xs text-t-secondary">Use {'{{parameter-name}}'} in content. Resources are text files read through the same shared skill tool.</p><Entries label="Parameters" value={draft.parameters} onChange={parameters => patch({ parameters })} />{!inherited && <Entries label="Resources" value={draft.resources} onChange={resources => patch({ resources })} />}</div></details>
        <div className="flex gap-2"><Button disabled={saving || !draft.id || !draft.name} onClick={() => {
          if (!editing && answer.library.items.some(item => item.id === draft.id)) { setError('This ID already exists. Choose a different ID or edit the existing item.'); return; }
          const library = structuredClone(answer.library);
          if (inherited) {
            const global = editing!.item;
            const prior = library.overrides[draft.id] ?? {};
            library.overrides[draft.id] = { ...prior, ...(draft.content !== global.content ? { content: draft.content } : {}), ...(JSON.stringify(draft.when) !== JSON.stringify(global.when) ? { when: draft.when } : {}), ...(draft.automatic !== global.automatic ? { automatic: draft.automatic } : {}), parameters: { ...prior.parameters, ...Object.fromEntries(Object.entries(draft.parameters).filter(([key, value]) => global.parameters[key] !== value)) } };
          } else { library.items = [...library.items.filter(i => i.id !== draft.id), draft]; }
          void persist(library);
        }}><Save className="mr-1 size-4" />{saving ? 'Saving…' : 'Save item'}</Button><Button variant="outline" disabled={saving} onClick={() => { setDraft(undefined); setEditing(undefined); }}>Cancel</Button></div>
      </div> : <div className="space-y-3">{rows.length === 0 && <p className="rounded border border-dashed border-border p-6 text-sm text-t-secondary">No {names[kind].toLowerCase()} yet. Add one to share it across providers.</p>}{rows.map(row => <article key={row.item.id} className="space-y-2 rounded-lg border border-border p-4" data-testid={`library-item-${row.item.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-medium">{row.item.name}</h3><p className="text-xs text-t-muted">{row.source}{row.customized ? ' · customized here' : ''}{row.item.bundle ? ` · ${row.item.bundle}` : ''}{row.item.kind === 'skill' ? ` · /skill:${row.item.id}` : ''}</p></div><span className="rounded bg-surface-overlay px-2 py-1 text-xs">{states[row.state] ?? row.state}</span></div>
        {row.item.description && <p className="text-sm text-t-secondary">{row.item.description}</p>}
        <details><summary className="cursor-pointer text-xs text-t-secondary">Why? · Inspect content</summary><div className="mt-2 space-y-2"><Evidence value={row.evaluation} />{row.missing.length > 0 && <p className="text-xs">Missing: {row.missing.join(', ')}</p>}<pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-surface-overlay p-3 text-xs">{row.item.content}</pre></div></details>
        {row.source !== 'built-in' && !(row.source === 'project' && !projectPath) && <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => { setEditing(row); setDraft(structuredClone(!projectPath ? answer.library.items.find(i => i.id === row.item.id) ?? row.item : row.item)); }}>{projectPath && row.source === 'global' ? 'Customize' : 'Edit'}</Button>
          {projectPath && row.source === 'global' ? <><Button variant="ghost" size="sm" disabled={saving} onClick={() => void persist({ ...answer.library, overrides: { ...answer.library.overrides, [row.item.id]: { ...answer.library.overrides[row.item.id], disabled: row.state !== 'disabled' } } })}>{row.state === 'disabled' ? 'Enable here' : 'Disable here'}</Button>{row.customized && <Button variant="ghost" size="sm" disabled={saving} onClick={() => { const library = structuredClone(answer.library); delete library.overrides[row.item.id]; void persist(library); }}>Reset to global</Button>}</> : <Button variant="ghost" size="sm" disabled={saving} onClick={() => { if (window.confirm(`Remove ${row.item.name} from this library? Existing chat snapshots retain their copy.`)) void persist({ ...answer.library, items: answer.library.items.filter(i => i.id !== row.item.id), output_style: answer.library.output_style === row.item.id ? '' : answer.library.output_style }); }}>Remove</Button>}
        </div>}
      </article>)}</div>}
      <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">Saved session preview</summary><p className="mt-2 break-all text-xs text-t-muted">Revision {answer.resolved.revision}. Instructions and the selected style are included; skills are loaded on use. Current chats retain their connection’s snapshot.</p><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap text-xs">{answer.guidance}</pre></details>
    </>}
  </div>;
}
