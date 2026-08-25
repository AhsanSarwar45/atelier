/**
 * The one thing about agents that follows the owner around every screen: what
 * is waiting on him.
 *
 * It rides in the shell's first bar, which is on every screen, so it is on the
 * project list, the board and the chat alike. It reads the one live store
 * (`live.ts`) — no view here opens a connection of its own.
 */
'use client';

import { useEffect, useState } from 'react';

import { useRouter } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Row } from '@/components/ui/row';
import * as api from '@/lib/api';
import { useLiveSessions, waitsOnYou, type LiveSession } from '@/workbench/live';

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

/** What a row says it is waiting for, in the owner's words rather than a state name. */
export function whatItWaitsFor(s: LiveSession): string {
  if (s.waitingFor) return s.waitingFor;
  if (s.state === 'waiting_permission') return 'permission to use a tool';
  if (s.state === 'errored') return 'it stopped with an error';
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
        <Badge variant="warning" appearance="light" size="xs" shape="circle" className="ml-1.5">
          {waiting.length}
        </Badge>
      </Button>

      {open && (
        <Panel
          tone="overlay"
          inset="none"
          data-testid="tray-panel"
          className="absolute right-0 z-50 mt-1 w-96 overflow-hidden"
        >
          {waiting.map((s) => (
            <Row
              key={s.id}
              ruled
              data-testid="tray-row"
              data-session-id={s.id}
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
            </Row>
          ))}
        </Panel>
      )}
    </div>
  );
}

/**
 * What follows the owner, drawn inline in the shell's first bar: the tray of
 * chats waiting on him. It takes no room at all when there is nothing to say.
 */
export function WorkbenchStatus() {
  const names = useProjectNames();
  const waiting = useLiveSessions().filter(waitsOnYou).length;

  return (
    <div data-testid="workbench-globals" className="flex min-w-0 flex-1 items-center justify-end gap-3">
      {waiting > 0 && <WaitingTray names={names} />}
    </div>
  );
}
