'use client';

/**
 * Where a new chat will work (bw-ov7a.3).
 *
 * A chat could only ever be started in the project's own root, so somebody
 * whose work happens in worktrees had to make the worktree in a terminal, and
 * then had no way to tell the app about it: the chat opened in the project and
 * every chip in the app went on naming the project. This is the choice itself
 * — the project, one of its worktrees, or a new worktree named here — and it
 * is the only place in the app that offers to make one.
 *
 * The decisions are separated from the drawing on purpose. What makes a choice
 * unstartable is a sentence the reader has to be shown, and it is the same
 * sentence the server would refuse with, so it is stated once and proved
 * without a screen.
 */

import { useEffect, useState } from 'react';
import { FolderGit2, GitBranch, Plus } from 'lucide-react';

import * as api from '@/lib/api';
import type { GitBranch as Branch, GitTree } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** The place a chat is to be started in, as the person has said it so far. */
export type Where =
  /** The project's own checkout, which is where every chat used to go. */
  | { kind: 'project' }
  /** A worktree that is already there, by the path git gave for it. */
  | { kind: 'existing'; path: string }
  /**
   * A worktree to be made first. `create` is whether the branch is a new one:
   * with it, `base` says where that branch starts, and without it `branch` is
   * a branch that already exists.
   */
  | { kind: 'new'; name: string; branch: string; create: boolean; base: string };

/**
 * A worktree's name is one plain folder name — the same rule the server holds
 * the name to, said here so the reader is stopped before the round trip.
 */
export function isPlainName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return false;
  return !/[\\/]/.test(trimmed);
}

/**
 * What stops this choice from being started, in words for the reader — and
 * `null` when nothing does.
 */
