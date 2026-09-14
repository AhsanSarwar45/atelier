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

import { Bell } from 'lucide-react';

import { ToolButton } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
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
      {/*
        A bell with a count on it, the same on every width. It used to be the
        words "Waiting on you" on an outlined button, which is a sentence in a
        bar of pictures — and on a phone that sentence took the room the bar
        needed for the project's own name (bw-rpgh.2). The words are not lost:
        they are the button's label, so the tooltip says them and a screen
        reader hears them along with the count.
      */}
      <ToolButton
        icon={<Bell />}
        label={`Waiting on you: ${waiting.length}`}
        data-testid="tray-badge"
        data-count={waiting.length}
        data-open={open}
        onClick={() => setOpen((v) => !v)}
      />
      {/*
        Sat on the button's corner rather than beside it, so the count costs no
        width at all. It ignores the pointer: the whole button under it is the
        one thing to press.
      */}
      <Badge
        variant="warning"
        appearance="light"
        size="xs"
        shape="circle"
        data-testid="tray-count"
        className="pointer-events-none absolute -right-1 -top-1 min-w-4 justify-center px-1"
      >
        {waiting.length}
      </Badge>

      {open && (
        <Panel
          tone="overlay"
          inset="none"
          data-testid="tray-panel"
          // Never wider than the screen it drops onto: 384px is most of a
          // phone, and pinned to the bar's right end the overflow would have
          // hung off the left edge (bw-rpgh.2).
          className="absolute right-0 z-50 mt-1 w-96 max-w-[calc(100vw-1rem)] overflow-hidden"
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
