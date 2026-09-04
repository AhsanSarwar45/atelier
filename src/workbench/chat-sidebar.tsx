/**
 * The restore list: every chat in this project, and any Claude session the
 * owner began in a terminal, grouped by the day it was last touched.
 *
 * A row is an offer, never a wake-up. Nothing here starts an agent until the
 * owner clicks (decision 8) — see docs/agent-workbench.md §6.3.
 *
 * A row says two things and no more: what the conversation is called, with the
 * time beside it, and how it is doing. The folder it ran in and the cards it
 * worked on ride along as `data-folder` and `data-beads` for anything that
 * needs to know, and neither is drawn: the chat's own bar names the folder and
 * its branch the moment the row is clicked, and a rail this narrow reads better
 * without a second copy of it or a wall of ids (the manager, 2026-08-23).
 *
 * A row is also where a chat is closed, because closing one is tidying and
 * tidying is done over a list rather than one chat at a time (the manager,
 * 2026-08-25). Closing keeps it: the agent goes and the chat falls asleep,
 * exactly as it would if the terminal it ran in were closed, so the row reads
 * what every other sleeping row reads and opens again on a click (the manager,
 * 2026-08-26).
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Bot, ChevronDown, ExternalLink, Loader2, Plus, Power, Search, X } from 'lucide-react';

import { ToolButton } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { request } from '@/lib/api';
import { cn } from '@/lib/utils';
import { chatState, holderOnly, HOLDER_WORD, type HeldChat } from '@/workbench/chat-state';
import { ChatStateChip } from '@/workbench/chat-state-chip';
import {
  useHeardFromOutside,
  useHeldFactsAreOld,
  useHelperMismatch,
  useHolds,
  useLiveSessions,
  useRunningElsewhere,
  type LiveSession,
} from '@/workbench/live';
import { byWhatIsWorking, folderOf, laterOf, laterSpoke, whenHeSpoke, type Brand, type RestoreRow } from '@/workbench/protocol';
import { heldElsewhere, sessionOwnership } from '@/workbench/running';
import { sendCommand } from '@/workbench/use-session';
import { BrandIcon, brandName } from '@/workbench/brand-icon';
import { useProviders, whyUnavailable } from '@/workbench/providers';
import { ModelIcon } from '@/workbench/model-icon';

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

/**
 * What stands over the chats another program is holding, in place of a date.
 *
 * It said "Working now", which is the swap this whole job removed: the block
 * is filled by who holds a chat, not by what they are doing, so a terminal
 * left at a prompt overnight was filed under a heading that said it was
 * working. What each of those chats is actually doing is on the row itself,
 * and the heading says only why they are up here (bw-96is.15).
 */
export const OPEN_ELSEWHERE = 'Open elsewhere';

/**
 * The block a row is drawn under: who has it, or else the day he last spoke in
 * it.
 *
 * One answer, read by the two things that must agree about it — the blocks the
 * list is drawn in, and the freeze that decides where a row sits (holdStill).
 * They disagreed, and a row he spoke in this morning stayed at yesterday's
 * place while its heading turned into today's, so the rail read YESTERDAY over
 * seven rows and TODAY over one below them (bw-hgd2).
 */
export function headingOf(row: RestoreRow, now = new Date()): string {
  return row.runningElsewhere ? OPEN_ELSEWHERE : dayHeading(whenHeSpoke(row), now);
}

/**
 * Rows in the order given, split into the blocks they are drawn under, without
 * reordering them.
 *
 * A chat another program holds sits at the top whatever its date (protocol.ts,
 * byWhatIsWorking), so a day over it would be wrong twice over: it explains a
 * row that is up there for another reason, and it leaves today's heading to be
 * drawn a second time over the idle chats below it (bw-dmxj.11). Those rows get
 * a heading that says why they are first, and the days start under them.
 *
 * One block, not two — held-and-working over held-and-idle. The list's order is
 * held still while the reader is looking at it (holdStill), and a heading here
 * is never opened twice, so a chat whose terminal stopped working would have to
 * cross from one block to the other while his hand was moving, or else sit
 * under a heading the block above already used. What each held chat is doing
 * this second is on the row itself, where it changes without moving anything.
 *
 * A heading is never opened twice: a row joins the block already carrying its
 * heading. With the list in its own order that is the block above it anyway,
 * and it is a promise the reader can rely on rather than one the caller keeps.
 */