export function whatIsMissing(where: Where, trees: GitTree[]): string | null {
  if (where.kind === 'project') return null;
  if (where.kind === 'existing') {
    return trees.some((tree) => tree.path === where.path) ? null : 'Choose a worktree.';
  }
  const name = where.name.trim();
  if (!name) return 'Name the new worktree.';
  if (!isPlainName(name)) return "A worktree's name is one plain folder name.";
  if (trees.some((tree) => tree.name === name)) {
    return `There is already a worktree called ${name}.`;
  }
  if (!where.branch.trim()) return where.create ? 'Name the new branch.' : 'Choose a branch.';
  if (where.create && !isPlainName(where.branch.replace(/\//g, 'x'))) {
    return 'That is not a branch name.';
  }
  return null;
}

/**
 * The branch a new worktree gets when the person has not said otherwise: the
 * worktree's own name, which is how a worktree per piece of work is kept
 * straight — and it is only a suggestion, replaced the moment they type.
 */
export function suggestedBranch(name: string): string {
  return name.trim();
}

/** The worktrees a person can send a chat to: everything but the project. */
export function worktreesAmong(trees: GitTree[]): GitTree[] {
  return trees.filter((tree) => !tree.isMain);
}

/** The lines of work a new branch can start from, newest listing first. */
export function basesAmong(branches: Branch[]): Branch[] {
  return branches.filter((branch) => !branch.isRemote);
}

export function WhereToWork({
  projectPath,
  value,
  onChange,
  onMissing,
  disabled,
}: {
  projectPath: string;
  value: Where;
  onChange: (where: Where) => void;
  /**
   * What the choice still needs, whenever that changes — the button that
   * starts the chat lives outside this box and cannot ask git what worktrees
   * are there.
   */
  onMissing?: (missing: string | null) => void;
  disabled?: boolean;
}) {
  const [trees, setTrees] = useState<GitTree[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [current, setCurrent] = useState<string>('');
  /** Why the choices below are only "the project", when that is why. */
  const [unreadable, setUnreadable] = useState<string | null>(null);

  useEffect(() => {
    const stop = new AbortController();
    let live = true;
    Promise.all([
      api.git.trees(projectPath, stop.signal),
      api.git.branches(projectPath, stop.signal),
    ])
      .then(([checkouts, lines]) => {
        if (!live) return;
        setTrees(checkouts.trees);
        setBranches(lines.branches);
        setCurrent(lines.current);
        setUnreadable(null);
      })
      .catch((reason: unknown) => {
        if (!live || stop.signal.aborted) return;
        setUnreadable(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
      stop.abort();
    };
  }, [projectPath]);

  const project = trees.find((tree) => tree.isMain) ?? null;
  const worktrees = worktreesAmong(trees);
  const bases = basesAmong(branches);
  const missing = whatIsMissing(value, trees);
  useEffect(() => {
    onMissing?.(missing);
  }, [missing, onMissing]);

  // The three ways in. A project with no worktrees yet still offers to make
  // one — that is the whole point — but there is nothing to choose from.
  const modes = [
    { kind: 'project' as const, label: project?.name ?? 'The project', icon: <FolderGit2 className="size-3.5" /> },
    { kind: 'existing' as const, label: 'A worktree', icon: <GitBranch className="size-3.5" /> },
    { kind: 'new' as const, label: 'New worktree', icon: <Plus className="size-3.5" /> },
  ];

  function pick(kind: Where['kind']) {
    if (kind === value.kind) return;
    if (kind === 'project') onChange({ kind: 'project' });
    if (kind === 'existing') onChange({ kind: 'existing', path: worktrees[0]?.path ?? '' });
    if (kind === 'new') {
      onChange({ kind: 'new', name: '', branch: '', create: true, base: current || 'HEAD' });
    }
  }

  return (
    <section className="flex flex-col gap-2" data-testid="where-to-work">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Where it works
      </h3>
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="Where it works">
        {modes.map((mode) => (
          <Button
            key={mode.kind}
            type="button"
            size="sm"
            variant={value.kind === mode.kind ? 'primary' : 'outline'}
            disabled={disabled || (mode.kind === 'existing' && worktrees.length === 0)}
            data-testid={`where-${mode.kind}`}
            onClick={() => pick(mode.kind)}
          >
            {mode.icon}
            <span className="truncate">{mode.label}</span>
          </Button>
        ))}
      </div>

      {value.kind === 'existing' && (
        <Select
          value={value.path}
          onValueChange={(path) => onChange({ kind: 'existing', path })}
          disabled={disabled}
        >
          <SelectTrigger aria-label="Worktree" data-testid="where-worktree">
            <SelectValue placeholder="Choose a worktree" />
          </SelectTrigger>
          <SelectContent>
            {worktrees.map((tree) => (
              <SelectItem key={tree.path} value={tree.path}>
                {tree.name}
                {tree.branch ? ` · ${tree.branch}` : ''}
                {tree.dirty ? ' · changed' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {value.kind === 'new' && (
        <div className="flex flex-col gap-2">
          <Input
            aria-label="New worktree name"
            placeholder="What to call it"
            value={value.name}
            disabled={disabled}
            data-testid="where-new-name"
            // The branch follows the name until the person says otherwise, so
            // the ordinary case — one worktree, one branch, one name — is
            // typed once rather than twice.
            onChange={(event) => {
              const name = event.target.value;
              const followed = value.create && value.branch === suggestedBranch(value.name);
              onChange({
                ...value,
                name,
                branch: followed ? suggestedBranch(name) : value.branch,
              });
            }}
          />
          <div className="flex gap-2" role="group" aria-label="Its branch">
            <Button
              type="button"
              size="sm"
              variant={value.create ? 'primary' : 'outline'}
              disabled={disabled}
              data-testid="where-branch-new"
              onClick={() => onChange({ ...value, create: true, branch: suggestedBranch(value.name) })}
            >
              New branch
            </Button>
            <Button
              type="button"
              size="sm"
              variant={value.create ? 'outline' : 'primary'}
              disabled={disabled || bases.length === 0}
              data-testid="where-branch-existing"
              onClick={() => onChange({ ...value, create: false, branch: '' })}
            >
              A branch already there
            </Button>
          </div>
          {value.create ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                aria-label="New branch name"
                placeholder="Branch name"
                value={value.branch}
                disabled={disabled}
                data-testid="where-branch-name"
                onChange={(event) => onChange({ ...value, branch: event.target.value })}
              />
              <Select
                value={value.base}
                onValueChange={(base) => onChange({ ...value, base })}
                disabled={disabled}
              >
                <SelectTrigger aria-label="Starting from" data-testid="where-base" className="sm:w-48">
                  <SelectValue placeholder="Starting from" />
                </SelectTrigger>
                <SelectContent>
                  {bases.map((branch) => (
                    <SelectItem key={branch.name} value={branch.name}>
                      from {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <Select
              value={value.branch}
              onValueChange={(branch) => onChange({ ...value, branch })}
              disabled={disabled}
            >
              <SelectTrigger aria-label="Branch" data-testid="where-branch">
                <SelectValue placeholder="Choose a branch" />
              </SelectTrigger>
              <SelectContent>
                {bases.map((branch) => (
                  <SelectItem key={branch.name} value={branch.name}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {/* What the choice still needs, said where it is being made rather than
          after the button has been pressed. */}
      {missing && value.kind !== 'project' && (
        <p className="text-xs text-muted-foreground" data-testid="where-missing">
          {missing}
        </p>
      )}
      {unreadable && (
        <p className="text-xs text-muted-foreground" data-testid="where-unreadable">
          This project&apos;s worktrees could not be read, so a chat here works in the project
          itself: {unreadable}
        </p>
      )}
    </section>
  );
}
