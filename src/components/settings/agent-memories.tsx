'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Panel } from '@/components/ui/panel';
import { Picker } from '@/components/ui/picker';
import { Collapsible, CollapsibleContent, CollapsibleTriggerRow } from '@/components/ui/collapsible';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { request } from '@/lib/api';

type Scope = 'global' | 'project';
interface Memory { id: string; description: string; type: string; body: string }
interface Stored extends Memory { scope: Scope; revision: string; path: string }
interface Listing { global: Stored[]; project: Stored[] | null; problems: string[]; types: string[] }
const typeNames: Record<string, string> = { user: 'User', feedback: 'Feedback', project: 'Project', reference: 'Reference' };
const typeHints: Record<string, string> = {
  user: 'Who the user is: role, expertise, preferences.',
  feedback: 'Guidance on how agents should work, with the reason.',
  project: 'Ongoing goals or constraints the code does not show.',
  reference: 'Where to find something outside the repository.',
};

/** Atelier memory: one store every provider and chat reads, edited here or with `atelier tool memory`. */
export function AgentMemories({ projectPath, onChange }: { projectPath?: string; onChange?: () => void }) {
  const scope: Scope = projectPath ? 'project' : 'global';
  const url = `/api/settings/library/memories?${new URLSearchParams(projectPath ? { path: projectPath } : {})}`;
  const [listing, setListing] = useState<Listing>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Memory>();
  const [editing, setEditing] = useState<Stored>();
  const [deleting, setDeleting] = useState<Stored>();
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await request(url, { signal });
      if (!response.ok) throw new Error(await response.text());
      const next = await response.json();
      if (!signal?.aborted) { setListing(next); setError(''); }
    } catch (e) { if (!signal?.aborted) setError(String(e)); }
  }, [url]);
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  async function send(method: 'PUT' | 'DELETE', body: unknown, done: string) {
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await response.text());
      setListing(await response.json());
      setDraft(undefined); setEditing(undefined); setDeleting(undefined);
      setNotice(`${done} New and reconnected chats receive this change.`);
      onChange?.();
    } catch (e) { setError(String(e)); setDeleting(undefined); } finally { setSaving(false); }
  }
  const own = (projectPath ? listing?.project : listing?.global) ?? [];
  const inherited = projectPath ? listing?.global ?? [] : [];
  const types = listing?.types ?? Object.keys(typeNames);
  const valid = !!draft && /^[a-z0-9-]{1,80}$/.test(draft.id) && !!draft.description.trim() && !draft.description.includes('\n') && !!draft.body.trim();
  const card = (memory: Stored, editable: boolean) => <Panel key={`${memory.scope}-${memory.id}`} tone="frame" className="space-y-2" data-testid={`memory-${memory.scope}-${memory.id}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><h4 className="break-all font-medium">{memory.id}</h4><p className="text-sm text-t-secondary">{memory.description}</p></div>
      <Badge>{typeNames[memory.type] ?? memory.type}</Badge>
    </div>
    <Collapsible><CollapsibleTriggerRow size="sm">View memory</CollapsibleTriggerRow><CollapsibleContent asChild><pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-overlay p-3 text-xs">{memory.body}</pre></CollapsibleContent></Collapsible>
    {editable && <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={saving} onClick={() => { setError(''); setNotice(''); setEditing(memory); setDraft({ id: memory.id, description: memory.description, type: memory.type, body: memory.body }); }}>Edit</Button>
      <Button variant="destructive" size="sm" disabled={saving} onClick={() => setDeleting(memory)}>Delete</Button>
    </div>}
  </Panel>;
  return <section className="space-y-5" aria-label="Memories" data-testid="agent-memories">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <p className="max-w-md text-sm text-t-secondary">{projectPath
        ? 'Facts every chat in this project remembers, across every provider, account and worktree. Agents keep them with atelier tool memory.'
        : 'Facts every chat remembers, across every project, provider and account. Agents keep them with atelier tool memory instead of provider memory.'}</p>
      {!draft && <Button disabled={!listing} onClick={() => { setError(''); setNotice(''); setEditing(undefined); setDraft({ id: '', description: '', type: projectPath ? 'project' : 'feedback', body: '' }); }}><Plus className="mr-1 size-4" />Add memory</Button>}
    </div>
    {error && <Panel role="alert" tone="danger" className="text-sm">{error}<Button variant="ghost" onClick={() => { setDraft(undefined); setEditing(undefined); void load(); }}>Discard draft and reload</Button></Panel>}
    {notice && <p role="status" className="text-sm text-t-secondary">{notice}</p>}
    {listing?.problems.map(problem => <Panel key={problem} tone="attention" className="break-all text-sm">{problem}</Panel>)}
    {!listing && !error && <p>Loading memories…</p>}
    {draft && <Panel className="space-y-4" data-testid="memory-editor">
      <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{editing ? 'Edit memory' : 'New memory'}</h3><Badge>{projectPath ? 'This project' : 'All projects'}</Badge></div>
      <label className="block space-y-2 text-sm"><span className="font-medium">Identifier</span><Input aria-label="Memory ID" placeholder="e.g. owner-port" value={draft.id} onChange={e => setDraft({ ...draft, id: e.target.value })} /><span className="block text-xs text-t-muted">Lowercase letters, digits and hyphens. Agents use it with atelier tool memory.</span></label>
      <label className="block space-y-2 text-sm"><span className="font-medium">Description</span><Input aria-label="Memory description" placeholder="One line agents use to judge relevance" value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
      <div className="space-y-2 text-sm"><span className="font-medium">Type</span><Picker label="Memory type" value={draft.type} onChange={type => setDraft({ ...draft, type })} choices={types.map(value => ({ value, label: typeNames[value] ?? value }))} /><span className="block text-xs text-t-muted">{typeHints[draft.type]}</span></div>
      <label className="block space-y-2 text-sm"><span className="font-medium">Memory</span><Textarea aria-label="Memory body" className="min-h-40 font-mono text-sm" placeholder={'The fact.\nWhy: the reason.\nHow to apply: when it matters.'} value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} /></label>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={saving} onClick={() => { setDraft(undefined); setEditing(undefined); }}>Cancel</Button>
        <Button disabled={saving || !valid} onClick={() => void send('PUT', { scope, memory: draft, ...(editing ? { previous_id: editing.id, revision: editing.revision } : {}) }, `Saved ${draft.id}.`)}><Save className="mr-1 size-4" />{saving ? 'Saving…' : 'Save memory'}</Button>
      </div>
    </Panel>}
    {listing && !draft && <div className="space-y-3">
      {own.length === 0 && <Panel tone="frame" className="text-sm text-t-secondary">No {projectPath ? 'project' : 'global'} memories yet.</Panel>}
      {own.map(memory => card(memory, true))}
    </div>}
    {projectPath && listing && !draft && <section className="space-y-3 border-t border-border/60 pt-6" aria-label="Global memory">
      <div><h3 className="font-semibold">Global memory · {inherited.length}</h3><p className="mt-1 text-sm text-t-secondary">Read-only here. Every project receives these too.</p><p className="mt-2 text-sm"><Button mode="link" underlined="solid" size="inherit" asChild><a href="/settings?section=library&guidance=memory">Manage global memory</a></Button></p></div>
      {inherited.map(memory => card(memory, false))}
    </section>}
    <AlertDialog open={!!deleting} onOpenChange={open => { if (!open && !saving) setDeleting(undefined); }}>
      <AlertDialogContent>
        <AlertDialogTitle>Delete memory {deleting?.id}?</AlertDialogTitle>
        <AlertDialogDescription>{projectPath ? 'Chats in this project will no longer receive it.' : 'No chat in any project will receive it any more.'} There is no undo button. Existing chats keep their copy until they reconnect.</AlertDialogDescription>
        <AlertDialogFooter><AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel><Button variant="destructive" disabled={saving} onClick={() => deleting && void send('DELETE', { scope: deleting.scope, id: deleting.id, revision: deleting.revision }, `Deleted ${deleting.id}.`)}>{saving ? 'Please wait…' : 'Delete memory'}</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>;
}
