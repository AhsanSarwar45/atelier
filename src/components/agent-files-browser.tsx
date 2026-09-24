/**
 * The files an agent reads: instructions, settings, skills, agents, rules.
 * Under Settings it shows one account's own files; under a project's settings
 * it shows that project's files. Each file opens in an editor and is saved
 * back to where it came from; well-known files that do not exist yet can be
 * created (bw-2t1c.9, bw-76eu.3).
 */
'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ChevronLeft, ChevronRight, Copy, ExternalLink, FileCode2, FilePlus2, FolderOpen, Loader2, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter } from '@/components/ui/alert-dialog';
import { PointerAnchor, type PointerAt } from '@/workbench/menu-anchor';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { ReadFailed } from '@/components/ui/read-failed';
import { Row } from '@/components/ui/row';
import { Tooltip } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import { fs } from '@/lib/api';
import { NOT_PHONE_SCREEN } from '@/lib/screen-width';
import { cn } from '@/lib/utils';
// CodeMirror is fetched when a file is opened for editing, not with the list (bw-fbzd.4).
const CodeEditor = dynamic(() => import('@/workbench/code-editor').then((m) => m.CodeEditor), { ssr: false });
import { sendCommand } from '@/workbench/use-session';

export interface AgentFileRow {
  id: string;
  provider: 'claude' | 'codex';
  scope: 'personal' | 'project' | 'project-local';
  category: 'instructions' | 'settings' | 'agents' | 'commands' | 'skills' | 'output-styles' | 'rules';
  name: string;
  path: string;
  relativePath: string;
  format: 'markdown' | 'json' | 'toml' | 'yaml' | 'text';
  legacy?: boolean;
  /**
   * The directory is the same whichever account is chosen.
   *
   * Codex keeps its personal skills under `$HOME/.agents`, which `CODEX_HOME`
   * does not move, so every Codex account on the computer has the same ones.
   * Every other personal row does follow the account, so without a word here
   * this one read as the chosen account's own (bw-6ecp.15).
   */
  shared?: boolean;
  size: number;
  modifiedAt: string;
  symlinkTarget?: string;
}

/** A well-known file that is not there yet and can be made from here. */
export interface CreatableFile {
  provider: 'claude' | 'codex';
  scope: 'personal' | 'project' | 'project-local';
  category: 'instructions' | 'settings';
  name: string;
  path: string;
  format: 'markdown' | 'json' | 'toml';
}

const CATEGORY: Record<AgentFileRow['category'], string> = {
  instructions: 'Instructions', settings: 'Settings', agents: 'Agents', commands: 'Commands',
  skills: 'Skills', 'output-styles': 'Output styles', rules: 'Rules',
};

function scopeName(scope: AgentFileRow['scope']): string {
  return scope === 'project-local' ? 'Project local' : scope[0].toUpperCase() + scope.slice(1);
}

