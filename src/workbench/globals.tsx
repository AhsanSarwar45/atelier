/**
 * The one thing about agents that follows the owner around every screen: what
 * is waiting on him.
 *
 * It rides in the shell's first bar, which is on every screen, so it is on the
 * project list, the board and the chat alike. It reads the one live store
 * (`live.ts`) — no view here opens a connection of its own.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';

import { useRouter } from 'next/navigation';

import { Bell, CheckCheck } from 'lucide-react';

import { ToolButton } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { panelVariants } from '@/components/ui/panel';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Row } from '@/components/ui/row';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useLiveSessions } from '@/workbench/live';
import { readNotificationPreferences, showDeviceNotification, useNotificationPreferences } from '@/workbench/notification-preferences';
import { useAlreadyToldThisPage, useNotifications, type Notification } from '@/workbench/notifications';
import { whenItAppeared } from '@/workbench/when';

/**
 * What a row says it is waiting for.
 *
 * The server sends the words with the row, so a page and a phone say the same
 * thing about the same chat. The live stream sometimes knows better — the tool
 * a chat is actually asking to run, the message an error actually carried —
 * and when it does, that wins: it is the same fact, said more precisely.
 */
function whatItSays(row: Notification, live: Map<string, string | null>): string {
  return live.get(row.id) ?? row.says;
}

function WaitingTray({ rows, clear }: { rows: Notification[]; clear: () => void }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { preferences } = useNotificationPreferences();
  // What the stream knows about a chat that the row cannot carry: the tool it
  // is asking to run, the message its error came with.
  const sessions = useLiveSessions();
  const said = useMemo(
    () => new Map(sessions.map((s) => [s.id, s.waitingFor])),
    [sessions],
  );

  // Which kinds the owner wants to hear about is still his own browser's
  // business — it is a setting, not a fact about the chats.
  const waiting = preferences.needsAction ? rows.filter((row) => row.needsAction) : [];
  const updates = preferences.updates ? rows.filter((row) => !row.needsAction) : [];

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
        //
        // The panel sets its own padding to nothing so that a row can run the
        // full width and rule itself, and keeps a little back at the bottom:
        // without it the last row's own edge is the panel's edge, and the words
        // in it sit right against the corner.
        className={cn(
          panelVariants({ tone: 'overlay', inset: 'none' }),
          'w-96 max-w-[calc(100vw-1rem)] overflow-hidden p-0 pb-2',
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
              clear();
              setOpen(false);
            }}
          >
            <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Clear all
          </Button>
        </div>
        {waiting.length > 0 && <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-t-muted">Needs action</div>}
        {waiting.map((row) => (
          <Row
            key={row.id}
            ruled
            data-testid="tray-row"
            data-session-id={row.id}
            onClick={() => {
              setOpen(false);
              router.push(row.href);
            }}
          >
            <div className="flex items-baseline gap-2">
              <div className="truncate text-sm text-foreground">{row.name}</div>
              <Tooltip label={new Date(row.at).toLocaleString()}>
                <span data-testid="tray-when" className="ml-auto shrink-0 text-[11px] text-t-muted">
                  {whenItAppeared(row.at)}
                </span>
              </Tooltip>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span data-testid="tray-project" className="truncate font-medium">
                {row.projectName}
              </span>
              <span data-testid="tray-waiting-for" className="truncate">
                · {whatItSays(row, said)}
              </span>
            </div>
          </Row>
        ))}
        {updates.length > 0 && <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-t-muted">Other updates</div>}
        {updates.map((row) => (
          <Row key={row.id} ruled data-testid="tray-row" data-notification-type="update" onClick={() => { setOpen(false); router.push(row.href); }}>
            <div className="flex items-baseline gap-2">
              <div className="truncate text-sm text-foreground">{row.name}</div>
              <Tooltip label={new Date(row.at).toLocaleString()}>
                <span data-testid="tray-when" className="ml-auto shrink-0 text-[11px] text-t-muted">
                  {whenItAppeared(row.at)}
                </span>
              </Tooltip>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span data-testid="tray-project" className="truncate font-medium">{row.projectName}</span><span className="truncate">· {row.says}</span>
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
 *
 * Everything it draws comes from the server, which is also what decides there
 * is nothing to say. Nothing about what has been read is kept in this browser
 * any more: it was kept in two places here, in two storages, and neither
 * outlived the tab a phone threw away (bw-altj).
 */
export function WorkbenchStatus() {
  const { notifications, loaded, clear } = useNotifications();
  const { preferences } = useNotificationPreferences();
  const unheard = useAlreadyToldThisPage();

  useEffect(() => {
    // Nothing is news until the server has actually answered: the empty list
    // this starts on is the question not yet asked, and taking it as the last
    // reading would make every row of the first answer a fresh announcement on
    // every page load.
    if (!loaded) return;
    if (!readNotificationPreferences().device) {
      // Still take the reading, so that turning the setting on mid-sitting does
      // not then announce everything that was already sitting there.
      unheard(notifications);
      return;
    }
    for (const row of unheard(notifications)) {
      if (row.needsAction ? preferences.needsAction : preferences.updates) {
        void showDeviceNotification(row.name, row.says, row.href);
      }
    }
  }, [loaded, notifications, preferences, unheard]);

  return (
    <div data-testid="workbench-globals" className="flex min-w-0 flex-1 items-center justify-end gap-3">
      {notifications.length > 0 && <WaitingTray rows={notifications} clear={() => void clear()} />}
    </div>
  );
}
