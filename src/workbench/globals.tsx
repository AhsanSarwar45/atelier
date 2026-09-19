/**
 * The one thing about agents that follows the owner around every screen: what
 * is waiting on him.
 *
 * It rides in the shell's first bar, which is on every screen, so it is on the
 * project list, the board and the chat alike. It reads the one live store
 * (`live.ts`) — no view here opens a connection of its own.
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

import { useRouter } from 'next/navigation';

import { Bell, CheckCheck } from 'lucide-react';

import { ToolButton } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { panelVariants } from '@/components/ui/panel';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Row } from '@/components/ui/row';
import * as api from '@/lib/api';
import { cn } from '@/lib/utils';
import { useLiveSessions, waitsOnYou, type LiveSession } from '@/workbench/live';
import { readNotificationPreferences, showDeviceNotification, useNotificationPreferences } from '@/workbench/notification-preferences';

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

/** What the reader has already read: chat id to the state it was in when cleared. */
const CLEARED_KEY = 'atelier.notifications-cleared';

export function readCleared(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(sessionStorage.getItem(CLEARED_KEY) ?? '{}') as Record<string, string>;
  } catch {
    // A tray that cannot read what was cleared shows everything, which is the
    // safe way to be wrong: nothing waiting on the owner goes missing.
    return {};
  }
}

/**
 * Whether a chat is still cleared.
 *
 * Against the state it was cleared IN, not against the id alone. These rows are
 * not messages that arrive and stay — they are a live reading of what each chat
 * is doing, so a chat cleared while it waits on permission must come back the
 * moment it goes on to want something else. Clearing by id would have silenced
 * that chat for the rest of the tab.
 */
export function stillCleared(cleared: Record<string, string>, s: LiveSession): boolean {
  return cleared[s.id] === s.state;
}

/**
 * What the tray has been told to forget, and the way to tell it.
 *
 * Kept for the tab rather than the machine (`sessionStorage`), beside the states
 * the device notifications are judged against: clearing says "I have read
 * these", which is a thing about this sitting rather than about this browser.
 */
function useCleared(): { cleared: Record<string, string>; clear: (sessions: LiveSession[]) => void } {
  const [cleared, setCleared] = useState<Record<string, string>>({});
  // Read after mount, not during: the server renders this too, and it has no
  // sessionStorage to read.
  useEffect(() => setCleared(readCleared()), []);
  const clear = useCallback((sessions: LiveSession[]) => {
    // Only the chats on screen are remembered, so the record cannot grow past
    // the number of chats there are.
    const next = Object.fromEntries(sessions.map((s) => [s.id, s.state]));
    sessionStorage.setItem(CLEARED_KEY, JSON.stringify(next));
    setCleared(next);
  }, []);
  return { cleared, clear };
}

