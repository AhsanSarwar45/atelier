'use client';

import { useEffect, useState } from 'react';

import { FolderX } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { request } from '@/lib/api';
import { useSessionFacts } from '@/workbench/use-session';

/** Sent on `window` once a chat's deleted worktree is back or the chat moved. */
export const FOLDER_FIXED = 'atelier:chat-folder-fixed';

interface Tree {
  path: string;
  name: string;
}

async function send(command: Record<string, unknown>): Promise<unknown> {
  const response = await request('/api/workbench/command', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
  });
  const value = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok || value?.error) throw new Error(value?.error || 'The request failed');
  return value;
}

const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/**
 * What stands in for the Git tab and the chat box when the chat's worktree was
 * deleted: nothing can run in a folder that is gone, so the two ways forward
 * are to make it again or to take the chat somewhere that exists.
 */
export function WorktreeMissing({ sessionId, cwd, className }: {
  sessionId: string;
  /** The folder that is gone, when the caller knows it before the facts. */
  cwd?: string | null;
  className?: string;
}) {
  const facts = useSessionFacts(sessionId || null);
  const folder = facts?.cwd ?? cwd ?? '';
  const projectPath = facts?.projectPath ?? '';
  const [trees, setTrees] = useState<Tree[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectPath) return;
    void send({ type: 'worktrees.list', projectPath })
      .then((value) => {
        const listed = (value as { trees?: Tree[] } | null)?.trees;
        if (Array.isArray(listed)) setTrees(listed);
      })
      .catch(() => {});
  }, [projectPath]);

  const act = (command: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    void send(command)
      .then(() => window.dispatchEvent(new CustomEvent(FOLDER_FIXED, { detail: sessionId })))
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'The request failed'))
      .finally(() => setBusy(false));
  };
  // git may still list the deleted one; it is not somewhere to move to.
  const elsewhere = (trees ?? []).filter((tree) => tree.path !== folder);

  return (
    <div
      data-testid="worktree-missing"
      className={`flex min-w-0 flex-col items-center gap-3 px-4 py-6 text-center ${className ?? ''}`}
    >
      <FolderX className="size-6 text-t-faint" aria-hidden="true" />
      <div className="flex min-w-0 max-w-full flex-col gap-1">
        <p className="text-sm font-medium text-t-primary">Worktree deleted</p>
        {folder && <p className="truncate text-xs text-muted-foreground" title={folder}>{nameOf(folder)}</p>}
      </div>
      {sessionId && (
        <div className="flex flex-wrap justify-center gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !folder}
            onClick={() => act({
              type: 'session.restoreFolder',
              sessionId,
              branch: facts?.restoreBranch ?? nameOf(folder),
            })}
          >
            Recreate worktree
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={busy || elsewhere.length === 0}>Move chat</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center">
              {elsewhere.map((tree) => (
                <DropdownMenuItem key={tree.path} onSelect={() => act({ type: 'session.move', sessionId, cwd: tree.path })}>
                  {tree.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      {error && <p role="alert" className="max-w-full break-words text-xs text-danger">{error}</p>}
    </div>
  );
}
