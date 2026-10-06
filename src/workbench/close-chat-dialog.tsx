'use client';

/**
 * The window that closes a chat and asks what else to stop with it.
 *
 * Closing a chat kills its agent's process group and nothing more. A test
 * server whose shell exited, a pool of workers in a group of their own, a
 * container the chat started: each outlives the close and goes on holding
 * memory with nobody to stop it (bw-fbtyy.1). So the close lists everything
 * that still carries the chat's id, as a tree, everything ticked, and stops
 * what is still ticked when the close is confirmed.
 *
 * What sits in the agent's own group stops with the chat whatever is ticked,
 * so its box is ticked and cannot be cleared: a box that could be cleared
 * would promise something the close does not keep.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ChevronRight } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Spinner } from '@/components/ui/spinner';
import { request } from '@/lib/api';
import { cn } from '@/lib/utils';
import { memoryWords } from '@/workbench/memory-badge';
import { sendCommand } from '@/workbench/use-session';

export interface ChatProcess {
  pid: number;
  parentPid: number | null;
  name: string;
  command: string;
  bytes: number;
  startTime: number;
  role: 'agent' | 'subprocess';
  closesWithChat: boolean;
}

export interface ChatContainer {
  id: string;
  name: string;
  image: string;
  project: string | null;
}

export interface ChatRunning {
  processes: ChatProcess[];
  containers: ChatContainer[];
}

export interface RunningNode {
  key: string;
  label: string;
  detail?: string;
  bytes?: number;
  /** Stops with the chat whether ticked or not. */
  locked: boolean;
  children: RunningNode[];
}

const PROCESSES = 'group:processes';
const CONTAINERS = 'group:containers';

export const processKey = (pid: number) => `p:${pid}`;
export const containerKey = (id: string) => `c:${id}`;

/** The processes nested by parent, and the containers beside them. */
export function runningTree(running: ChatRunning): RunningNode[] {
  const pids = new Set(running.processes.map((p) => p.pid));
  const under = new Map<number | null, ChatProcess[]>();
  for (const process of running.processes) {
    const parent = process.parentPid !== null && pids.has(process.parentPid) ? process.parentPid : null;
    under.set(parent, [...(under.get(parent) ?? []), process]);
  }
  const node = (process: ChatProcess, seen: Set<number>): RunningNode => {
    seen.add(process.pid);
    return {
      key: processKey(process.pid),
      label: `${process.name} (${process.pid})`,
      detail: process.command || undefined,
      bytes: process.bytes,
      locked: process.role === 'agent' || process.closesWithChat,
      children: (under.get(process.pid) ?? []).filter((c) => !seen.has(c.pid)).map((c) => node(c, seen)),
    };
  };
  const tree: RunningNode[] = [];
  if (running.processes.length) {
    const seen = new Set<number>();
    tree.push({
      key: PROCESSES,
      label: 'Processes',
      locked: false,
      children: (under.get(null) ?? []).map((p) => node(p, seen)),
    });
  }
  if (running.containers.length) {
    tree.push({
      key: CONTAINERS,
      label: 'Docker containers',
      locked: false,
      children: running.containers.map((c) => ({
        key: containerKey(c.id),
        label: c.name,
        detail: c.project ? `${c.image} · ${c.project}` : c.image,
        locked: false,
        children: [],
      })),
    });
  }
  return tree;
}

/** Every key at or under `node` that a tick can change. */
function tickable(node: RunningNode): string[] {
  const own = node.locked || node.key.startsWith('group:') ? [] : [node.key];
  return [...own, ...node.children.flatMap(tickable)];
}

/** Every key a tick can change, which is what starts ticked. */
export function allTickable(tree: RunningNode[]): Set<string> {
  return new Set(tree.flatMap(tickable));
}

export type TickState = 'on' | 'off' | 'half';

