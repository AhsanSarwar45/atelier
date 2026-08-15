/**
 * The restore list: every chat in this project, and any Claude session the
 * owner began in a terminal, grouped by the day it was last touched.
 *
 * A row is an offer, never a wake-up. Nothing here starts an agent until the
 * owner clicks (decision 8) — see docs/agent-workbench.md §6.3.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiUrl } from '@/lib/api-base';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { RestoreRow } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

/** Today, Yesterday, then the date itself. */
export function dayHeading(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(then)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Rows in the order given, split into day groups without reordering them. */
export function groupByDay(rows: RestoreRow[], now = new Date()): { heading: string; rows: RestoreRow[] }[] {
  const groups: { heading: string; rows: RestoreRow[] }[] = [];
  for (const row of rows) {
    const heading = dayHeading(row.lastActiveAt, now);
    const last = groups[groups.length - 1];
    if (last && last.heading === heading) last.rows.push(row);
    else groups.push({ heading, rows: [row] });
  }
  return groups;
}

function rowKey(row: RestoreRow): string {
  return row.sessionId ?? `ext:${row.externalId}`;
}

interface ChatSidebarProps {
  projectId: string;
  projectPath: string;
  openSessionId: string | null;
  onOpen: (sessionId: string) => void;
}

export function ChatSidebar({ projectId, projectPath, openSessionId, onOpen }: ChatSidebarProps) {
  const [rows, setRows] = useState<RestoreRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ project: projectId, path: projectPath });
    try {
      const res = await fetch(apiUrl(`/api/workbench/restore?${q}`));
      if (res.ok) setRows((await res.json()) as RestoreRow[]);
    } catch {
      // The workbench may not be running; the board half is unaffected.
    }
  }, [projectId, projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const resume = useCallback(
    async (row: RestoreRow) => {
      setBusy(rowKey(row));
      try {
        const s = await sendCommand<{ id: string }>({
          type: 'session.resume',
          sessionId: row.sessionId ?? undefined,
          externalId: row.externalId ?? undefined,
          brand: row.brand,
          projectId,
          projectPath,
        });
        await load();
        onOpen(s.id);
      } finally {
        setBusy(null);
      }
    },
    [projectId, projectPath, load, onOpen],
  );

  const groups = groupByDay(rows);

  return (
    <aside data-testid="chat-sidebar" className="flex w-72 shrink-0 flex-col border-r border-border/60">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Chats</span>
        <Button
          size="xs"
          variant="outline"
          data-testid="resume-all"
          className="ml-auto"
          disabled={!rows.length}
          onClick={async () => {
            // One deliberate act, then a fixed set — never a standing order.
            for (const row of rows) {
              if (row.state !== 'dormant') continue;
              // eslint-disable-next-line no-await-in-loop
              await resume(row);
            }
          }}
        >
          Resume all
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {groups.map((group) => (
          <div key={group.heading}>
            <div
              data-testid="day-heading"
              className="sticky top-0 bg-background/95 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {group.heading}
            </div>
            {group.rows.map((row) => {
              const key = rowKey(row);
              const live = row.state !== 'dormant' && row.state !== 'ended';
              return (
                <div
                  key={key}
                  data-testid="restore-row"
                  data-row-key={key}
                  data-origin={row.origin}
                  data-state={row.state}
                  className={cn(
                    'flex items-center gap-2 px-3 py-2 text-sm',
                    row.sessionId && row.sessionId === openSessionId && 'bg-accent',
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => row.sessionId && onOpen(row.sessionId)}
                  >
                    <div className="truncate text-foreground">
                      {row.title ?? (row.origin === 'terminal' ? 'Started in a terminal' : 'Untitled chat')}
                    </div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {row.brand} · {new Date(row.lastActiveAt).toLocaleString()}
                    </div>
                  </button>
                  <span
                    data-testid="row-pill"
                    data-pill={live ? 'ready' : row.state}
                    className={cn(
                      'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                      live ? 'bg-emerald-500/20 text-emerald-300' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {live ? 'ready' : row.state}
                  </span>
                  {!live && (
                    <Button
                      size="xs"
                      variant="outline"
                      data-testid="resume-row"
                      disabled={busy === key}
                      onClick={() => void resume(row)}
                    >
                      {busy === key ? '…' : 'Resume'}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {!rows.length && <p className="px-3 py-4 text-sm text-muted-foreground">No chats yet.</p>}
      </div>
    </aside>
  );
}
