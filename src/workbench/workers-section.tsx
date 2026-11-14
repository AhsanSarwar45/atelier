'use client';

/**
 * The orchestrator side of worker chats in the chat's details
 * (docs/designs/orchestrator-workers.md, How it looks): an orchestrator lists
 * the workers it started, each opening its own chat, with one button that
 * stops them all; a worker links back to the chat that started it.
 *
 * Read from the same list the chat sidebar draws, so a worker is named the
 * same in both, and its state follows the live stream between reads.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { addressWith } from '@/lib/address';
import { request } from '@/lib/api';
import { BrandIcon } from '@/workbench/brand-icon';
import { useLiveSessions } from '@/workbench/live';
import type { RestoreRow, SessionState } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

/** Mid-turn, as the server counts it (status::is_mid_turn). */
const MID_TURN: readonly SessionState[] = ['starting', 'thinking', 'streaming', 'running_tool', 'waiting_permission', 'summarising'];

function stateWord(state: SessionState): string {
  if (MID_TURN.includes(state)) return 'Working';
  if (state === 'errored') return 'Error';
  if (state === 'stopped') return 'Stopped';
  return 'Idle';
}

/** The project's chats, read once per chat opened and again when one of its workers changes. */
function useProjectRows(projectId: string, projectPath: string, sessionId: string, liveKey: string): RestoreRow[] {
  const [rows, setRows] = useState<RestoreRow[]>([]);
  useEffect(() => {
    if (!projectId || !sessionId) return;
    let current = true;
    const q = new URLSearchParams({ project: projectId, path: projectPath, local: '1' });
    request(`/api/workbench/restore?${q}`)
      .then(async (res) => {
        if (res.ok && current) setRows((await res.json()) as RestoreRow[]);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [projectId, projectPath, sessionId, liveKey]);
  return rows;
}

export interface WorkerLinks {
  /** This chat's workers, newest first, when it is an orchestrator. */
  workers: RestoreRow[];
  /** The chat that started this one, when it is a worker. */
  orchestrator: RestoreRow | null;
}

export function useWorkerLinks(projectId: string, projectPath: string, sessionId: string): WorkerLinks {
  const live = useLiveSessions();
  // Asked again when a chat of this project starts, stops or changes state, so
  // a worker started a moment ago joins the list.
  const liveKey = useMemo(
    () => live.filter((one) => one.projectId === projectId).map((one) => `${one.id}:${one.state}`).join(','),
    [live, projectId],
  );
  const rows = useProjectRows(projectId, projectPath, sessionId, liveKey);
  return useMemo(() => {
    const states = new Map(live.map((one) => [one.id, one.state as SessionState]));
    const withLive = (row: RestoreRow) => (row.sessionId && states.has(row.sessionId) ? { ...row, state: states.get(row.sessionId)! } : row);
    const self = rows.find((row) => row.sessionId === sessionId);
    const parent = self?.parentSessionId;
    return {
      workers: rows.filter((row) => row.parentSessionId === sessionId && row.sessionId !== sessionId).map(withLive),
      orchestrator: (parent && rows.find((row) => row.sessionId === parent)) || null,
    };
  }, [rows, live, sessionId]);
}

/** A link to a chat on this screen: a real address, opened without a page load. */
function ChatLink({ id, onOpen, className, children }: { id: string; onOpen: (id: string) => void; className?: string; children: React.ReactNode }) {
  const params = useSearchParams();
  return (
    <a
      href={addressWith(new URLSearchParams(params.toString()), { tab: 'chat', chat: id, message: null })}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onOpen(id);
      }}
      className={className}
    >
      {children}
    </a>
  );
}

export function WorkersList({ workers, onOpen }: { workers: RestoreRow[]; onOpen: (id: string) => void }) {
  const [stopping, setStopping] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const working = workers.filter((row) => MID_TURN.includes(row.state));
  const stopAll = useCallback(async () => {
    setStopping(true);
    setFailed(null);
    try {
      for (const row of working) {
        if (row.sessionId) await sendCommand({ type: 'session.stop', sessionId: row.sessionId });
      }
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
    } finally {
      setStopping(false);
    }
  }, [working]);
  return (
    <div className="flex flex-col gap-1" data-testid="workers-list">
      {workers.map((row) => (
        <ChatLink
          key={row.sessionId}
          id={row.sessionId!}
          onOpen={onOpen}
          className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BrandIcon brand={row.brand} />
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            {MID_TURN.includes(row.state) && <Spinner className="size-3" />}
            {stateWord(row.state)}
          </span>
        </ChatLink>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="mt-1 self-start"
        disabled={working.length === 0 || stopping}
        onClick={() => void stopAll()}
      >
        Stop workers
      </Button>
      {failed && <p className="text-xs text-danger">{failed}</p>}
    </div>
  );
}

export function OrchestratorLink({ orchestrator, onOpen }: { orchestrator: RestoreRow; onOpen: (id: string) => void }) {
  return (
    <ChatLink
      id={orchestrator.sessionId!}
      onOpen={onOpen}
      className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <BrandIcon brand={orchestrator.brand} />
      <span className="min-w-0 flex-1 truncate">Worker of {orchestrator.name}</span>
    </ChatLink>
  );
}