export function groupRows(rows: RestoreRow[], now = new Date()): { heading: string; rows: RestoreRow[] }[] {
  const groups: { heading: string; rows: RestoreRow[] }[] = [];
  for (const row of rows) {
    const heading = headingOf(row, now);
    const already = groups.find((g) => g.heading === heading);
    if (already) already.rows.push(row);
    else groups.push({ heading, rows: [row] });
  }
  return groups;
}

function rowKey(row: RestoreRow): string {
  return row.sessionId ?? `ext:${row.externalId}`;
}

/** A row as the list last drew it: which row, and which block it was in. */
export interface SettledRow {
  key: string;
  heading: string;
}

/** What the list drew, in the form the next render holds it to. */
export function asSettled(rows: RestoreRow[], now = new Date()): SettledRow[] {
  return rows.map((row) => ({ key: rowKey(row), heading: headingOf(row, now) }));
}

/**
 * The order the reader is looking at, held still while he is looking at it.
 *
 * The top of this list is the chats somebody is working in right now, and
 * inside that block the order is who spoke last — which on this machine moves
 * every few seconds, because that is what a working agent does. So he goes to
 * click the third row and opens the second: the two traded places while his
 * hand was moving. Measured on 2026-08-20 with six agents running: the top six
 * rows re-ordered within six seconds, and nothing had been clicked (bw-khe.5).
 *
 * A row already in the list therefore stays where it is. Only what is IN it —
 * what it is doing, when it last spoke, whether somebody is in it — changes
 * under him. A chat the list has never shown joins at the place the fresh order
 * gives it, just below whichever row it now follows, so a chat begun elsewhere
 * still arrives on its own. The order settles again the next time the list is
 * opened, which is the one moment he is not pointing at it.
 *
 * A row is held still under the heading it was drawn under, and no further. A
 * chat he last spoke in yesterday and speaks in again this morning has left
 * that block: its day is today, and holding its place kept it among yesterday's
 * rows while the heading over it read today, so the rail drew TODAY below
 * YESTERDAY (bw-hgd2). Such a row is not where it was any more, so it takes the
 * place the fresh order gives it, exactly as a row the list has never shown
 * does — and the same for a chat somebody has taken up in a terminal, which
 * belongs in the block at the top and cannot open a second one halfway down.
 *
 * This costs the freeze nothing it was bought for. The rows that moved under
 * his hand were rows an AGENT was writing in, and those keep one heading all
 * day; the move let out here is the one he made himself, in the chat he is
 * looking at, one row at a time.
 */
