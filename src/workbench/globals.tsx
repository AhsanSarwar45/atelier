/**
 * The two things about agents that follow the owner around every screen: what
 * is waiting on him, and what is running.
 *
 * They ride in the shell's first bar, which is on every screen, so both are on
 * the project list, the board and the chat alike. Both read the one live store
 * (`live.ts`) — no view here opens a connection of its own.
 */
'use client';

import { useEffect, useState } from 'react';

import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import * as api from '@/lib/api';
import { cn } from '@/lib/utils';
import { isRunning, useLiveSessions, waitsOnYou, type LiveSession } from '@/workbench/live';

/** Project ids to their names, fetched once — the tray names a project, not a path. */
function useProjectNames(): Map<string, string> {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    void api.projects
      .list()
      .then((rows) => {
        if (alive) setNames(new Map(rows.map((p) => [p.id, p.name])));
      })
      .catch(() => {
        // The tray still reads without names; it just shows the chat's own title.
      });
    return () => {
      alive = false;
    };
  }, []);
  return names;
}

/** Rounded to the unit a glance needs: seconds, then minutes, then hours. */
export function elapsed(since: string, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

/** What a row says it is waiting for, in the owner's words rather than a state name. */
export function whatItWaitsFor(s: LiveSession): string {
  if (s.waitingFor) return s.waitingFor;
  if (s.state === 'waiting_permission') return 'permission to use a tool';
  if (s.state === 'errored') return 'it stopped with an error';
  if (s.state === 'ended') return 'the conversation ended';
  return 'your turn';
}

function chatHref(s: LiveSession): string {
  return `/project?id=${encodeURIComponent(s.projectId)}&tab=chat&chat=${encodeURIComponent(s.id)}`;
}

function WaitingTray({ names }: { names: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const waiting = useLiveSessions().filter(waitsOnYou);

  if (!waiting.length) return null;

  return (
    <div className="relative">
      <Button
        size="xs"
        variant="outline"
        data-testid="tray-badge"
        data-count={waiting.length}
        onClick={() => setOpen((v) => !v)}
      >
        Waiting on you
        <span className="ml-1.5 rounded-full bg-amber-500/25 px-1.5 py-0.5 text-[10px] font-semibold text-amber-200">
          {waiting.length}
        </span>
      </Button>

      {open && (
        <div
          data-testid="tray-panel"
          className="absolute right-0 z-50 mt-1 w-96 overflow-hidden rounded-md border border-border/60 bg-background shadow-lg"
        >
          {waiting.map((s) => (
            <button
              key={s.id}
              type="button"
              data-testid="tray-row"
              data-session-id={s.id}
              className="block w-full border-b border-border/40 px-3 py-2 text-left last:border-b-0 hover:bg-accent"
              onClick={() => {
                setOpen(false);
                router.push(chatHref(s));
              }}
            >
              <div className="truncate text-sm text-foreground">{s.title ?? 'Untitled chat'}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <span data-testid="tray-project" className="truncate font-medium">
                  {names.get(s.projectId) ?? 'Unknown project'}
                </span>
                <span data-testid="tray-waiting-for" className="truncate">
                  · {whatItWaitsFor(s)}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GlanceStrip({ names }: { names: Map<string, string> }) {
  const router = useRouter();
  // A clock of its own, because elapsed time changes with no event to announce it.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const running = useLiveSessions().filter(isRunning);
  if (!running.length) return null;

  // One line, in a bar: what does not fit is clipped rather than pushing the
  // bar taller and taking the room the work is standing in.
  return (
    <div data-testid="glance-strip" className="flex min-w-0 items-center gap-x-4 overflow-hidden">
      {running.map((s) => (
        <button
          key={s.id}
          type="button"
          data-testid="glance-row"
          data-session-id={s.id}
          className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => router.push(chatHref(s))}
        >
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400')} />
          <span className="shrink-0 font-medium">{names.get(s.projectId) ?? s.brand}</span>
          <span className="max-w-[24ch] truncate">{s.title ?? 'Untitled chat'}</span>
          <span data-testid="glance-activity" className="max-w-[28ch] truncate">
            {s.activity || 'Working'}
          </span>
          <span className="shrink-0 font-mono">{elapsed(s.lastActiveAt, now)}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * What follows the owner, drawn inline in the shell's first bar: the strip of
 * chats running now, then the tray of chats waiting on him. Both take no room
 * at all when there is nothing to say.
 */
export function WorkbenchStatus() {
  const names = useProjectNames();
  const live = useLiveSessions();
  const waiting = live.filter(waitsOnYou).length;
  const running = live.filter(isRunning).length;

  return (
    <div data-testid="workbench-globals" className="flex min-w-0 flex-1 items-center justify-end gap-3">
      {running > 0 && <GlanceStrip names={names} />}
      {waiting > 0 && <WaitingTray names={names} />}
    </div>
  );
}
