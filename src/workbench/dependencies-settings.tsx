"use client";

import { useCallback, useEffect, useState } from 'react';
import { Download, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { request } from '@/lib/api';
import { onBootstrap } from '@/workbench/live-wire';

interface ToolStatus {
  tool: 'git' | 'bd' | 'claude' | 'codex' | 'browser';
  requiredFor: string;
  found: boolean;
  path: string | null;
  version: string | null;
  ok: boolean;
  hint: string;
}

const docs: Record<ToolStatus['tool'], string> = {
  git: 'https://git-scm.com/downloads',
  bd: 'https://github.com/gastownhall/beads',
  claude: 'https://docs.anthropic.com/en/docs/claude-code',
  codex: 'https://developers.openai.com/codex/cli',
  browser: 'https://www.chromium.org/getting-involved/download-chromium/',
};

export function DependenciesSettings() {
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await request('/api/environment');
    if (!response.ok) throw new Error(await response.text());
    const rows = await response.json() as ToolStatus[];
    setTools(rows);
    setPaths(Object.fromEntries(rows.map((row) => [row.tool, row.path ?? ''])));
  }, []);

  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : String(e))); }, [load]);
  useEffect(() => {
    return onBootstrap((data) => {
      const update = JSON.parse(data) as { phase: string; detail: string };
      setProgress(update.detail);
      if (update.phase === 'complete') void load();
    });
  }, [load]);

  async function save(tool: string) {
    setBusy(tool); setError(null);
    try {
      const response = await request(`/api/environment/${tool}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: paths[tool]?.trim() || null }),
      });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? `Could not save ${tool}`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function installBd() {
    if (!window.confirm('Download the latest verified task tracker CLI and install it in ~/.beads/bin?')) return;
    setBusy('bd'); setError(null); setProgress('Starting tracker installation…');
    try {
      const response = await request('/api/environment/bd/install', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ consent: true }),
      });
      const answer = await response.json() as { error?: string };
      if (!response.ok) throw new Error(answer.error ?? 'Tracker installation failed');
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  if (!tools.length && !error) return <p className="text-sm text-t-tertiary">Checking this computer…</p>;
  return <div className="space-y-4">
    {tools.map((tool) => <div key={tool.tool} className="border-b border-b-default pb-4 last:border-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div><p className="font-medium capitalize text-t-secondary">{tool.tool}</p><p className="text-xs text-t-muted">For {tool.requiredFor} · {tool.version ?? (tool.found ? 'Found' : 'Not found')}</p></div>
        <a className="text-xs text-accent hover:underline" href={docs[tool.tool]} target="_blank" rel="noreferrer">Install guide <ExternalLink className="inline size-3" /></a>
      </div>
      <div className="mt-2 flex gap-2">
        <Input className="flex-1 font-mono" aria-label={`${tool.tool} path`} value={paths[tool.tool] ?? ''} placeholder="Search PATH automatically" onChange={(e) => setPaths((old) => ({ ...old, [tool.tool]: e.target.value }))} />
        <Button size="sm" variant="outline" disabled={busy === tool.tool} onClick={() => void save(tool.tool)}>Save</Button>
        {tool.tool === 'bd' && !tool.found && <Button size="sm" disabled={busy === 'bd'} onClick={() => void installBd()}>{busy === 'bd' ? <Loader2 className="animate-spin" /> : <Download />} Install</Button>}
      </div>
      {!tool.found && <p className="mt-1 text-xs text-danger">{tool.hint}</p>}
    </div>)}
    {progress && <p className="flex items-center gap-2 text-xs text-t-muted"><RefreshCw className={busy === 'bd' ? 'size-3 animate-spin' : 'size-3'} />{progress}</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
}