export function holdStill(fresh: RestoreRow[], settled: readonly SettledRow[], now = new Date()): RestoreRow[] {
  if (settled.length === 0) return fresh;
  const rank = new Map(settled.map((row, i) => [row.key, i]));
  const drawnUnder = new Map(settled.map((row) => [row.key, row.heading]));

  // Each newcomer remembers which known row it arrived behind, so its place is
  // the fresh order's answer expressed in rows rather than in positions.
  const held: RestoreRow[] = [];
  const joining = new Map<string | null, RestoreRow[]>();
  let behind: string | null = null;
  for (const row of fresh) {
    const key = rowKey(row);
    if (rank.has(key) && drawnUnder.get(key) === headingOf(row, now)) {
      held.push(row);
      behind = key;
      continue;
    }
    const block = joining.get(behind) ?? [];
    block.push(row);
    joining.set(behind, block);
  }

  held.sort((a, b) => rank.get(rowKey(a))! - rank.get(rowKey(b))!);
  for (const [after, block] of Array.from(joining)) {
    const at = after === null ? 0 : held.findIndex((r) => rowKey(r) === after) + 1;
    held.splice(at, 0, ...block);
  }
  return held;
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
  /**
   * What each of those conversations is doing, by the same id, or `null` while
   * the stream has not said. Kept beside the set rather than replacing it: the
   * set is what the writing box turns on, and this is what the row draws
   * (bw-96is).
   */
  holds: ReadonlyMap<string, HeldChat> | null = null,
  /**
   * The stream has spoken about all this before and has stopped, so each row's
   * own answer — fetched when the list was drawn and not since — is older than
   * the one just thrown away. Who is in a chat is kept and what they were doing
   * is dropped, so a mark cannot go on turning on a dead connection's last word
   * (live.ts, `useHeldFactsAreOld`, bw-96is.22).
   */
  heldFactsAreOld = false,
): RestoreRow[] {
  const byId = new Map(rows.filter((r) => r.sessionId).map((r) => [r.sessionId!, r]));
  const merged = [...rows];

  for (const session of live) {
    if (session.projectId !== projectId) continue;
    const known = byId.get(session.id);
    // A chat that is awake is always worth seeing, whatever it is called. One
    // that is asleep and not in the list is one the list deliberately left out
    // (docs/agent-workbench.md §6.3.1).
    const awake = session.state !== 'dormant';
    if (!known && !awake) continue;
    if (known) {
      merged[merged.indexOf(known)] = {
        ...known,
        state: session.state,
        model: session.model,
        // The restore row has already asked the provider for its conversation
        // name. Keep that over our live session's temporary generated label.
        title: known.title ?? session.title,
        // Never backwards: the stream carries what our own driver has seen, and
        // the row may already hold a later time from the tool's index — a chat
        // being worked on in a terminal moves that index and not our driver.
        lastActiveAt: laterOf(known.lastActiveAt, session.lastActiveAt),
        // Never backwards here either, and for a second reason: the row may
        // carry a time read out of the chat's own record, which is the only
        // place a message he typed in a terminal is written down.
        lastSpokeAt: laterSpoke(known.lastSpokeAt, session.lastSpokeAt),
        beads: session.beads.length ? session.beads : known.beads,
        // The mark's own two halves, so the row says what the bar above it says
        // (protocol.ts, RestoreRow.activity; bw-96is.31).
        activity: session.activity,
        activityDetail: session.activityDetail ?? null,
        busySince: session.busySince,
      };
      continue;
    }
    merged.push({
      sessionId: session.id,
      externalId: null,
      brand: session.brand,
      model: session.model,
      title: session.title,
      lastActiveAt: session.lastActiveAt,
      lastSpokeAt: session.lastSpokeAt,
      state: session.state,
      origin: 'app',
      projectId: session.projectId,
      cwdHint: session.projectPath,
      folder: folderOf(session.projectPath),
      branch: null,
      beads: session.beads,
      activity: session.activity,
      activityDetail: session.activityDetail ?? null,
      busySince: session.busySince,
    });
  }

  // The mark last, and over everything: a chat that starts or stops being worked
  // in changes nothing else about its row, and the reader is not reloading.
  // Somebody ELSE has it, which is not the same question as a live process
  // being on it: our own driver's child is a live process on our own chat. The
  // chat's own line asks it this way and the row did not, so one chat read
  // "external" on the list and "Ready" in the bar above it (bw-jaoz.2).
  const marked = running
    ? merged.map((r) => {
        if (!r.externalId) return r;
        // Origin is history, not ownership. A chat created here can later be
        // resumed in a terminal after our driver has gone dormant, while an
        // app-owned live session can leave the same provider trace as an
        // outside process. `heldElsewhere` combines the current session state
        // with the current provider hold, so it is the one ownership question
        // every row asks regardless of where the chat began.
        const theirs = heldElsewhere(r.state, r.externalId, running);
        return {
          ...r,
          runningElsewhere: theirs,
          held: theirs ? (holds ? (holds.get(r.externalId) ?? null) : r.held) : null,
        };
      })
    : heldFactsAreOld
      ? merged.map((r) => (r.externalId ? { ...r, held: holderOnly(r.held) } : r))
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
  /**
   * Search, the "everything" switch and New Chat used to live on the bar
   * above the transcript; they belong to this list, not to it, so their
   * triggers are handed in from the tab that owns the state (bw-81wt.5).
   * Each is optional so a caller that only wants the list — a test among
   * them — is not made to wire up things it never shows.
   */
  onSearch?: () => void;
  onToggleEverything?: () => void;
  onNewChat?: (brand?: Brand) => void;
  newChatDefault?: Brand | 'ask';
  onNewChatDefault?: (choice: Brand | 'ask') => void;
  startingNewChat?: boolean;
  /**
   * The way out of the drawer, on a phone where this list IS the screen. Drawn
   * inside the list rather than only on the bar behind it: the bar is under the
   * sheet there, so the cross in here and the tap outside are the two ways out
   * a reader has (bw-81wt.30).
   */
  onClose?: () => void;
}

