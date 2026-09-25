'use client';

import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Panel } from '@/components/ui/panel';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { request } from '@/lib/api';
import { ActionBar, BackToList, DetailEmpty, DetailHeader, Document, Label, ListEmpty, ListGroup, ListHeader, ListRow, MasterDetail } from './library-list';

type Scope = 'global' | 'project';
interface Memory { id: string; description: string; type: string; body: string }
interface Stored extends Memory { scope: Scope; revision: string; path: string }
interface Listing { global: Stored[]; project: Stored[] | null; problems: string[]; types: string[] }
const typeNames: Record<string, string> = { user: 'User', feedback: 'Feedback', project: 'Project', reference: 'Reference' };
const typeHints: Record<string, string> = {
  user: 'Who the user is: role, expertise, preferences.',
  feedback: 'How agents should work, with the reason.',
  project: 'Goals or constraints the code does not show.',
  reference: 'Where to find something outside the repository.',
};
const key = (m: Stored) => `${m.scope}-${m.id}`;

/** Atelier memory: one store every provider and chat reads, edited here or with `atelier tool memory`. */
export function AgentMemories({ projectPath, onChange, onOpenChange }: { projectPath?: string; onChange?: () => void; onOpenChange?: (open: boolean) => void }) {
  const scope: Scope = projectPath ? 'project' : 'global';
  const url = `/api/settings/library/memories?${new URLSearchParams(projectPath ? { path: projectPath } : {})}`;
  const [listing, setListing] = useState<Listing>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Memory>();
  const [editing, setEditing] = useState<Stored>();
  const [deleting, setDeleting] = useState<Stored>();
  const [chosen, setChosen] = useState<string>();
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => onOpenChange?.(opened), [opened, onOpenChange]);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await request(url, { signal });
      if (!response.ok) throw new Error(await response.text());
      const next = await response.json();
      if (!signal?.aborted) { setListing(next); setError(''); }
    } catch (e) { if (!signal?.aborted) setError(String(e)); }
  }, [url]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  async function send(method: 'PUT' | 'DELETE', body: unknown, done: string, next?: string) {
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await response.text());
      setListing(await response.json());
      setDraft(undefined); setEditing(undefined); setDeleting(undefined);
      if (next) setChosen(next); else setOpened(false);
      setNotice(done);
      onChange?.();
    } catch (e) { setError(String(e)); setDeleting(undefined); } finally { setSaving(false); }
  }
  const own = (projectPath ? listing?.project : listing?.global) ?? [];
  const inherited = projectPath ? listing?.global ?? [] : [];
  const types = listing?.types ?? Object.keys(typeNames);
  const valid = !!draft && /^[a-z0-9-]{1,80}$/.test(draft.id) && !!draft.description.trim() && !draft.description.includes('\n') && !!draft.body.trim();
  const found = (m: Stored) => !query.trim() || [m.id, m.description, m.body].some(t => t.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = [{ key: 'own', title: projectPath ? 'This project' : undefined, memories: own.filter(found), editable: true }, { key: 'global', title: 'Global (read-only)', memories: inherited.filter(found), editable: false }].filter(g => g.memories.length || (g.key === 'own' && !query));
  const everything = groups.flatMap(g => g.memories);
  const current = everything.find(m => key(m) === chosen) ?? everything[0];
  const editable = !!current && current.scope === scope;
  function startDraft(memory?: Stored) {
    setError(''); setNotice(''); setEditing(memory); setOpened(true);
    setDraft(memory ? { id: memory.id, description: memory.description, type: memory.type, body: memory.body } : { id: '', description: '', type: projectPath ? 'project' : 'feedback', body: '' });
  }
  const list = <>
    <ListHeader query={query} onQuery={setQuery} placeholder="Search memories">
      <Button size="sm" aria-label="Add memory" disabled={!listing || !!draft} onClick={() => startDraft()}><Plus className="size-3.5" /><Label>New</Label></Button>
    </ListHeader>
    {listing?.problems.map(problem => <Panel key={problem} tone="attention" className="mb-2 break-all text-xs">{problem}</Panel>)}
    {!listing && !error && <ListEmpty>Loading…</ListEmpty>}
    {listing && groups.map(g => <ListGroup key={g.key} title={groups.length > 1 || projectPath ? g.title : undefined}>
      {g.memories.length === 0 && <li><ListEmpty>No {projectPath ? 'project' : 'global'} memories yet.</ListEmpty></li>}
      {g.memories.map(m => <ListRow key={key(m)} testId={`memory-${m.scope}-${m.id}`} title={m.id} subtitle={m.description} tone={g.editable ? 'good' : 'quiet'} stateLabel={typeNames[m.type] ?? m.type} showState selected={!draft && current === m} onSelect={() => { if (draft) return; setChosen(key(m)); setOpened(true); }} />)}
    </ListGroup>)}
    {listing && query && !everything.length && <ListEmpty>Nothing matches.</ListEmpty>}
  </>;
  const editor = draft && <section className="min-w-0" data-testid="memory-editor" aria-label={editing ? 'Edit memory' : 'New memory'}>
    <DetailHeader title={editing ? 'Edit memory' : 'New memory'} meta={<Badge variant="outline" size="sm">{projectPath ? 'This project' : 'All projects'}</Badge>} actions={<>
      <Button variant="ghost" size="sm" disabled={saving} onClick={() => { setDraft(undefined); setEditing(undefined); }}><X className="size-3.5 sm:hidden" /><Label>Cancel</Label></Button>
      <Button size="sm" disabled={saving || !valid} onClick={() => void send('PUT', { scope, memory: draft, ...(editing ? { previous_id: editing.id, revision: editing.revision } : {}) }, `Saved ${draft.id}.`, `${scope}-${draft.id}`)}><Save className="size-3.5" /><Label>{saving ? 'Saving…' : 'Save'}</Label></Button>
    </>} />
    <div className="space-y-4 pt-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1.5 text-sm"><span className="font-medium">ID</span><Input aria-label="Memory ID" className="font-mono" placeholder="e.g. owner-port" value={draft.id} onChange={e => setDraft({ ...draft, id: e.target.value })} /><span className="block text-xs text-t-muted">Lowercase letters, digits and hyphens.</span></label>
        <label className="block space-y-1.5 text-sm"><span className="font-medium">Description</span><Input aria-label="Memory description" placeholder="Short summary" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
      </div>
      <div className="space-y-1.5 text-sm"><span className="font-medium">Type</span><ToggleGroup type="single" variant="outline" size="sm" className="flex-wrap justify-start gap-1" aria-label="Memory type" value={draft.type} onValueChange={type => type && setDraft({ ...draft, type })}>{types.map(value => <ToggleGroupItem key={value} value={value}>{typeNames[value] ?? value}</ToggleGroupItem>)}</ToggleGroup><span className="block text-xs text-t-muted">{typeHints[draft.type]}</span></div>
      <label className="block space-y-1.5 text-sm"><span className="font-medium">Content</span><Textarea aria-label="Memory body" className="min-h-48 font-mono text-sm leading-relaxed" placeholder={'The fact.\nWhy: the reason.\nHow to apply: when it matters.'} value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} /></label>
    </div>
  </section>;
  const detail = <>
    <BackToList onBack={() => { setOpened(false); setDraft(undefined); setEditing(undefined); }} label="Memories" />
    {editor}
    {!draft && current && <article className="min-w-0" data-testid="memory-detail">
      <DetailHeader title={<span className="break-all">{current.id}</span>} meta={<><span>{typeNames[current.type] ?? current.type}</span><span>{current.scope === 'global' ? 'Global' : 'This project'}</span>{!editable && <span>Read-only</span>}</>} actions={editable ? <ActionBar disabled={saving} primary={{ label: 'Edit', icon: <Pencil className="size-3.5" />, run: () => startDraft(current) }} rest={[{ label: 'Delete', icon: <Trash2 className="size-3.5" />, destructive: true, run: () => setDeleting(current) }]} /> : undefined} />
      <div className="space-y-4 pt-4">
        <p className="text-sm text-t-secondary">{current.description}</p>
        <Document label={`${current.id} memory`}>{current.body}</Document>
        {!editable && <p className="text-sm"><Button mode="link" underlined="solid" size="inherit" asChild><a href="/settings?section=library&guidance=memory">Edit global memory</a></Button></p>}
      </div>
    </article>}
    {!draft && !current && listing && <DetailEmpty>No memories yet</DetailEmpty>}
  </>;
  return <section className="space-y-4" aria-label="Memories" data-testid="agent-memories">
    {error && <Panel role="alert" tone="danger" className="space-y-2 text-sm"><p>{error}</p><Button variant="outline" size="sm" onClick={() => { setDraft(undefined); setEditing(undefined); void load(); }}>Reload</Button></Panel>}
    {notice && <p role="status" className="text-sm text-t-secondary">{notice}</p>}
    <MasterDetail label="Memories" open={opened} list={list} detail={detail} />
    <AlertDialog open={!!deleting} onOpenChange={open => { if (!open && !saving) setDeleting(undefined); }}>
      <AlertDialogContent>
        <AlertDialogTitle>Delete memory {deleting?.id}?</AlertDialogTitle>
        <AlertDialogDescription>{projectPath ? 'It will be removed from this project.' : 'It will be removed from all projects.'} This can’t be undone.</AlertDialogDescription>
        <AlertDialogFooter><AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel><Button variant="destructive" disabled={saving} onClick={() => deleting && void send('DELETE', { scope: deleting.scope, id: deleting.id, revision: deleting.revision }, `Deleted ${deleting.id}.`)}>{saving ? 'Deleting…' : 'Delete'}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
