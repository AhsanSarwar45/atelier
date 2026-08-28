'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Copy, ExternalLink, FileCode2, FolderOpen, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ReadFailed } from '@/components/ui/read-failed';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { fs } from '@/lib/api';
import { NOT_PHONE_SCREEN } from '@/lib/screen-width';
import { cn } from '@/lib/utils';
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
  size: number;
  modifiedAt: string;
  symlinkTarget?: string;
}

const CATEGORY: Record<AgentFileRow['category'], string> = {
  instructions: 'Instructions', settings: 'Settings', agents: 'Agents', commands: 'Commands',
  skills: 'Skills', 'output-styles': 'Output styles', rules: 'Rules',
};

function parentOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash <= 0 ? path : path.slice(0, slash);
}

export function AgentFilesBrowser({ projects }: { projects: { id: string; name: string; path: string }[] }) {
  const [projectId, setProjectId] = useState('none');
  const [files, setFiles] = useState<AgentFileRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | AgentFileRow['scope']>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { toast } = useToast();
  const projectPath = projects.find((project) => project.id === projectId)?.path;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    void sendCommand<{ files: AgentFileRow[] }>({ type: 'agent-files.list', ...(projectPath ? { projectPath } : {}) })
      .then(({ files: found }) => {
        if (!live) return;
        setFiles(found);
        setSelected((before) => {
          if (found.some((file) => file.id === before)) return before;
          const wide = typeof window.matchMedia !== 'function' || window.matchMedia(NOT_PHONE_SCREEN).matches;
          return wide ? (found.find((file) => file.category === 'instructions') ?? found[0])?.id ?? null : null;
        });
      })
      .catch((reason: unknown) => live && setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [projectPath, attempt]);

  const chosen = files.find((file) => file.id === selected) ?? null;
  useEffect(() => {
    if (!chosen) { setContent(''); return; }
    let live = true;
    setError(null);
    void sendCommand<{ content: string; truncated: boolean }>({ type: 'agent-files.read', path: chosen.path, ...(projectPath ? { projectPath } : {}) })
      .then((read) => { if (live) { setContent(read.content); setTruncated(read.truncated); } })
      .catch((reason: unknown) => live && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { live = false; };
  }, [chosen?.id, chosen?.path, projectPath]);

  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    return files.filter((file) => (scope === 'all' || file.scope === scope) && (!wanted || `${file.name} ${file.relativePath} ${file.path} ${CATEGORY[file.category]}`.toLowerCase().includes(wanted)));
  }, [files, query, scope]);

  const grouped = useMemo(() => ['claude', 'codex'].map((provider) => ({
    provider: provider as AgentFileRow['provider'],
    categories: Object.keys(CATEGORY).map((category) => ({ category: category as AgentFileRow['category'], files: shown.filter((file) => file.provider === provider && file.category === category) })).filter((group) => group.files.length),
  })).filter((group) => group.categories.length), [shown]);

  async function outside(path: string, target: 'finder' | 'vscode' | 'cursor', success: string) {
    try { await fs.openExternal(path, target); toast({ title: success }); }
    catch (reason) { toast({ title: 'Could not open the file', description: reason instanceof Error ? reason.message : String(reason), variant: 'destructive' }); }
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden border-t border-border/50 md:grid-cols-[22rem_minmax(0,1fr)]">
      <aside className={cn('min-h-0 overflow-y-auto border-r border-border/50 bg-surface-base', chosen && 'hidden md:block')} aria-label="Agent files">
        <div className="sticky top-0 z-10 space-y-3 border-b border-border/50 bg-surface-base/95 p-4 backdrop-blur">
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger aria-label="Project scope"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="none">Personal files only</SelectItem>{projects.map((project) => <SelectItem key={project.id} value={project.id}>Personal + {project.name}</SelectItem>)}</SelectContent>
          </Select>
          <div className="relative"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-t-muted" /><Input aria-label="Search agent files" placeholder="Search files…" value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" /></div>
          <div className="flex gap-1" aria-label="Filter by scope">{(['all', 'personal', 'project', 'project-local'] as const).map((value) => <Button key={value} size="xs" variant={scope === value ? 'mono' : 'ghost'} onClick={() => setScope(value)}>{value === 'all' ? 'All' : value === 'project-local' ? 'Local' : value[0].toUpperCase() + value.slice(1)}</Button>)}</div>
        </div>
        {loading ? <p className="p-6 text-sm text-t-muted">Looking for agent files…</p> : error && files.length === 0 ? <ReadFailed className="m-4" what="Agent files could not be read." why={error} onRetry={() => setAttempt((n) => n + 1)} /> : shown.length === 0 ? <div className="p-8 text-center"><FileCode2 className="mx-auto mb-3 size-7 text-t-muted" /><p className="text-sm text-t-secondary">No agent files found</p><p className="mt-1 text-xs text-t-muted">Only existing provider files are shown.</p></div> : (
          <div className="p-2">{grouped.map((provider) => <section key={provider.provider} className="mb-4"><h2 className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-t-muted">{provider.provider === 'claude' ? 'Claude' : 'Codex'}</h2>{provider.categories.map((group) => <div key={group.category} className="mb-2"><div className="flex items-center gap-2 px-2 py-1 text-xs font-medium text-t-tertiary"><span>{CATEGORY[group.category]}</span>{group.category === 'commands' && <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[10px]">Legacy</span>}<span className="ml-auto tabular-nums text-t-muted">{group.files.length}</span></div>{group.files.map((file) => <Button key={file.id} type="button" variant="ghost" onClick={() => setSelected(file.id)} className={cn('h-auto w-full justify-start gap-3 px-2 py-2 text-left', selected === file.id && 'bg-surface-overlay text-t-primary')}><FileCode2 className="size-4 shrink-0 text-t-muted" /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{file.name}</span><span className="block truncate text-xs text-t-muted">{file.scope === 'project-local' ? 'Project local' : file.scope[0].toUpperCase() + file.scope.slice(1)} · {file.relativePath}</span></span><ChevronRight className="size-4 shrink-0 text-t-muted" /></Button>)}</div>)}</section>)}</div>
        )}
      </aside>
      <main className={cn('min-h-0 flex-col overflow-hidden bg-surface-base', chosen ? 'flex' : 'hidden md:flex')}>
        {!chosen ? <div className="m-auto text-center text-t-muted"><FileCode2 className="mx-auto mb-3 size-8" /><p className="text-sm">Select a file to read it.</p></div> : <>
          <header className="flex flex-wrap items-start gap-3 border-b border-border/50 px-4 py-3 sm:px-6"><Button variant="ghost" size="sm" className="md:hidden" onClick={() => setSelected(null)}>Files</Button><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="truncate text-base font-semibold text-t-primary">{chosen.name}</h2><span className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] uppercase text-t-muted">{chosen.format}</span></div><p className="mt-1 truncate font-mono text-xs text-t-muted" title={chosen.path}>{chosen.path}</p>{chosen.symlinkTarget && <p className="mt-1 truncate text-xs text-t-muted">Links to {chosen.symlinkTarget}</p>}</div><div className="flex shrink-0 gap-1"><Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(chosen.path).then(() => toast({ title: 'Path copied' }))}><Copy /> Copy path</Button><Button size="sm" variant="outline" aria-label="Reveal in file manager" onClick={() => void outside(parentOf(chosen.path), 'finder', 'Opened file location')}><FolderOpen /></Button><Button size="sm" onClick={() => void outside(chosen.path, 'finder', 'Opened in external editor')}><ExternalLink /> Open in editor</Button></div></header>
          {error && <div className="border-b border-danger/30 bg-danger/10 px-6 py-2 text-sm text-danger">{error}</div>}
          {truncated && <div className="border-b border-amber-500/30 bg-amber-500/10 px-6 py-2 text-xs text-t-secondary">Preview limited to the first 2 MB. Open the file externally to read the rest.</div>}
          <div className="min-h-0 flex-1 overflow-auto"><pre className="min-h-full p-5 font-mono text-[13px] leading-6 text-t-secondary sm:p-7"><code>{content}</code></pre></div>
          <footer className="flex items-center justify-between border-t border-border/50 px-4 py-2 text-xs text-t-muted"><span>{CATEGORY[chosen.category]} · {chosen.scope === 'project-local' ? 'Project local' : chosen.scope}</span><span>{chosen.size.toLocaleString()} bytes · {new Date(chosen.modifiedAt).toLocaleString()}</span></footer>
        </>}
      </main>
    </div>
  );
}