export function ChatSidebar({
  projectId,
  projectPath,
  openSessionId,
  onOpen,
  everything = false,
  onSearch,
  onToggleEverything,
  onNewChat,
  newChatDefault = 'ask',
  onNewChatDefault,
  startingNewChat = false,
  onClose,
}: ChatSidebarProps) {
  const providers = useProviders();
  const anyProviderAvailable = providers.some((provider) => provider.available);
  const [fetched, setFetched] = useState<RestoreRow[]>([]);
  const live = useLiveSessions();
  const running = useRunningElsewhere();
  const holds = useHolds();
  const heldFactsAreOld = useHeldFactsAreOld();
  const outOfStep = useHelperMismatch();
  // The order as it was last drawn. Read while rendering and written after, so
  // what he is pointing at is what decides where the rows go (holdStill).
  const settled = useRef<SettledRow[]>([]);
  const rows = useMemo(
    () => holdStill(withLive(fetched, live, projectId, running, holds, heldFactsAreOld), settled.current),
    [fetched, live, projectId, running, holds, heldFactsAreOld],
  );
  useEffect(() => {
    settled.current = asSettled(rows);
  }, [rows]);
  const [busy, setBusy] = useState<string | null>(null);
  const [ending, setEnding] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    const q = new URLSearchParams({ project: projectId, path: projectPath });
    if (everything) q.set('all', '1');
    const local = new URLSearchParams(q);
    local.set('local', '1');
    let reconciled = false;
    // Rows already in the durable store do not wait behind provider process
    // startup or a scan of every external record. Provider discovery still
    // runs on the same load and replaces this local picture when it completes.
    void request(`/api/workbench/restore?${local}`)
      .then(async (res) => {
        if (!res.ok) return;
        const rows = (await res.json()) as RestoreRow[];
        if (!reconciled && generation === loadGeneration.current) setFetched(rows);
      })
      .catch(() => undefined);
    try {
      const res = await request(`/api/workbench/restore?${q}`);
      if (res.ok && generation === loadGeneration.current) {
        const rows = (await res.json()) as RestoreRow[];
        if (generation !== loadGeneration.current) return;
        reconciled = true;
        setFetched(rows);
      }
    } catch {
      // The workbench may not be running; the board half is unaffected.
    }
  }, [projectId, projectPath, everything]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A chat begun somewhere that is not this app — in Zed, in a terminal — joins
   * the list on its own, within seconds, with nothing clicked.
   *
   * The sidecar watches the tools' own session folders and says one bare word
   * when they move (live.ts, `useHeardFromOutside`). The word carries no rows on
   * purpose, so the only answer to it is the fetch above: ask for the list
   * again, exactly as the tab does when it opens. Before this the chat was
   * invisible until the owner clicked a row, which asked again as a side effect
   * and made every chat appear at once (bw-uivp).
   *
   * The count is remembered rather than merely watched because React runs every
   * effect once when it is first set up, and doing that here would fetch the
   * list a second time on open for a word nobody said. This fetches when the
   * count has actually moved and at no other time: switching project re-makes
   * `load`, which runs this again and finds the count where it left it.
   *
   * It is this project's own count. The machine runs agents in many projects at
   * once, and the word used to be about all of them: four rebuilds of this list
   * in twelve idle seconds, for work nothing on this screen was showing
   * (bw-uivp.4).
   */
  const heardOutside = useHeardFromOutside(projectPath);
  const heardAt = useRef(heardOutside);

  useEffect(() => {
    if (heardAt.current === heardOutside) return;
    heardAt.current = heardOutside;
    void load();
  }, [heardOutside, load]);

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
      // so the transcript starts drawing on the click. The chat feed owns the
      // read-side reconciliation too, which makes a copied URL and this click
      // identical and prevents two concurrent imports of the same record.
      if (row.sessionId) {
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
            title: row.title,
            cwd: row.cwdHint,
            lastActiveAt: row.lastActiveAt,
            lastSpokeAt: row.lastSpokeAt,
          });
          // The list is asked again, so the row now carries the id it was just
          // given: without that it keeps reporting it has no chat, is never
          // highlighted as the open one, and invites a second click (bw-m8o.12).
          onOpen(s.id);
          void load();
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

  /**
   * Ends a chat: the agent is torn down and the row is marked `ended`.
   *
   * Nothing is deleted and nothing is hidden, so this needs no confirming — the
   * row it acts on stays exactly where it is, still carrying every word said in
   * it, and a click opens it again (the manager, 2026-08-25).
   *
   * Only ever a chat this app has a row for. The list also carries chats begun
   * in a terminal that we have never opened, and those have no id of ours and
   * no state of ours to end; the control is not drawn on them.
   */
  const end = useCallback(
    (row: RestoreRow) => {
      const sessionId = row.sessionId;
      if (!sessionId) return;
      setEnding(rowKey(row));
      setFailed(null);
      void (async () => {
        try {
          await sendCommand({ type: 'session.close', sessionId });
          // Asked again for the same reason opening asks: the row's own state
          // is what the list was handed, and nothing else would move it off
          // whatever it said before the click.
          await load();
        } catch (e) {
          setFailed(e instanceof Error ? e.message : String(e));
        } finally {
          setEnding(null);
        }
      })();
    },
    [load],
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
      className="flex h-full min-h-0 w-72 shrink-0 flex-col border-r border-border/60 md:w-full"
    >
      {/*
        Search, the "everything" switch and New Chat all live here now — they
        are what this list is for, not decorations on the bar above it. A
        caller that renders the list on its own (a test, mainly) gets none of
        these, because each trigger is optional and nothing here reaches for a
        prop that was not handed in (bw-81wt.5).
      */}
      {(onSearch || onToggleEverything || onNewChat || onClose) && (
        <TooltipProvider delayDuration={250}>
          <div data-testid="chat-sidebar-header" className="flex shrink-0 items-center gap-1 border-b border-border/60 p-2">
            {onSearch && <ToolButton icon={<Search />} label="Search chats" data-testid="open-search" onClick={onSearch} />}
            {onToggleEverything && (
              <ToolButton
                icon={<Bot />}
                label={everything ? "Hide the agents' own chats" : "Show the agents' own chats"}
                emphasis={everything ? 'loud' : 'quiet'}
                data-testid="toggle-everything"
                data-showing-everything={everything}
                onClick={onToggleEverything}
              />
            )}
            {onNewChat && (
              <div className="ml-auto flex shrink-0">
                <Button
                  size="sm"
                  variant="primary"
                  radius="md"
                  className="rounded-r-none border-r border-primary-foreground/20"
                  data-testid="new-chat-tool"
                  aria-label="New Chat"
                  disabled={startingNewChat || !anyProviderAvailable}
                  onClick={() => onNewChat()}
                >
                  {startingNewChat ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus data-testid="new-chat-plus" aria-hidden="true" />}
                  {startingNewChat ? 'Starting…' : 'New Chat'}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="primary"
                      radius="md"
                      className="rounded-l-none px-2"
                      aria-label="New chat options"
                      data-testid="new-chat-menu"
                      disabled={startingNewChat || !anyProviderAvailable}
                    >
                      <ChevronDown aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel>Start with</DropdownMenuLabel>
                    {providers.map((provider) => (
                      <DropdownMenuItem
                        key={provider.brand}
                        disabled={!provider.available}
                        title={provider.available ? undefined : whyUnavailable(provider)}
                        onSelect={() => onNewChat(provider.brand)}
                      >
                        <BrandIcon brand={provider.brand} /> New {brandName(provider.brand)} chat
                      </DropdownMenuItem>
                    ))}
                    {onNewChatDefault && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel>Main button</DropdownMenuLabel>
                        <DropdownMenuRadioGroup value={newChatDefault} onValueChange={(value) => onNewChatDefault(value as Brand | 'ask')}>
                          <DropdownMenuRadioItem value="ask">Ask every time</DropdownMenuRadioItem>
                          {providers.map(({ brand, available }) => (
                            <DropdownMenuRadioItem key={brand} value={brand} disabled={!available}>
                              Use {brandName(brand)} by default
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
            {/* Last on the row and only on a phone: on a wide screen the list
                is part of the shell and has nothing to close (bw-81wt.30). */}
            {onClose && (
              <ToolButton
                icon={<X />}
                label="Close the chat list"
                className={cn('shrink-0 md:hidden', onNewChat ? undefined : 'ml-auto')}
                data-testid="chat-rail-close"
                onClick={onClose}
              />
            )}
          </div>
        </TooltipProvider>
      )}

      {failed && (
        <p data-testid="restore-error" className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {failed}
        </p>
      )}

      {/*
        The helper feeding this list is older than the page reading it, so what
        each chat is doing cannot be known — and the loss is otherwise silent:
        every row still draws, with its title and its time and its cards, and
        only the marks are missing. Said here because here is where they are
        missing from, and said as the thing to do about it rather than as a
        fault, because there is exactly one thing to do (bw-96is.24, bw-kr4m).
      */}
      {outOfStep && (
        <p data-testid="helper-stale" className="border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          The helper behind this list is out of date, so no chat here can say what it is doing. Restart the app.
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
              const live = row.state !== 'dormant';
              // Something of ours is attached and can be taken away. Anything
              // else has nothing to close, so it is not offered one.
              const closable = Boolean(row.sessionId) && live && !row.runningElsewhere;
              const ownership = sessionOwnership(row.state, row.externalId, row.runningElsewhere === true);
              const state = chatState({
                state: row.state,
                label: row.activity,
                detail: row.activityDetail || null,
                since: row.busySince ? Date.parse(row.busySince) : null,
                held: row.held ?? (ownership.kind === 'elsewhere' ? {
                  id: row.externalId ?? '',
                  holder: row.origin === 'terminal' ? 'terminal' : 'program',
                  doing: 'working',
                  since: null,
                } : null),
                // A chat he has never spoken in is not coming back from
                // anywhere. Only a row the stream built for a chat made this
                // second says that outright; a row off the list says nothing
                // about it, and reads as spoken in, which is how every row read
                // before the question was asked.
                spokenIn: row.lastSpokeAt !== null,
              });
              // In the restore list this is activity, not availability. A row
              // with our agent attached (the close control proves it) and no
              // turn in flight is idle. The shared reader calls that standing
              // "Ready" elsewhere; on this row the manager asked for the
              // literal current activity: Idle (bw-zpyl.10).
              const rowState = closable && row.state === 'idle' ? { ...state, word: 'Idle' } : state;
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
                  data-brand={row.brand}
                  data-state={row.state}
                  // Somebody is working in this conversation right now, in a
                  // terminal or under another host. Not the same fact as
                  // `state`, which is what our own driver knows (protocol.ts).
                  data-running={row.runningElsewhere ? 'yes' : 'no'}
                  // The cards this chat worked on. Carried, not drawn — the ids
                  // are what a chat is looked up by, and the row has no room.
                  data-beads={row.beads.join(' ')}
                  // Where it ran, the same way: the chat's own bar draws this
                  // and its branch, so drawing it here too spent a line of a
                  // two-line row saying what the next screen says anyway.
                  data-folder={row.folder ?? ''}
                  // Two lines, never three: the name, then what it is doing.
                  // Everything else — the time, whoever else is in there — rides
                  // on one of those two lines, because a rail this narrow turns
                  // a third row into a wall of half-sentences.
                  className={cn(
                    'group/row px-3 py-2 text-sm',
                    row.sessionId && row.sessionId === openSessionId && 'bg-accent',
                  )}
                >
                  {/* Centred, not sat on the name's baseline. The clock is
                      three points smaller and in another typeface, and a shared
                      baseline dropped it visibly below the middle of the name
                      beside it — the two boxes are the same height, so centring
                      them is what puts the clock on the name's own line. */}
                  <div className="flex items-center gap-2">
                    {row.brand === 'local'
                      ? <ModelIcon brand={row.brand} model={row.model} className="text-muted-foreground" />
                      : <BrandIcon brand={row.brand} className="text-muted-foreground" />}
                    <Button
                      type="button"
                      variant="foreground"
                      size="inherit"
                      data-testid="row-name"
                      className="flex-1 justify-start truncate p-0 text-left text-foreground"
                      disabled={busy === key}
                      onClick={() => enter(row)}
                    >
                      {row.title ?? 'Untitled chat'}
                    </Button>
                    {/* Said once, here, and nowhere else on the row. There
                        used to be a badge under this as well, spelling out
                        "external" beside the chip — two marks for one fact on a
                        two-line row, and the mark beside the name is the one
                        the reader meets first (the manager, 2026-09-03). What
                        the badge alone carried, the holder, moved into this
                        tooltip rather than being dropped: a terminal somebody
                        types in and a program driving the kit are not the same
                        thing to whoever is deciding whether to take the chat. */}
                    {state.external && (
                      <span
                        data-testid="external-origin"
                        data-holder={state.external.holder}
                        aria-label={`${HOLDER_WORD[state.external.holder]}.`}
                        title={`${HOLDER_WORD[state.external.holder]}.`}
                        className="flex size-3.5 shrink-0 items-center text-muted-foreground"
                      >
                        <ExternalLink aria-hidden="true" className="size-3.5" />
                      </span>
                    )}
                    {/*
                      The control is drawn OVER the clock, not beside it. Beside
                      it, a button nobody could see still held its own width and
                      its gap on all forty rows, so every name in the list was
                      cut short to keep room for it (the manager, 2026-08-26).
                      Over it, the name has the whole line, and nothing moves
                      when the pointer arrives: this box is the clock's width
                      either way. The clock is what it covers because the clock
                      is the one thing on that end worth less than the control
                      while the reader is on the row.

                      Kept off the rail until then: a 288px list is already two
                      lines of small type per chat, and a button on every row is
                      forty things to read past to find the name — the same
                      reason the pill is not drawn on a sleeping row. Focus
                      brings it back for a reader who never hovers anything.

                      Only where there is an agent to take away. A sleeping chat
                      has none, and a chat another program is driving has none
                      of ours: closing that one from here would call it asleep
                      while a terminal went on typing into it (registry.ts,
                      runningElsewhere).
                    */}
                    <span className="relative flex shrink-0 items-center">
                      <span
                        className={cn(
                          'font-mono text-[11px] text-muted-foreground',
                          closable &&
                            'transition-opacity group-focus-within/row:opacity-0 group-hover/row:opacity-0',
                        )}
                      >
                        {clockTime(whenHeSpoke(row))}
                      </span>
                      {closable && (
                        <Button
                          type="button"
                          variant="ghost"
                          mode="icon"
                          size="xs"
                          data-testid="row-close"
                          aria-label={`Close ${row.title ?? 'Untitled chat'}`}
                          title="Close chat"
                          disabled={ending === key}
                          className="absolute -right-1.5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            end(row);
                          }}
                        >
                          <Power className="size-3.5" aria-hidden="true" />
                        </Button>
                      )}
                    </span>
                  </div>
                  {/*
                    What it is doing is the second line, and the whole of it. It
                    used to be the third, under a chip naming the folder — which
                    the chat's own bar names again the moment the row is clicked,
                    so the rail was spending a line of three on a fact the next
                    screen carries anyway (the manager, 2026-08-23).

                    Whoever else is in there is said beside the name and not
                    again here: the badge that used to ride at the far end of
                    this line said "external" a second time on a row that had
                    already said it (the manager, 2026-09-03).

                    The same reading the chat's own line draws, in the same words
                    (chat-state.ts). A row that is asleep says nothing at all,
                    because most of the list is asleep and a pill on every one of
                    them is a pill on none (bw-96is).
                  */}
                  {(busy === key ||
                    ending === key ||
                    closable ||
                    state.working ||
                    state.waiting ||
                    // Only where the holder has said something we can draw. The
                    // chip draws nothing at all for a hold that claims neither
                    // a state nor a verb, and this clause used to be here for
                    // the badge beside it — without the badge it would open an
                    // empty line under the name and push every row below it
                    // down by nothing anybody can read.
                    (ownership.kind === 'elsewhere' && rowState.word !== '')) && (
                    <div className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden">
                      {busy === key || ending === key ? (
                        <Badge
                          variant="warning"
                          appearance="light"
                          size="sm"
                          shape="circle"
                          data-testid="row-pill"
                          data-pill={busy === key ? 'opening' : 'ending'}
                          className="shrink-0"
                        >
                          {busy === key ? 'opening' : 'ending'}
                        </Badge>
                      ) : (
                        // The chip refuses to shrink everywhere else, which is
                        // right where it stands beside body text. Here it has
                        // the line to itself and what it is on cuts short only
                        // when the rail is genuinely too narrow for it
                        // (bw-jaoz.14.14).
                        //
                        // The word without its clause is not a rich status:
                        // "Helping", "Retrying" or "Summarising" only becomes
                        // actionable when the helper, reset time, or current
                        // work remains visible. ChatStateChip middle-ellipsizes
                        // that clause rather than dropping it.
                        <ChatStateChip state={rowState} testId="row-pill" className="min-w-0 shrink" />
                      )}
                    </div>
                  )}
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