export function tickState(node: RunningNode, ticked: ReadonlySet<string>): TickState {
  const keys = tickable(node);
  if (!keys.length) return 'on';
  const on = keys.filter((key) => ticked.has(key)).length;
  return on === keys.length ? 'on' : on === 0 ? 'off' : 'half';
}

/** Ticking a line ticks everything under it; clearing it clears them. */
export function flipTick(node: RunningNode, ticked: ReadonlySet<string>): Set<string> {
  const next = new Set(ticked);
  const keys = tickable(node);
  if (tickState(node, ticked) === 'on') keys.forEach((key) => next.delete(key));
  else keys.forEach((key) => next.add(key));
  return next;
}

interface Props {
  /** The chat being closed, or null when the window is shut. */
  chat: { sessionId: string; name: string } | null;
  onCancel: () => void;
  /** Whether the close is under way, so the row can say so. */
  onBusy?: (busy: boolean) => void;
  /** Called once the chat is closed, with any failures from stopping. */
  onClosed: (failures: string[]) => void;
}

export function CloseChatDialog({ chat, onCancel, onBusy, onClosed }: Props) {
  const sessionId = chat?.sessionId ?? null;
  const [running, setRunning] = useState<ChatRunning | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    setRunning(null);
    setLoadError(null);
    setFailed(null);
    setFolded(new Set());
    if (!sessionId) return;
    let live = true;
    void (async () => {
      try {
        const res = await request(`/api/workbench/session/${encodeURIComponent(sessionId)}/running`, {
          deadlineMs: 15_000,
        });
        if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
        const found = (await res.json()) as ChatRunning;
        if (!live) return;
        setRunning(found);
        setTicked(allTickable(runningTree(found)));
      } catch (e) {
        if (live) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId]);

  const tree = useMemo(() => (running ? runningTree(running) : []), [running]);

  const confirm = useCallback(async () => {
    if (!sessionId) return;
    setBusy(true);
    onBusy?.(true);
    setFailed(null);
    try {
      await sendCommand({ type: 'session.close', sessionId });
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      setBusy(false);
      onBusy?.(false);
      return;
    }
    const failures: string[] = [];
    const processes = (running?.processes ?? [])
      .filter((p) => ticked.has(processKey(p.pid)))
      .map((p) => ({ pid: p.pid, startTime: p.startTime }));
    const containers = (running?.containers ?? []).filter((c) => ticked.has(containerKey(c.id))).map((c) => c.id);
    if (processes.length || containers.length) {
      try {
        const res = await request(`/api/workbench/session/${encodeURIComponent(sessionId)}/running/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ processes, containers }),
          deadlineMs: 60_000,
        });
        if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
        failures.push(...(((await res.json()) as { failures?: string[] }).failures ?? []));
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    }
    setBusy(false);
    onClosed(failures);
  }, [sessionId, running, ticked, onBusy, onClosed]);

  const count = ticked.size;

  return (
    <AlertDialog open={chat !== null} onOpenChange={(open) => { if (!open && !busy) onCancel(); }}>
      <AlertDialogContent className="w-[90vw] gap-3 sm:max-w-xl" data-testid="close-chat-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Close chat?</AlertDialogTitle>
          <AlertDialogDescription className="break-words">
            {chat?.name ? `Closing “${chat.name}” stops its agent. ` : 'Closing stops the agent. '}
            Choose what else to stop.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="max-h-[50vh] min-h-16 overflow-auto rounded-md border border-b-subtle p-1" data-testid="close-chat-running">
          {!running && !loadError && (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-t-tertiary">
              <Spinner className="size-4" /> Looking for running processes…
            </div>
          )}
          {loadError && (
            <p className="px-2 py-3 text-sm text-destructive" data-testid="close-chat-load-error">
              Couldn’t list running processes: {loadError}
            </p>
          )}
          {running && !tree.length && (
            <p className="px-2 py-3 text-sm text-t-tertiary" data-testid="close-chat-nothing">
              Nothing else is running for this chat.
            </p>
          )}
          {tree.length > 0 && (
            <div role="tree" aria-label="Running for this chat" className="flex flex-col">
              {tree.map((node) => (
                <Line
                  key={node.key}
                  node={node}
                  depth={0}
                  ticked={ticked}
                  folded={folded}
                  disabled={busy}
                  onFold={(key) =>
                    setFolded((was) => {
                      const next = new Set(was);
                      if (!next.delete(key)) next.add(key);
                      return next;
                    })
                  }
                  onFlip={(target) => setTicked((was) => flipTick(target, was))}
                />
              ))}
            </div>
          )}
        </div>

        {failed && (
          <p className="text-sm text-destructive" data-testid="close-chat-error">
            {failed}
          </p>
        )}

        <AlertDialogFooter className="gap-2">
          <Button variant="ghost" disabled={busy} data-testid="close-chat-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} data-testid="close-chat-confirm" onClick={() => void confirm()}>
            {busy && <Spinner className="size-4" />}
            {count ? `Close and stop ${count}` : 'Close chat'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Line({
  node,
  depth,
  ticked,
  folded,
  disabled,
  onFold,
  onFlip,
}: {
  node: RunningNode;
  depth: number;
  ticked: ReadonlySet<string>;
  folded: ReadonlySet<string>;
  disabled: boolean;
  onFold: (key: string) => void;
  onFlip: (node: RunningNode) => void;
}) {
  const state = tickState(node, ticked);
  const branch = node.children.length > 0;
  const shut = folded.has(node.key);
  const fixed = node.locked && !tickable(node).length;
  const group = node.key.startsWith('group:');
  return (
    <>
      <div
        role="treeitem"
        aria-expanded={branch ? !shut : undefined}
        aria-selected={state !== 'off'}
        data-testid="close-chat-line"
        data-key={node.key}
        data-state={state}
        className="flex items-center gap-1.5 rounded px-1 py-1 text-sm hover:bg-surface-overlay"
        style={{ paddingLeft: `${depth * 0.9 + 0.25}rem` }}
      >
        {branch ? (
          <Button
            type="button"
            variant="dim"
            size="2xs"
            mode="icon"
            aria-label={shut ? `Expand ${node.label}` : `Collapse ${node.label}`}
            onClick={() => onFold(node.key)}
          >
            <ChevronRight className={cn('size-3.5 transition-transform', !shut && 'rotate-90')} />
          </Button>
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <Checkbox
          data-testid="close-chat-tick"
          checked={state === 'half' ? 'indeterminate' : state === 'on'}
          disabled={disabled || fixed}
          aria-label={node.label}
          onCheckedChange={() => onFlip(node)}
        />
        <div
          className={cn('flex min-w-0 flex-1 items-baseline gap-2', !fixed && !disabled && 'cursor-pointer')}
          onClick={() => {
            if (!fixed && !disabled) onFlip(node);
          }}
          title={node.detail}
        >
          <span className={cn('shrink-0', group && 'font-medium', state === 'off' && 'text-t-tertiary')}>
            {node.label}
          </span>
          {node.detail && <span className="min-w-0 truncate font-mono text-xs text-t-tertiary">{node.detail}</span>}
          <span className="ml-auto flex shrink-0 items-baseline gap-2 pl-2 text-xs text-t-tertiary">
            {node.locked && !group && <span data-testid="close-chat-locked">Stops with chat</span>}
            {node.bytes ? <span className="tabular-nums">{memoryWords(node.bytes)}</span> : null}
          </span>
        </div>
      </div>
      {branch &&
        !shut &&
        node.children.map((child) => (
          <Line
            key={child.key}
            node={child}
            depth={depth + 1}
            ticked={ticked}
            folded={folded}
            disabled={disabled}
            onFold={onFold}
            onFlip={onFlip}
          />
        ))}
    </>
  );
}
