'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Slot } from '@radix-ui/react-slot';
import { FolderGit2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Overlay, overlayPanel } from '@/components/ui/overlay';
import { Tooltip } from '@/components/ui/tooltip';
import { request } from '@/lib/api';
import { cn } from '@/lib/utils';

/** One checkout of the project, as `worktrees.list` answers. */
interface Worktree {
  path: string;
  name: string;
  branch: string | null;
  isMain: boolean;
  dirty: boolean;
  bytes: number;
  chats: Array<{ sessionId: string; title: string | null; state: string }>;
}

export function diskWords(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

async function send(command: Record<string, unknown>): Promise<unknown> {
  const response = await request('/api/workbench/command', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
  });
  const value = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok || value?.error) throw new Error(value?.error || 'The request failed');
  return value;
}

const chatTitle = (chat: Worktree['chats'][number]) => chat.title || 'Untitled chat';

/**
 * The chat's folder chip, opening the project's worktrees with their size,
 * branch and chats: the open chat can move to any of them, and any but the
 * project's own folder can be deleted. `children` is the chip, a button that
 * opens the list.
 */
export function WorktreeBadge({ sessionId, projectPath, cwd, onMoved, children }: {
  sessionId: string;
  projectPath: string;
  cwd: string;
  /** Called after this chat moved, so the header reads its folder again. */
  onMoved?: () => void;
  children: ReactNode;
}) {
  const [trees, setTrees] = useState<Worktree[] | null>(null);
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLElement>(null);
  const [deleting, setDeleting] = useState<Worktree | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = useCallback(() => {
    if (!projectPath) return;
    void send({ type: 'worktrees.list', projectPath })
      .then(value => { const listed = (value as { trees?: Worktree[] } | null)?.trees; if (Array.isArray(listed)) setTrees(listed); })
      .catch(() => {});
  }, [projectPath]);
  useEffect(() => { read(); }, [read, cwd]);

  const own = trees?.find(tree => tree.path === cwd)
    ?? trees?.filter(tree => cwd.startsWith(`${tree.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  // Not a git checkout, or not listed yet: the chip alone, with nothing to open.
  if (!trees || !own) return <>{children}</>;

  const act = (command: Record<string, unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    void send(command)
      .then(() => { after?.(); read(); })
      .catch(cause => setError(cause instanceof Error ? cause.message : 'The request failed'))
      .finally(() => setBusy(false));
  };
  const move = (tree: Worktree) => act({ type: 'session.move', sessionId, cwd: tree.path }, onMoved);
  const remove = (tree: Worktree, force: boolean) => act(
    { type: 'worktree.delete', projectPath, path: tree.path, force },
    () => { setDeleting(null); if (tree === own) onMoved?.(); },
  );

  const close = () => setOpen(false);
  return <>
    <Slot ref={chip} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setError(null); read(); setOpen(true); }}>{children}</Slot>
    {/* The panel the usage and token chips open: the whole screen on a phone. */}
    {open && <Overlay testId="worktree-popup" label="Worktrees" onClose={close} returnFocus={chip}>
      <div className={cn(overlayPanel, 'max-w-xl')}>
        <div className="flex items-center gap-2 border-b border-border/60 p-4">
          <h2 className="text-base font-semibold text-foreground">Worktrees</h2>
          <Button size="xs" mode="icon" variant="ghost" className="ml-auto" aria-label="Close" onClick={close}>
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 text-sm">
          {trees.map(tree => {
            const here = tree === own;
            return <div key={tree.path} data-testid="worktree-row" data-name={tree.name}
              className={`flex items-start gap-2 rounded px-1.5 py-1.5 ${here ? 'bg-muted/60' : 'hover:bg-muted/40'}`}>
              <FolderGit2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <Tooltip label={tree.path}><span tabIndex={0} className="truncate font-medium">{tree.name}</span></Tooltip>
                  {here && <span className="shrink-0 text-xs text-muted-foreground">This chat</span>}
                  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{diskWords(tree.bytes)}</span>
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {[tree.branch ?? 'Detached', tree.dirty ? 'Uncommitted changes' : null].filter(Boolean).join(' · ')}
                </div>
                {tree.chats.length > 0 && <div className="truncate text-xs text-muted-foreground">
                  {tree.chats.map(chatTitle).join(', ')}
                </div>}
                {(!here || !tree.isMain) && <div className="mt-1 flex gap-1">
                  {!here && <Button variant="outline" size="xs" disabled={busy} onClick={() => move(tree)}>Move here</Button>}
                  {!tree.isMain && <Button variant="ghost" size="xs" disabled={busy} className="text-destructive"
                    onClick={() => { setError(null); setDeleting(tree); }}>Delete</Button>}
                </div>}
              </div>
            </div>;
          })}
          {error && !deleting && <p className="px-2 py-1 text-xs text-destructive" role="alert">{error}</p>}
        </div>
      </div>
    </Overlay>}
    <AlertDialog open={deleting !== null} onOpenChange={open => { if (!open && !busy) setDeleting(null); }}>
      {deleting && <AlertDialogContent className="w-[90vw] gap-3 sm:max-w-md" data-testid="worktree-delete-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete worktree {deleting.name}?</AlertDialogTitle>
          <AlertDialogDescription className="break-words">
            The folder is removed. Its branch{deleting.branch ? ` ${deleting.branch}` : ''} is kept.
            {deleting.dirty && <> Its uncommitted changes will be lost.</>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {deleting.chats.length > 0 && <div className="text-sm">
          <p className="text-muted-foreground">These chats move to the project folder:</p>
          <ul className="mt-1 list-disc pl-5">{deleting.chats.map(chat => <li key={chat.sessionId}>{chatTitle(chat)}</li>)}</ul>
        </div>}
        {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
        <AlertDialogFooter className="gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => remove(deleting, deleting.dirty)}>
            {deleting.dirty ? 'Delete anyway' : 'Delete worktree'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>}
    </AlertDialog>
  </>;
}
