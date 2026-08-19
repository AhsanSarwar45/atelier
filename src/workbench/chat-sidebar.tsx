/**
 * The restore list: every chat in this project, and any Claude session the
 * owner began in a terminal, grouped by the day it was last touched.
 *
 * A row is an offer, never a wake-up. Nothing here starts an agent until the
 * owner clicks (decision 8) — see docs/agent-workbench.md §6.3.
 *
 * A row says three things and no more: what the conversation is called, which
 * cards it worked on, and which folder it ran in. That is what tells two chats
 * apart when a project has forty of them.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BeadChipRow } from '@/components/bead-chip-row';
import { Badge } from '@/components/ui/badge';
import { apiUrl } from '@/lib/api-base';
import { hueFor } from '@/lib/bead-labels';
import { cn } from '@/lib/utils';
import { useLiveSessions, useRunningElsewhere, type LiveSession } from '@/workbench/live';
import { byWhatIsWorking, folderOf, laterOf, type RestoreRow } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

/**
 * How many rows are drawn before the reader asks for more. A 288px rail shows
 * about a dozen at a time, so this is several screens deep — far enough that
 * the growth is never what he is waiting for.
 */
const SCREENFUL = 40;

/** Today, Yesterday, then the date itself. */
export function dayHeading(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(then)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * The clock alone. The day is already the heading above the row, and a full
 * date in a 288px rail is cut off mid-year, which tells the owner nothing.
 */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** What stands over the chats somebody is working in, in place of a date. */
export const WORKING_NOW = 'Working now';

/**
 * Rows in the order given, split into the blocks they are drawn under, without
 * reordering them.
 *
 * A chat being worked in sits at the top whatever its date (protocol.ts,
 * byWhatIsWorking), so a day over it would be wrong twice over: it explains a
 * row that is up there for another reason, and it leaves today's heading to be
 * drawn a second time over the idle chats below it (bw-dmxj.11). Those rows get
 * a heading that says why they are first, and the days start under them.
 *
 * A heading is never opened twice: a row joins the block already carrying its
 * heading. With the list in its own order that is the block above it anyway,
 * and it is a promise the reader can rely on rather than one the caller keeps.
 */
export function groupRows(rows: RestoreRow[], now = new Date()): { heading: string; rows: RestoreRow[] }[] {
  const groups: { heading: string; rows: RestoreRow[] }[] = [];
  for (const row of rows) {
    const heading = row.runningElsewhere ? WORKING_NOW : dayHeading(row.lastActiveAt, now);
    const already = groups.find((g) => g.heading === heading);
    if (already) already.rows.push(row);
    else groups.push({ heading, rows: [row] });
  }
  return groups;
}

function rowKey(row: RestoreRow): string {
  return row.sessionId ?? `ext:${row.externalId}`;
}

/**
 * The list as it stands, plus whatever has happened since it was asked for.
 *
 * The list is fetched once when the tab opens; a chat started after that —
 * here, from a card, or in another window — is announced on the app's one live
 * stream, and this is where it joins the list. Without it the owner starts a
 * chat and does not see it.
 */
export function withLive(
  rows: RestoreRow[],
  live: LiveSession[],
  projectId: string,
  /**
   * The conversations a live process is holding, as the stream last said, or
   * `null` while it has not said anything. Null leaves each row's own answer
   * alone: the list arrives from the sidecar already marked, and an empty set
   * would rub those marks out before the stream had spoken.
   */
  running: ReadonlySet<string> | null = null,
): RestoreRow[] {
  const byId = new Map(rows.filter((r) => r.sessionId).map((r) => [r.sessionId!, r]));
  const merged = [...rows];

  for (const session of live) {
    if (session.projectId !== projectId) continue;
    const known = byId.get(session.id);
    // A chat that is awake is always worth seeing, whatever it is called. One
    // that is asleep and not in the list is one the list deliberately left out
    // (docs/agent-workbench.md §6.3.1).
    const awake = session.state !== 'dormant' && session.state !== 'ended';
    if (!known && !awake) continue;
    if (known) {
      merged[merged.indexOf(known)] = {
        ...known,
        state: session.state,
        title: session.title ?? known.title,
        // Never backwards: the stream carries what our own driver has seen, and
        // the row may already hold a later time from the tool's index — a chat
        // being worked on in a terminal moves that index and not our driver.
        lastActiveAt: laterOf(known.lastActiveAt, session.lastActiveAt),
        beads: session.beads.length ? session.beads : known.beads,
      };
      continue;
    }
    merged.push({
      sessionId: session.id,
      externalId: null,
      brand: session.brand,
      title: session.title,
      lastActiveAt: session.lastActiveAt,
      state: session.state,
      origin: 'app',
      projectId: session.projectId,
      cwdHint: session.projectPath,
      folder: folderOf(session.projectPath),
      branch: null,
      beads: session.beads,
    });
  }

  // The mark last, and over everything: a chat that starts or stops being worked
  // in changes nothing else about its row, and the reader is not reloading.
  const marked = running
    ? merged.map((r) => (r.externalId ? { ...r, runningElsewhere: running.has(r.externalId) } : r))
    : merged;

  return marked.sort(byWhatIsWorking);
}

interface ChatSidebarProps {
  projectId: string;
  projectPath: string;
  openSessionId: string | null;
  onOpen: (sessionId: string) => void;
  /** Also the chats an agent started for another chat, and the empty ones. */
  everything?: boolean;
}

export function ChatSidebar({ projectId, projectPath, openSessionId, onOpen, everything = false }: ChatSidebarProps) {
  const [fetched, setFetched] = useState<RestoreRow[]>([]);
  const live = useLiveSessions();
  const running = useRunningElsewhere();
  const rows = useMemo(
    () => withLive(fetched, live, projectId, running),
    [fetched, live, projectId, running],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ project: projectId, path: projectPath });
    if (everything) q.set('all', '1');
    try {
      const res = await fetch(apiUrl(`/api/workbench/restore?${q}`));
      if (res.ok) setFetched((await res.json()) as RestoreRow[]);
    } catch {
      // The workbench may not be running; the board half is unaffected.
    }
  }, [projectId, projectPath, everything]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * One click is the whole way in, and it is a READ: the conversation is drawn,
   * and no agent is started. A chat begun in a terminal is given an id and its
   * past is read in on the way; what wakes an agent is the first message sent to
   * it, and nothing else (docs/designs/app-shell.md §1.9, the manager's rule of
   * 2026-08-17).
   */
  const enter = useCallback(
    (row: RestoreRow) => {
      // A chat this app already knows is opened by its id alone: no round trip,
      // so the transcript starts drawing on the click.
      if (row.sessionId && row.state !== 'dormant' && row.state !== 'ended') {
        onOpen(row.sessionId);
        return;
      }
      const key = rowKey(row);
      setBusy(key);
      setFailed(null);
      void (async () => {
        try {
          const s = await sendCommand<{ id: string }>({
            type: 'session.open',
            sessionId: row.sessionId ?? undefined,
            externalId: row.externalId ?? undefined,
            brand: row.brand,
            projectId,
            projectPath,
          });
          // The list is asked again, so the row now carries the id it was just
          // given: without that it keeps reporting it has no chat, is never
          // highlighted as the open one, and invites a second click (bw-m8o.12).
          await load();
          onOpen(s.id);
        } catch (e) {
          // An open that fails silently leaves a row that looks merely slow.
          setFailed(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(null);
        }
      })();
    },
    [projectId, projectPath, load, onOpen],
  );

  // A screenful, then more as it is pulled: a project with hundreds of chats
  // would otherwise draw every one of them before the first is on screen
  // (docs/designs/app-shell.md §1.6, §3).
  const [shown, setShown] = useState(SCREENFUL);
  const foot = useRef<HTMLDivElement | null>(null);

  useEffect(() => setShown(SCREENFUL), [projectId]);

  useEffect(() => {
    const mark = foot.current;
    if (!mark || shown >= rows.length) return;
    const watch = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => n + SCREENFUL);
    });
    watch.observe(mark);
    return () => watch.disconnect();
  }, [shown, rows.length]);

  const groups = groupRows(rows.slice(0, shown));

  return (
    <aside
      data-testid="chat-sidebar"
      className="flex h-full min-h-0 w-72 shrink-0 flex-col border-r border-border/60"
    >
      {failed && (
        <p data-testid="restore-error" className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {failed}
        </p>
      )}

      <div data-testid="chat-list" className="min-h-0 flex-1 overflow-y-auto">
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
                  // The conversation's own id, which a resume does not change:
                  // the row a terminal session is offered on is the row it
                  // comes back on.
                  data-external-id={row.externalId ?? ''}
                  data-origin={row.origin}
                  data-state={row.state}
                  // Somebody is working in this conversation right now, in a
                  // terminal or under another host. Not the same fact as
                  // `state`, which is what our own driver knows (protocol.ts).
                  data-running={row.runningElsewhere ? 'yes' : 'no'}
                  // Two lines, never three: the name, then what it worked on and
                  // where. Everything else — the time, the way back in — rides on
                  // one of those two lines, because a rail this narrow turns a
                  // third row into a wall of half-sentences.
                  className={cn(
                    'px-3 py-2 text-sm',
                    row.sessionId && row.sessionId === openSessionId && 'bg-accent',
                  )}
                >
                  <div className="flex items-baseline gap-2">
                    <button
                      type="button"
                      data-testid="row-name"
                      className="min-w-0 flex-1 truncate text-left text-foreground"
                      disabled={busy === key}
                      onClick={() => enter(row)}
                    >
                      {row.title ?? 'Untitled chat'}
                    </button>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {clockTime(row.lastActiveAt)}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1 overflow-hidden">
                    <BeadChipRow
                      ids={row.beads}
                      projectId={projectId}
                      place="row"
                      className="flex min-w-0 items-center gap-1 overflow-hidden"
                    />
                    {row.folder && (
                      <Badge
                        hue={hueFor(row.folder)}
                        appearance="light"
                        size="xs"
                        shape="circle"
                        data-testid="row-folder-chip"
                        data-folder={row.folder}
                        // The full path and the branch in the tooltip: the chip
                        // itself has room for the one word that tells two
                        // checkouts of the same project apart.
                        title={[row.cwdHint, row.branch].filter(Boolean).join(' · ')}
                        className="min-w-0 shrink truncate font-mono"
                      >
                        {row.folder}
                      </Badge>
                    )}
                    {busy === key ? (
                      <Badge
                        variant="warning"
                        appearance="light"
                        size="xs"
                        shape="circle"
                        data-testid="row-pill"
                        data-pill="opening"
                        className="ml-auto shrink-0"
                      >
                        opening
                      </Badge>
                    ) : row.runningElsewhere ? (
                      // The strongest thing a row can say, so it says it in
                      // place of "ready" rather than beside it: one pill's
                      // worth of room, and two would read as two facts.
                      <Badge
                        variant="success"
                        appearance="default"
                        size="xs"
                        shape="circle"
                        data-testid="row-pill"
                        data-pill="working"
                        className="ml-auto shrink-0"
                      >
                        working
                      </Badge>
                    ) : (
                      live && (
                        <Badge
                          variant="success"
                          appearance="light"
                          size="xs"
                          shape="circle"
                          data-testid="row-pill"
                          data-pill="ready"
                          className="ml-auto shrink-0"
                        >
                          ready
                        </Badge>
                      )
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {!rows.length && <p className="px-3 py-4 text-sm text-muted-foreground">No chats yet.</p>}
        {shown < rows.length && (
          <div ref={foot} data-testid="chat-list-more" className="px-3 py-3 text-xs text-muted-foreground">
            {rows.length - shown} older
          </div>
        )}
      </div>
    </aside>
  );
}