function WaitingTray({ names }: { names: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const sessions = useLiveSessions();
  const { preferences } = useNotificationPreferences();
  const { cleared, clear } = useCleared();
  const unread = (s: LiveSession) => !stillCleared(cleared, s);
  const waiting = preferences.needsAction ? sessions.filter(waitsOnYou).filter(unread) : [];
  const updates = preferences.updates
    ? sessions.filter((s) => !waitsOnYou(s) && (s.state === 'idle' || s.state === 'stopped')).filter(unread)
    : [];

  if (!waiting.length && !updates.length) return null;

  return (
    /*
      Radix owns when this is up and when it is gone. It used to be a bare
      `open` flag over an absolutely placed box, which is the one anchored panel
      in the app that was not a popover — and it showed: the only way out was to
      find the bell again, because a press on the page behind it went to the
      page and the tray stayed (bw-l6hd.1). A popover shuts on an outside press
      and on Escape without being asked, the way every other panel here already
      does, and the flag stays only because a row that navigates has to put the
      tray away on its way out.
    */
    <Popover open={open} onOpenChange={setOpen}>
      <div className="relative">
        {/*
          A bell with a count on it, the same on every width. It used to be the
          words "Waiting on you" on an outlined button, which is a sentence in a
          bar of pictures — and on a phone that sentence took the room the bar
          needed for the project's own name (bw-rpgh.2). The words are not lost:
          they are the button's label, so the tooltip says them and a screen
          reader hears them along with the count.
        */}
        <PopoverTrigger asChild>
          <ToolButton
            icon={<Bell />}
            label={`Notifications: ${waiting.length + updates.length}`}
            data-testid="tray-badge"
            data-count={waiting.length + updates.length}
            data-open={open}
          />
        </PopoverTrigger>
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
          // Keep the whole count inside the bar. Negative offsets made it
          // float beyond the bell and let the phone's top edge crop it.
          className="pointer-events-none absolute right-0 top-0 min-w-4 justify-center px-1"
        >
          {waiting.length + updates.length}
        </Badge>
      </div>

      <PopoverContent
        align="end"
        sideOffset={4}
        data-testid="tray-panel"
        // The frame is the app's overlay panel, borrowed by name rather than
        // redrawn here, so the tray keeps the box it has always had now that
        // Radix rather than a `relative` parent is placing it. Never wider than
        // the screen it drops onto: 384px is most of a phone, and pinned to the
        // bar's right end the overflow would have hung off the left edge
        // (bw-rpgh.2).
        className={cn(
          panelVariants({ tone: 'overlay', inset: 'none' }),
          'w-96 max-w-[calc(100vw-1rem)] overflow-hidden p-0',
        )}
      >
        {/*
          The way to be done with what is in here. At the top rather than under
          the rows, because the rows are as many as there are chats and this
          panel does not scroll: a control below forty of them is a control off
          the bottom of the screen.

          It clears everything, which is what the one button in a tray of read
          notifications should do. A row cleared here is not gone for good — see
          {@link stillCleared} — it is gone until its chat does something else.
        */}
        <div className="flex items-center justify-between gap-2 border-b border-border/40 px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-t-muted">Notifications</span>
          <Button
            type="button"
            variant="dim"
            size="xs"
            data-testid="tray-clear"
            onClick={() => {
              clear(sessions);
              setOpen(false);
            }}
          >
            <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Clear all
          </Button>
        </div>
        {waiting.length > 0 && <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-t-muted">Needs action</div>}
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
        {updates.length > 0 && <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-t-muted">Other updates</div>}
        {updates.map((s) => (
          <Row key={s.id} ruled data-testid="tray-row" data-notification-type="update" onClick={() => { setOpen(false); router.push(chatHref(s)); }}>
            <div className="truncate text-sm text-foreground">{s.title ?? 'Untitled chat'}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="truncate font-medium">{names.get(s.projectId) ?? 'Unknown project'}</span><span className="truncate">· Ready to read</span>
            </div>
          </Row>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * What follows the owner, drawn inline in the shell's first bar: the tray of
 * chats waiting on him. It takes no room at all when there is nothing to say.
 */
export function WorkbenchStatus() {
  const names = useProjectNames();
  const sessions = useLiveSessions();
  // Deliberately blind to what has been cleared: this is the cheap gate, and
  // reading sessionStorage during a render the server also does would have the
  // two of them disagree. The tray itself draws nothing once everything in it
  // is cleared, so the bell goes with it either way.
  const relevant = sessions.filter((s) => waitsOnYou(s) || s.state === 'idle' || s.state === 'stopped').length;

  useEffect(() => {
    const preferences = readNotificationPreferences();
    const previous = JSON.parse(sessionStorage.getItem('atelier.notification-states') ?? '{}') as Record<string, string>;
    if (preferences.device) for (const session of sessions) {
      if (previous[session.id] && previous[session.id] !== session.state) {
        const action = waitsOnYou(session);
        const update = session.state === 'idle' || session.state === 'stopped';
        if ((action && preferences.needsAction) || (update && preferences.updates)) void showDeviceNotification(session.title ?? 'Atelier chat', action ? whatItWaitsFor(session) : 'Ready to read', chatHref(session));
      }
    }
    sessionStorage.setItem('atelier.notification-states', JSON.stringify(Object.fromEntries(sessions.map((s) => [s.id, s.state]))));
  }, [sessions]);

  return (
    <div data-testid="workbench-globals" className="flex min-w-0 flex-1 items-center justify-end gap-3">
      {relevant > 0 && <WaitingTray names={names} />}
    </div>
  );
}
