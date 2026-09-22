/**
 * What the app has to say to its owner, as the server sees it.
 *
 * The tray used to work this out for itself: it took the live chats from the
 * stream, fetched the project list separately, joined the two by hand, and
 * subtracted a record of what had been cleared that it kept in the browser. All
 * three parts of that went wrong at once (bw-altj) — a chat whose project had
 * been deleted drew a row reading "Unknown project" that nothing could remove,
 * and the cleared record lived in the tab, so a phone that discarded the tab
 * brought every dismissed row back.
 *
 * So the server answers the whole question and this asks it. What is left here
 * is when to ask again.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { request } from '@/lib/api';
import { useLiveSessions } from '@/workbench/live';

/** One thing the app has to say, as the server hands it over. */
export interface Notification {
  id: string;
  /**
   * What to call this chat, settled by the server and never nothing: its
   * title, else the folder it works in, else the agent holding it (server,
   * `notice::naming`). The tray used to draw a raw title and write
   * "Untitled chat" when there was none, which named nothing anybody could
   * act on (bw-altj.7).
   */
  name: string;
  projectId: string;
  /** Always a real project's name: a chat that cannot be named is not a row. */
  projectName: string;
  state: string;
  /** What this row says, in the owner's words rather than a state name. */
  says: string;
  href: string;
  needsAction: boolean;
}

export async function readNotifications(): Promise<Notification[]> {
  const answer = await request('/api/workbench/notifications');
  if (!answer.ok) throw new Error(`the notifications could not be read: ${answer.status}`);
  return (await answer.json()) as Notification[];
}

/** Tell the server these have been read, in the states they were read in. */
export async function markRead(chats: { id: string; state: string }[]): Promise<void> {
  const answer = await request('/api/workbench/notifications/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chats }),
  });
  if (!answer.ok) throw new Error(`the tray could not be cleared: ${answer.status}`);
}

/**
 * What there is to say right now, and the way to say it has been read.
 *
 * Asked again whenever any chat changes state, which is the only thing that can
 * change the answer, and which the live stream already reports. There is no
 * polling: a tray that asked on a timer would be a second or two behind the
 * chat it is describing, on the one screen where being behind is the whole
 * failure.
 */
export function useNotifications(): {
  notifications: Notification[];
  /**
   * Whether the server has answered yet. Before it has, the empty array below
   * is not "nothing to say", it is "not asked yet" — and anything that treats
   * the two alike reads the first real answer as a whole screenful of news.
   */
  loaded: boolean;
  clear: () => Promise<void>;
} {
  const sessions = useLiveSessions();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loaded, setLoaded] = useState(false);

  // What the stream says every chat is doing, as one string. The answer can
  // only change when this does, so this is what a refetch hangs off — not the
  // session array itself, which is a new object on every frame the stream
  // carries, including the ones that say nothing about any state.
  const standing = useMemo(
    () =>
      sessions
        .map((s) => `${s.id}:${s.state}`)
        .sort()
        .join(','),
    [sessions],
  );

  const load = useCallback(async () => {
    try {
      setNotifications(await readNotifications());
    } catch {
      // A tray that cannot reach the server says nothing rather than saying
      // something stale. The next change of any chat asks again.
      setNotifications([]);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, standing]);

  const clear = useCallback(async () => {
    // Cleared against the states the owner was actually shown, not the states
    // as they stand when the request lands: a chat that moved on in between is
    // still unread, which is the safe way to be wrong.
    const seen = notifications.map((n) => ({ id: n.id, state: n.state }));
    setNotifications([]);
    try {
      await markRead(seen);
    } finally {
      await load();
    }
  }, [notifications, load]);

  return { notifications, loaded, clear };
}

/**
 * The chats a device has already been told about in their current state, for
 * as long as this page is open.
 *
 * Deliberately in memory and nowhere else. This used to be kept in
 * `sessionStorage` under `atelier.notification-states`, which made it a fourth
 * private copy of a fact the database now holds, and one that was wiped every
 * time the browser rebuilt the tab (bw-altj). What a device has been told is
 * the server's business — it is the only party that can tell a phone anything
 * with no page open — so all this has to do is not say the same thing twice
 * while a window happens to be up.
 */
export function useAlreadyToldThisPage(): (rows: Notification[]) => Notification[] {
  const told = useRef<Map<string, string> | null>(null);
  return useCallback((rows: Notification[]) => {
    const before = told.current;
    told.current = new Map(rows.map((row) => [row.id, row.state]));
    // The first answer is not news: opening a page is not a chat changing, and
    // a device that announced everything already sitting there on every load
    // would be unusable.
    if (before === null) return [];
    return rows.filter((row) => before.get(row.id) !== row.state);
  }, []);
}