function said(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function AgentFilesBrowser({
  profileId,
  brand,
  projectPath,
}: {
  /** Whose files. Nothing means the account the server booted with. */
  profileId?: string | null;
  /** Only this provider's files, when the browser is inside a provider's section. */
  brand?: 'claude' | 'codex';
  /** This project's files, and only those, when the browser is inside a project's settings. */
  projectPath?: string;
}) {
  const [files, setFiles] = useState<AgentFileRow[]>([]);
  const [creatable, setCreatable] = useState<CreatableFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [menu, setMenu] = useState<{ file: AgentFileRow; at: PointerAt } | null>(null);
  const [deleting, setDeleting] = useState<AgentFileRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const keepSelectionEmpty = useRef(false);
  const { toast } = useToast();
  const dirty = draft !== content;
  const scoped = useMemo(
    () => ({ ...(projectPath ? { projectPath } : {}), ...(profileId ? { profileId } : {}) }),
    [projectPath, profileId],
  );

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    void sendCommand<{ files: AgentFileRow[]; creatable?: CreatableFile[] }>({ type: 'agent-files.list', ...scoped })
      .then(({ files: found, creatable: missing }) => {
        if (!live) return;
        // A project's browser is about the project; the account's files have their own screen.
        const here = (file: { provider: string; scope: string }) =>
          (!brand || file.provider === brand) && (projectPath ? file.scope !== 'personal' : file.scope === 'personal');
        const mine = found.filter(here);
        setFiles(mine);
        setCreatable((missing ?? []).filter(here));
        setSelected((before) => {
          if (keepSelectionEmpty.current) return null;
          if (mine.some((file) => file.id === before)) return before;
          const wide = typeof window.matchMedia !== 'function' || window.matchMedia(NOT_PHONE_SCREEN).matches;
          return wide ? (mine.find((file) => file.category === 'instructions') ?? mine[0])?.id ?? null : null;
        });
      })
      .catch((reason: unknown) => live && setError(said(reason)))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [scoped, brand, projectPath, attempt]);

  useEffect(() => {
    setMenu(null); setDeleting(null); setDeleteError(null);
    keepSelectionEmpty.current = false;
  }, [scoped, brand]);

  async function deleteFile() {
    if (!deleting || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await sendCommand({ type: 'agent-files.delete', path: deleting.path, ...scoped });
      if (selected === deleting.id) {
        keepSelectionEmpty.current = true;
        setSelected(null);
      }
      setFiles((before) => before.filter((file) => file.id !== deleting.id));
      setDeleting(null);
      setAttempt((n) => n + 1);
      toast({ title: `Deleted ${deleting.name}`, description: 'The file was permanently deleted.' });
    } catch (reason) {
      setDeleteError(said(reason));
    } finally {
      setDeleteBusy(false);
    }
  }

  const chosen = files.find((file) => file.id === selected) ?? null;
  useEffect(() => {
    if (!chosen) { setContent(''); setDraft(''); return; }
    let live = true;
    setError(null);
    void sendCommand<{ content: string; truncated: boolean }>({ type: 'agent-files.read', path: chosen.path, ...scoped })
      .then((read) => { if (live) { setContent(read.content); setDraft(read.content); setTruncated(read.truncated); } })
      .catch((reason: unknown) => live && setError(said(reason)));
    return () => { live = false; };
  }, [chosen?.id, chosen?.path, scoped]);

  const save = useCallback(async () => {
    if (!chosen || !dirty || truncated) return;
    setSaving(true);
    setError(null);
    try {
      await sendCommand({ type: 'agent-files.write', path: chosen.path, content: draft, ...scoped });
      setContent(draft);
      toast({ title: `Saved ${chosen.name}` });
    } catch (reason) {
      setError(said(reason));
    } finally {
      setSaving(false);
    }
  }, [chosen, dirty, truncated, draft, scoped, toast]);

  const create = useCallback(
    async (file: CreatableFile) => {
      setError(null);
      try {
        await sendCommand({ type: 'agent-files.write', path: file.path, content: '', ...scoped });
        setAttempt((n) => n + 1);
        toast({ title: `Created ${file.name}` });
      } catch (reason) {
        setError(said(reason));
      }
    },
    [scoped, toast],
  );

  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    return files.filter((file) => !wanted || `${file.name} ${file.relativePath} ${file.path} ${CATEGORY[file.category]}`.toLowerCase().includes(wanted));
  }, [files, query]);

  const grouped = useMemo(() => ['claude', 'codex'].map((provider) => ({
    provider: provider as AgentFileRow['provider'],
    categories: Object.keys(CATEGORY).map((category) => ({ category: category as AgentFileRow['category'], files: shown.filter((file) => file.provider === provider && file.category === category) })).filter((group) => group.files.length),
    missing: creatable.filter((file) => file.provider === provider),
  })).filter((group) => group.categories.length || group.missing.length), [shown, creatable]);

  async function outside(path: string, target: 'finder' | 'vscode' | 'cursor', success: string) {
    try { await fs.openExternal(path, target); toast({ title: success }); }
    catch (reason) { toast({ title: 'Couldn’t open file', description: said(reason), variant: 'destructive' }); }
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden border-t border-border/50 md:grid-cols-[22rem_minmax(0,1fr)]" data-testid="agent-files">
      <aside className={cn('min-h-0 overflow-y-auto border-r border-border/50 bg-surface-base', chosen && 'hidden md:block')} aria-label="Agent files"
        onContextMenu={(event) => {
          const row = (event.target as HTMLElement).closest<HTMLElement>('[data-testid^="agent-file-"]');
          const file = files.find((candidate) => row?.dataset.testid === `agent-file-${candidate.name}` && row.dataset.filePath === candidate.path);
          if (!file) return;
          event.preventDefault();
          setMenu({ file, at: { left: event.clientX, top: event.clientY } });
        }}
        onClick={() => { keepSelectionEmpty.current = false; }}
      >
        <div className="sticky top-0 z-10 border-b border-border/50 bg-surface-base/95 p-4 backdrop-blur">
          <div className="relative"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-t-muted" /><Input aria-label="Search agent files" placeholder="Search files…" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" /></div>
        </div>
        {loading ? <p className="p-6 text-sm text-t-muted">Loading…</p> : error && files.length === 0 ? <ReadFailed className="m-4" what="Couldn’t load agent files." why={error} onRetry={() => setAttempt((n) => n + 1)} /> : grouped.length === 0 ? <div className="p-8 text-center"><FileCode2 className="mx-auto mb-3 size-7 text-t-muted" /><p className="text-sm text-t-secondary">No agent files</p></div> : (
          <div className="p-2">{grouped.map((provider) => <section key={provider.provider} className="mb-4">{!brand && <h2 className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-t-muted">{provider.provider === 'claude' ? 'Claude' : 'Codex'}</h2>}{provider.categories.map((group) => <div key={group.category} className="mb-2"><div className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-t-tertiary"><span>{CATEGORY[group.category]}</span>{group.category === 'commands' && <Badge variant="secondary" size="xs">Legacy</Badge>}{group.files.every((file) => file.shared) && <Tooltip label="Shared by all accounts"><Badge variant="secondary" size="xs" data-testid={`agent-files-shared-${group.category}`}>Shared</Badge></Tooltip>}<span className="ml-auto tabular-nums text-t-muted">{group.files.length}</span></div>{group.files.map((file) => <Row key={file.id} gap="lg" inset="sm" radius="md" selected={selected === file.id} data-testid={`agent-file-${file.name}`} data-file-path={file.path} onClick={() => setSelected(file.id)}><FileCode2 className="size-4 shrink-0 text-t-muted" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{file.name}</span>{(projectPath || file.relativePath !== file.name) && <span className="block truncate text-xs text-t-muted">{projectPath ? `${scopeName(file.scope)} · ` : ''}{file.relativePath}</span>}</span><ChevronRight className="size-4 shrink-0 text-t-muted" /></Row>)}</div>)}
            {provider.missing.length > 0 && <div className="mb-2"><div className="px-2 py-1 text-xs font-medium text-t-tertiary">Available to create</div>{provider.missing.map((file) => <Row key={file.path} gap="lg" inset="sm" radius="md" data-testid={`agent-file-create-${file.name}`} onClick={() => void create(file)} className="text-t-secondary"><FilePlus2 className="size-4 shrink-0 text-t-muted" /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{file.name}</span><span className="block truncate text-xs text-t-muted">{projectPath ? `Create · ${scopeName(file.scope)}` : 'Create'}</span></span></Row>)}</div>}
          </section>)}</div>
        )}
      </aside>
      <main className={cn('min-h-0 flex-col overflow-hidden bg-surface-base', chosen ? 'flex' : 'hidden md:flex')}>
        {!chosen ? <div className="m-auto text-center text-t-muted"><FileCode2 className="mx-auto mb-3 size-8" /><p className="text-sm">No file selected</p></div> : <>
          <header className="flex items-start gap-2 border-b border-border/50 px-4 py-3 sm:gap-3 sm:px-6"><Button variant="ghost" size="sm" aria-label="All files" className="-ml-2 shrink-0 md:hidden" onClick={() => setSelected(null)}><ChevronLeft /></Button><div className="min-w-0 flex-1"><div className="flex flex-wrap items-baseline gap-2"><h2 className="break-all text-base font-semibold text-t-primary" data-testid="agent-file-name">{chosen.name}</h2>{dirty && <span className="text-xs text-amber-500" data-testid="agent-file-dirty">Unsaved</span>}</div><Tooltip label={chosen.path}><p className="mt-1 truncate font-mono text-xs text-t-muted">{chosen.path}</p></Tooltip>{chosen.symlinkTarget && <p className="mt-1 truncate text-xs text-t-muted">Links to {chosen.symlinkTarget}</p>}</div><div className="flex shrink-0 gap-1"><Button size="sm" variant="outline" aria-label="Copy path" onClick={() => void navigator.clipboard.writeText(chosen.path).then(() => toast({ title: 'Path copied' }))}><Copy /></Button><Button size="sm" variant="outline" aria-label="Reveal in file manager" onClick={() => void outside(chosen.path, 'finder', 'Opened file location')}><FolderOpen /></Button><Button size="sm" variant="outline" aria-label="Open in external editor" onClick={() => void outside(chosen.path, 'vscode', 'Opened in external editor')}><ExternalLink /></Button><Button size="sm" data-testid="agent-file-save" disabled={!dirty || saving || truncated} onClick={() => void save()}>{saving ? <Loader2 className="animate-spin" /> : null} Save</Button></div></header>
          {error && <Panel shape="strip" tone="danger" className="px-6 text-sm text-danger">{error}</Panel>}
          {truncated && <Panel shape="strip" tone="attention" className="px-6 text-xs text-t-secondary">First 2 MB, read only</Panel>}
          <div className="min-h-0 flex-1 overflow-auto" data-testid="agent-file-editor"><CodeEditor text={content} path={chosen.path} editable={!truncated} onChange={setDraft} onSave={() => void save()} className="min-h-full" /></div>
          <footer className="flex items-center justify-between border-t border-border/50 px-4 py-2 text-xs text-t-muted"><span>{CATEGORY[chosen.category]} · {chosen.shared ? 'Shared' : scopeName(chosen.scope)}</span><span>{chosen.size.toLocaleString()} bytes · {new Date(chosen.modifiedAt).toLocaleString()}</span></footer>
        </>}
      </main>
      <DropdownMenu open={menu !== null} onOpenChange={(open) => { if (!open) setMenu(null); }}>
        <PointerAnchor at={menu?.at ?? null} />
        <DropdownMenuContent align="start" collisionPadding={8}>
          <DropdownMenuItem className="text-danger" onSelect={() => { setDeleting(menu?.file ?? null); setDeleteError(null); setMenu(null); }}>Delete file…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={deleting !== null} onOpenChange={(open) => { if (!open && !deleteBusy) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Permanently delete this file? This cannot be undone.
            <span className="mt-2 block break-all font-mono text-xs">{deleting?.path}</span>
            {deleting?.category === 'skills' && <span className="mt-2 block">Only SKILL.md is deleted; supporting files remain.</span>}
            {deleting?.symlinkTarget && <span className="mt-2 block">Only the symbolic link is removed, not its target.</span>}
            {deleting?.id === selected && dirty && <span className="mt-2 block">Unsaved edits will be discarded.</span>}
          </AlertDialogDescription>
          {deleteError && <p role="alert" className="text-sm text-danger">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={deleteBusy} onClick={() => void deleteFile()}>{deleteBusy ? 'Deleting…' : 'Delete file'}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
