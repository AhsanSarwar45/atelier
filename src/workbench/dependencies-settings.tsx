"use client";

import { Fragment, useCallback, useEffect, useState } from 'react';

import { ExternalLink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { request } from '@/lib/api';

interface ToolStatus {
  tool: 'git' | 'claude' | 'codex' | 'browser';
  requiredFor: string;
  found: boolean;
  path: string | null;
  version: string | null;
  ok: boolean;
  hint: string;
}

const docs: Record<ToolStatus['tool'], string> = {
  git: 'https://git-scm.com/downloads',
  claude: 'https://docs.anthropic.com/en/docs/claude-code',
  codex: 'https://developers.openai.com/codex/cli',
  browser: 'https://www.chromium.org/getting-involved/download-chromium/',
};

export function DependenciesSettings() {
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await request('/api/environment');
    if (!response.ok) throw new Error(await response.text());
    const rows = await response.json() as ToolStatus[];
    setTools(rows);
    setPaths(Object.fromEntries(rows.map((row) => [row.tool, row.path ?? ''])));
  }, []);

  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : String(e))); }, [load]);

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

  if (!tools.length && !error) return <p className="text-sm text-t-tertiary">Checking this computer…</p>;
  return <div className="space-y-4">
    {tools.map((tool, index) => <Fragment key={tool.tool}>{index > 0 && <Separator />}<div>
      <div className="flex items-start justify-between gap-3">
        <div><p className="font-medium capitalize text-t-secondary">{tool.tool}</p><p className="text-xs text-t-muted">For {tool.requiredFor} · {tool.version ?? (tool.found ? 'Found' : 'Not found')}</p></div>
        <Button variant="primary" mode="link" underline="solid" size="sm" asChild><a href={docs[tool.tool]} target="_blank" rel="noreferrer">Install guide <ExternalLink className="size-3" /></a></Button>
      </div>
      <div className="mt-2 flex gap-2">
        <Input className="flex-1 font-mono" aria-label={`${tool.tool} path`} value={paths[tool.tool] ?? ''} placeholder="Search PATH automatically" onChange={(e) => setPaths((old) => ({ ...old, [tool.tool]: e.target.value }))} />
        <Button size="sm" variant="outline" disabled={busy === tool.tool} onClick={() => void save(tool.tool)}>Save</Button>
      </div>
      {!tool.found && <p className="mt-1 text-xs text-danger">{tool.hint}</p>}
    </div></Fragment>)}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </div>;
}
