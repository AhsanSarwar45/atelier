/**
 * The Chat tab: transcript, composer, Stop button, permission cards, the tool
 * feed with its diffs and subagent nesting, and the checklist.
 *
 * Design: docs/agent-workbench.md §8.2. The sidebar, the card rail and the
 * report viewer arrive with their own work items.
 */
'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import {
  ArrowDown,
  ArrowUp,
  Bot,
  Coins,
  Cpu,
  Loader2,
  PanelLeft,
  Paperclip,
  Plus,
  Receipt,
  Search,
  ShieldCheck,
  Square,
  X,
} from 'lucide-react';

import { BeadChip } from '@/components/bead-chip-row';
import { type Mentions } from '@/components/markdown-body';
import { useReports } from '@/components/reports';
import { TabTools, ToolButton } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Panel } from '@/components/ui/panel';
import { Textarea } from '@/components/ui/textarea';
import { useHeldAtTheEnd } from '@/hooks/held-at-the-end';
import { addressWith } from '@/lib/address';
import { hueFor } from '@/lib/bead-labels';
import { cn } from '@/lib/utils';
import { ChatRightRail, useRightRail } from '@/workbench/chat-right-rail';
import { ChatSidebar } from '@/workbench/chat-sidebar';
import { chatState, heldLine, holderOnly } from '@/workbench/chat-state';
import { ChatStateChip, ExternalBadge } from '@/workbench/chat-state-chip';
import { KindFilter, NothingShowing } from '@/workbench/filter-tree';
import { useKnownCards } from '@/workbench/known-cards';
import { drawnRows } from '@/workbench/machine-lines';
import { inWords, PERMISSION_MODE } from '@/workbench/machine-words';
import { addressedBy, openableIn } from '@/workbench/mentions';
import { PathChip, openPathClicked } from '@/workbench/path-chip';
import { askableIn, pathsIn, type Rooted } from '@/workbench/paths';
import { usePathsOnDisk } from '@/workbench/paths-on-disk';
import { SplitPaths } from '@/workbench/split-paths';
import { useHeldFactsAreOld, useHolds, useLiveSessions, usePlanUsage, useRunningElsewhere } from '@/workbench/live';
import { EVERYTHING, remember, remembered, showing as stillShowing, type KindId } from '@/workbench/message-filter';
import type { CommandInfo, Cost, ImagePayload, TodoItem } from '@/workbench/protocol';
import { BRAND_DEFAULT_MODEL } from '@/workbench/protocol';
import { ReportChip } from '@/workbench/report-view';
import { heldElsewhere } from '@/workbench/running';
import { SearchPanel } from '@/workbench/search-panel';
import { SpendView } from '@/workbench/spend-view';
import { AgentView } from '@/workbench/agent-view';
import { DrawnTranscript } from '@/workbench/drawn-transcript';
import { WorkingLine, whatItWasAsked } from '@/workbench/transcript-rows';
import { ContextChip, TokenView } from '@/workbench/token-view';
import { PlanChip, UsageView } from '@/workbench/usage-view';
import { isBusy, readImage, sendCommand, useSession, useSessionFacts, type TranscriptItem } from '@/workbench/use-session';

/** Where the "show me everything" switch is remembered between visits. */
const EVERY_CHAT = 'workbench.every-chat';

/**
 * Everything one row of a conversation actually says, for going through once
 * to find the addresses in it. Nothing is drawn from this — it is only the list
 * of questions to put to disk before the reader looks (bw-khe.13).
 */
function textOfItem(item: TranscriptItem): string[] {
  if (item.kind === 'tool') {
    const asked =
      item.name === 'Bash' && typeof item.input.command === 'string'
        ? String(item.input.command)
        : whatItWasAsked(item.input);
    return [item.title, asked, item.output ?? '', item.diff?.path ?? ''];
  }
  if (item.kind === 'note') return [item.text, item.body ?? ''];
  if (item.kind === 'message' || item.kind === 'thinking' || item.kind === 'notice') return [item.text];
  return [];
}

interface ChatTabProps {
  projectId: string | null;
  projectPath: string | null;
  /** Attach to this existing session instead of offering a new one. */
  openSessionId?: string | null;
}

/**
 * One picker on the composer's row. What it lists is what the session itself
 * announced it can do, so it is never a list of guesses (§7).
 */
function Picker({
  icon,
  label,
  current,
  options,
  testid,
  asleep,
  onPick,
}: {
  icon: ReactNode;
  label: string;
  current: string | null;
  options: { value: string; label: string; hint?: string }[];
  testid: string;
  /** No agent is attached, so there is nothing to change until he writes. */
  asleep: boolean;
  onPick: (value: string) => void;
}) {
  if (!options.length) return null;
  const shown = options.find((o) => o.value === current)?.label ?? current ?? label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-testid={testid}
          data-current={current ?? ''}
          data-asleep={asleep}
          disabled={asleep}
          aria-label={label}
          // A sleeping chat has no agent to tell, and the command behind this
          // would fail silently; sending a message wakes it (bw-f1q.12).
          title={asleep ? `${label} — send a message to wake this chat first` : label}
          className="h-7 gap-1.5 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {icon}
          <span className="max-w-[18ch] truncate">{shown}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto" data-testid={`${testid}-menu`}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            data-testid={`${testid}-option`}
            data-value={o.value}
            data-picked={o.value === current}
            onSelect={() => onPick(o.value)}
            className="flex-col items-start gap-0.5"
          >
            <span className={cn('text-sm', o.value === current && 'font-semibold text-foreground')}>{o.label}</span>
            {o.hint && <span className="text-xs text-muted-foreground">{o.hint}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The `/` menu: the install's own commands and skills, filtered as he types.
 * Opens on a slash at the start of an empty-of-spaces draft, and picking one
 * writes it into the box — sending is ordinary, because that is how a command is
 * run (§7).
 */
function CommandMenu({
  matches,
  active,
  onPick,
}: {
  matches: CommandInfo[];
  active: number;
  onPick: (command: CommandInfo) => void;
}) {
  if (!matches.length) return null;
  return (
    <div
      data-testid="command-menu"
      className="mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
    >
      {matches.map((c, i) => (
        <button
          key={`${c.kind}:${c.name}`}
          type="button"
          data-testid="command-option"
          data-command={c.name}
          data-kind={c.kind}
          data-active={i === active}
          onMouseDown={(e) => {
            // Down, not click: the box must not lose focus before the pick lands.
            e.preventDefault();
            onPick(c);
          }}
          className={cn(
            'flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-sm',
            i === active ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/60',
          )}
        >
          <span className="shrink-0 font-mono">/{c.name}</span>
          {c.argumentHint && <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.argumentHint}</span>}
          <span className="min-w-0 truncate text-xs text-muted-foreground">{c.description}</span>
          {c.kind === 'skill' && (
            <Badge variant="secondary" appearance="light" size="xs" shape="circle" className="ml-auto shrink-0">
              skill
            </Badge>
          )}
        </button>
      ))}
    </div>
  );
}

/** A picture at full size, over the chat. Escape or a click away closes it. */
function PictureViewer({ image, onClose }: { image: ImagePayload; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  return (
    <div
      data-testid="picture-viewer"
      role="dialog"
      aria-label={image.alt || 'Picture'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        data-testid="picture-viewer-image"
        src={image.dataUrl}
        alt={image.alt}
        className="max-h-full max-w-full rounded shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      <Button
        variant="ghost"
        mode="icon"
        size="sm"
        aria-label="Close the picture"
        data-testid="picture-viewer-close"
        className="absolute right-4 top-4 text-white"
        onClick={onClose}
      >
        <X className="h-5 w-5" />
      </Button>
    </div>
  );
}

/**
 * The one click back to the newest words.
 *
 * A chat that quietly stops following its own end has to say so, or a reader
 * who scrolled up has no way of knowing anything more was said and no way back
 * but scrolling for it (bw-n6yh). Mounted either way and faded, so it arrives
 * and leaves with the reader rather than appearing under his cursor.
 */
function BackToNow({ missed, shown, onClick }: { missed: number; shown: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="back-to-now"
      data-shown={shown ? 'yes' : 'no'}
      data-missed={missed}
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      onClick={onClick}
      title={missed > 0 ? `${missed} more since you scrolled up — back to now` : 'Back to the newest message'}
      className={cn(
        'absolute bottom-4 right-4 z-10 flex items-center gap-1.5 rounded-full border border-border',
        'bg-surface-raised px-3 py-1.5 text-muted-foreground shadow-lg transition-all hover:text-foreground',
        shown ? 'pointer-events-auto opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
      )}
    >
      <ArrowDown className="h-4 w-4" />
      {missed > 0 && (
        <span data-testid="back-to-now-count" className="text-xs font-medium tabular-nums">
          {missed}
        </span>
      )}
    </button>
  );
}

/** The agent's checklist, as it stands right now. */
function TodoPanel({ items }: { items: TodoItem[] }) {
  if (!items.length) return null;
  return (
    <Panel data-testid="todo-panel">
      <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Checklist</div>
      <ul className="space-y-1">
        {items.map((t) => (
          <li key={t.id} data-testid="todo-item" data-todo-status={t.status} className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border text-[10px]',
                t.status === 'completed'
                  ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300'
                  : t.status === 'in_progress'
                    ? 'animate-pulse border-amber-400 bg-amber-400/20 text-amber-300'
                    : 'border-border text-transparent',
              )}
            >
              {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : ''}
            </span>
            <span className={cn(t.status === 'completed' && 'text-muted-foreground line-through')}>{t.text}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * What a conversation has spent, in whatever the brand bills in: money on the
 * ones that charge money, tokens on the ones that do not.
 */
function costLabel(cost: Cost): string {
  return cost.kind === 'usd' ? `$${cost.usd.toFixed(4)}` : `${cost.total.toLocaleString()} tokens`;
}

export default function ChatTab({ projectId, projectPath, openSessionId }: ChatTabProps) {
  const router = useRouter();
  const params = useSearchParams();
  // The address is which chat is open — never a state of this component's own.
  // A chat opened here, a link from a card and the Back button all arrive the
  // same way (docs/designs/app-shell.md §1.7).
  const sessionId = openSessionId ?? null;
  const open = useCallback(
    (id: string) => router.push(addressWith(params, { tab: 'chat', chat: id })),
    [router, params],
  );
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  /** What went wrong the last time he changed the mode or the model. */
  const [steerError, setSteerError] = useState<string | null>(null);
  /** Why the last thing he wrote did not go, if it did not go. */
  const [sendError, setSendError] = useState<string | null>(null);
  const start = useCallback(async () => {
    if (!projectId || !projectPath) return;
    setStarting(true);
    setStartError(null);
    try {
      const s = await sendCommand<{ id: string }>({
        type: 'session.start',
        projectId,
        projectPath,
        brand: 'claude',
      });
      open(s.id);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, [projectId, projectPath, open]);
  const view = useSession(sessionId);
  const facts = useSessionFacts(sessionId);
  // What the board knows plus what this chat has been seen doing since.
  const cards = Array.from(new Set([...(facts?.beads ?? []), ...view.beads]));
  // A report names the card it belongs to, so the reports of this chat's cards
  // are this chat's reports — true for a chat this app never watched work. A
  // report belongs to the goal while a chat works that goal's steps, so a step
  // counts as its goal here: `cor-qrnj.43` finds the report on `cor-qrnj`.
  const { reports } = useReports();
  const owned = new Set(cards.flatMap((id) => [id, id.split('.')[0]!]));
  const ours = reports.filter((r) => r.card !== null && owned.has(r.card));

  // A card or a report the agent NAMED in its own words opens from where it is
  // written. Only ones that exist: English is full of hyphenated words shaped
  // like a card id, so the board's own list and the reports this project has
  // are what decide (bw-4wcd.3, src/workbench/mentions.ts).
  const knownCards = useKnownCards(projectPath);
  const byName = useMemo(() => new Map(reports.map((r) => [r.slug, r])), [reports]);

  // A file the agent named opens from where it is written, the same way. Only
  // ones that are really there: `and/or` and `24/7` are shaped like addresses
  // too, so disk is what decides (bw-khe.13, src/workbench/paths.ts). What a
  // relative name means is decided by the folder THIS chat ran in.
  const disk = usePathsOnDisk();
  const where = useMemo<Rooted>(
    () => ({ cwd: facts?.cwd ?? projectPath ?? '', home: disk.home }),
    [facts?.cwd, projectPath, disk.home],
  );
  const splitPaths = useCallback((text: string) => pathsIn(text, where, disk), [where, disk]);

  // Everything the conversation says, gone through once for the addresses in
  // it, so the answers are already back by the time the reader looks.
  useEffect(() => {
    const asking = new Set<string>();
    for (const item of view.items) {
      for (const text of textOfItem(item)) for (const p of askableIn(text, where)) asking.add(p);
    }
    if (asking.size > 0) disk.ask(Array.from(asking));
  }, [view.items, where, disk]);

  const mentions = useMemo<Mentions>(() => {
    const card = (id: string) => (
      <BeadChip id={id} projectId={projectId} size="xs" testId="mention-card" className="mx-0.5" />
    );
    const report = (slug: string) => {
      const found = byName.get(slug);
      if (!found) return slug;
      return <ReportChip project={found.project} slug={found.slug} title={found.title} className="mx-0.5" />;
    };
    return {
      split: (text) =>
        openableIn(
          text,
          { card: (id) => knownCards.has(id), report: (slug) => byName.has(slug) },
          where,
          disk,
        ),
      path: (absolute, raw, line) => <PathChip absolute={absolute} raw={raw} line={line} />,
      card,
      report,
      // The very same two chips, from an address written out in full. It is how
      // an agent hands over a report it has just written, and it was the one
      // thing in a message that stayed raw blue text (bw-8fh2.2). Only ours,
      // and only when the thing it names really is on this project — anything
      // else stays the link it was.
      link: (href) => {
        const named = addressedBy(href);
        if (!named) return null;
        if (named.kind === 'card') return knownCards.has(named.id) ? card(named.id) : null;
        return byName.has(named.slug) ? report(named.slug) : null;
      },
    };
  }, [knownCards, byName, projectId, projectPath, where, disk]);
  const [draft, setDraft] = useState('');
  const [attached, setAttached] = useState<ImagePayload[]>([]);
  /** The picture being looked at, from the tray or from a message. */
  const [looking, setLooking] = useState<ImagePayload | null>(null);
  /** Which sent-off agent's own conversation is open, by the call that sent it. */
  const [openAgent, setOpenAgent] = useState<string | null>(null);
  /**
   * That agent as it stands now, or nothing.
   *
   * Looked up rather than held: a chat whose transcript is read again loses
   * every row it had, and a pane still holding one of them would be showing a
   * conversation this chat no longer has.
   */
  const agentOpen = useMemo(
    () => (openAgent ? (view.agents.find((a) => a.id === openAgent) ?? null) : null),
    [openAgent, view.agents],
  );
  /** Which entry the `/` menu has under the cursor. */
  const [pick, setPick] = useState(0);
  /** The `/` menu, put away by hand until the next keystroke. */
  const [shut, setShut] = useState(false);
  /** Only ever seen on a narrow screen; the rail is always there on a wide one. */
  const [railOpen, setRailOpen] = useState(false);
  /** The chat's own column on the right, remembered between visits. */
  const [rightOpen, flipRight] = useRightRail();
  /** The two ways in that live in this tab's toolbar, each a full-screen panel. */
  const [showing, setShowing] = useState<'search' | 'spend' | 'usage' | 'tokens' | null>(null);
  /** The ACCOUNT'S allowance — the same figure in every chat, not this one's (bw-malh). */
  const plan = usePlanUsage();
  /**
   * Whether the list also holds the chats an agent started for another chat.
   * Off unless he says otherwise, and remembered, because it is a way of
   * looking rather than a thing to set again each visit.
   */
  const [everything, setEverything] = useState(false);

  useEffect(() => {
    setEverything(localStorage.getItem(EVERY_CHAT) === '1');
  }, []);

  /** Written where it is changed, for the reason spelled out on `flipOpenAll`. */
  const flipEverything = useCallback(() => {
    setEverything((was) => {
      localStorage.setItem(EVERY_CHAT, was ? '0' : '1');
      return !was;
    });
  }, []);
  /**
   * Which kinds of message the conversation draws. Remembered for the browser
   * rather than the chat: it is a way of reading, not a property of one
   * conversation (bw-qdim).
   */
  const [offKinds, setOffKinds] = useState<ReadonlySet<KindId>>(EVERYTHING);

  useEffect(() => {
    setOffKinds(remembered());
  }, []);

  /** Written where it is changed, for the reason spelled out on `flipOpenAll`. */
  const changeKinds = useCallback((off: ReadonlySet<KindId>) => {
    remember(off);
    setOffKinds(off);
  }, []);

  /** The rows this conversation draws, once the reader's switches are obeyed. */
  const rows = useMemo(() => stillShowing(view.items, offKinds), [view.items, offKinds]);

  /**
   * The same rows as they are drawn: every machine line carrying the family that
   * decides its colour and its mark, and a run of one kind folded into a single
   * chip (bw-jkh2).
   */
  const drawn = useMemo(() => drawnRows(rows), [rows]);

  /** The pane the conversation scrolls in, which the window keeps the place of. */
  const pane = useRef<HTMLDivElement>(null);
  const typing = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  /**
   * Where the reader is in the conversation, and whether the newest words are
   * what he is looking at. Everything that follows the end goes through this:
   * the chat used to put its end back in view on every change to the
   * transcript, which is once per word while an answer arrives, so reading
   * history meant being dragged back down over and over (bw-n6yh).
   */
  const { held: atTheEnd, toTheEnd, paneRef, contentRef } = useHeldAtTheEnd(pane);

  // Another conversation opens at its own end, not at the place this one was
  // read to, and before the first frame is drawn.
  useLayoutEffect(() => {
    toTheEnd();
  }, [sessionId, toTheEnd]);

  /** How much of the conversation had arrived when he last left the end. */
  const marked = useRef(0);
  /** What has been said since — the number on the way back to now. */
  const [missed, setMissed] = useState(0);

  useEffect(() => {
    if (atTheEnd) {
      marked.current = drawn.length;
      setMissed(0);
    } else {
      setMissed(Math.max(0, drawn.length - marked.current));
    }
  }, [atTheEnd, drawn.length]);

  // One line at rest, growing to what is written. Measured from the content,
  // because a textarea cannot shrink itself back down once it has been sized.
  useEffect(() => {
    const box = typing.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight}px`;
  }, [draft]);

  const busy = isBusy(view.state);
  /** No agent attached: it is drawn, and the first message is what wakes it. */
  const asleep = view.state === 'dormant' || view.state === 'ended';

  /**
   * Another program on this machine is driving this very conversation: what it
   * does is drawn here as it happens, and typing is what cannot be done. The
   * rule is in running.ts with the rest of the reasoning about live chats.
   */
  const elsewhere = useRunningElsewhere();
  // The stream first: it is already connected when a chat is opened, while the
  // chat's own facts are a board query away and the box must refuse from the
  // first frame it draws (live.ts, LiveSession.externalId).
  const live = useLiveSessions().find((s) => s.id === sessionId);
  const externalId = live?.externalId ?? facts?.externalId ?? null;
  const held = heldElsewhere(view.state, externalId, elsewhere, facts?.runningElsewhere);
  // What that program is doing, from the stream while it is connected and from
  // the chat's own facts until it has spoken (bw-96is).
  const holds = useHolds();
  // Those facts were fetched when this chat was opened and are never fetched
  // again, so they answer for the moment before the stream speaks and for no
  // other. Once it has spoken and gone away they are the oldest thing on the
  // screen, and drawing them would restart the mark and count its seconds from
  // whenever the pane happened to be opened (bw-96is.22).
  const heldFactsAreOld = useHeldFactsAreOld();
  const said = holds?.get(externalId ?? '') ?? (holds ? null : facts?.held) ?? null;
  const holder = !held || !externalId ? null : heldFactsAreOld ? holderOnly(said) : said;

  /**
   * When the agent started owing an answer. The counting itself is the working
   * line's own business — a beat here redrew the whole conversation once a
   * second for as long as the agent worked (bw-uiyz.5).
   */
  const [busySince, setBusySince] = useState<number | null>(null);
  useEffect(() => {
    setBusySince(busy ? Date.now() : null);
    // Restarted whenever the WORDS change, not merely the kind of work: two
    // reads in a row are both `running_tool`, and counting from the first would
    // show a one-second read as forty (bw-f1q.17).
  }, [busy, view.state, view.stateLabel]);
  /**
   * The one reading every screen draws (chat-state.ts). A held chat is read
   * from what the holder says about itself; ours from our own driver's word.
   */
  const state = chatState({
    state: view.state,
    label: view.stateLabel,
    since: busySince,
    held: held ? (holder ?? { id: externalId ?? '', holder: 'program', doing: 'unknown', since: null }) : null,
  });

  const running = view.items.find((it) => it.kind === 'tool' && it.status === 'running');
  const reported = running && running.kind === 'tool' ? running.seconds : 0;

  /** The `/` menu is open only while the draft is one unfinished word starting with a slash. */
  const typedCommand = /^\/(\S*)$/.exec(draft)?.[1] ?? null;
  const found = useMemo(() => {
    if (typedCommand === null) return [];
    const wanted = typedCommand.toLowerCase();
    return view.menu.commands.filter((c) => c.name.toLowerCase().startsWith(wanted)).slice(0, 40);
  }, [typedCommand, view.menu.commands]);
  // Put away by hand, until the next thing he types. Escape used to empty the
  // whole box instead, so dismissing the list threw away the line — and a
  // command he meant to send as it stands could not be (bw-1u1.14).
  const matches = shut ? [] : found;
  useEffect(() => setPick(0), [typedCommand]);

  function take(command: CommandInfo) {
    // Written into the box rather than sent: he may want to add an argument, and
    // a command is ordinary prompt text either way (§7).
    setDraft(`/${command.name} `);
    typing.current?.focus();
  }

  async function submit() {
    const text = draft.trim();
    if (!text || !sessionId) return;
    const images = attached;
    setDraft('');
    setAttached([]);
    setSendError(null);
    try {
      await sendCommand({ type: 'prompt.send', sessionId, text, images });
    } catch (e) {
      // The server can refuse this: another program took the conversation over
      // between the box unlocking and the send, or the screen's own copy of who
      // is working was stale (bw-dmxj.12). Either way what he wrote is his, and
      // it goes back in the box he wrote it in rather than into the void.
      setDraft(draft);
      setAttached(images);
      setSendError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Pictures arrive by paste or by drop; both land in the same tray. */
  async function absorb(files: FileList | File[] | null) {
    const pictures = Array.from(files ?? []).filter((f) => f.type.startsWith('image/'));
    if (!pictures.length) return;
    const read = await Promise.all(pictures.map(readImage));
    setAttached((prev) => [...prev, ...read]);
  }

  if (!projectId || !projectPath) {
    return <div className="p-8 text-muted-foreground">Pick a project to start a chat.</div>;
  }

  /**
   * On a phone the conversation gets the whole screen and the list of chats
   * becomes a drawer over it: a 288px rail beside a 390px screen leaves the
   * transcript unreadable, and the composer is what must stay in reach.
   */
  const shell = (inner: React.ReactNode) => (
    // The height is the shell's to give: this box fills what the bars left.
    <div className="relative flex min-h-0 flex-1">
      <TabTools tab="chat">
        <ToolButton
          icon={<PanelLeft />}
          label="Chats"
          className="md:hidden"
          data-testid="chat-rail-toggle"
          onClick={() => setRailOpen((v) => !v)}
        />
        <ToolButton icon={<Search />} label="Search chats" data-testid="open-search" onClick={() => setShowing('search')} />
        <ToolButton icon={<Receipt />} label="What it cost" data-testid="open-spend" onClick={() => setShowing('spend')} />
        <ToolButton
          icon={<Bot />}
          label={everything ? 'Hide the agents’ own chats' : 'Show the agents’ own chats'}
          emphasis={everything ? 'loud' : 'quiet'}
          data-testid="toggle-everything"
          data-showing-everything={everything}
          onClick={flipEverything}
        />
        <KindFilter items={view.items} off={offKinds} onChange={changeKinds} />
        {/* The one control on this bar that says what it does in words. Every
            other tool here is a picture, and a picture is right for a thing you
            reach for once you know the bar; starting a conversation is the first
            thing a reader wants and the one he was hunting for (bw-4wcd.8). */}
        <Button
          size="sm"
          variant="primary"
          className="ml-auto shrink-0"
          data-testid="new-chat-tool"
          aria-label="New Chat"
          disabled={starting}
          onClick={() => void start()}
        >
          {starting ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : (
            /* The plus is drawn, not typed: a typed one is a letter of the
               label and sits on the text's own baseline, a hair small and a
               hair low against the words beside it (bw-4wcd.14). */
            <Plus data-testid="new-chat-plus" aria-hidden="true" />
          )}
          {starting ? 'Starting…' : 'New Chat'}
        </Button>
      </TabTools>

      {showing === 'search' && <SearchPanel onClose={() => setShowing(null)} />}
      {showing === 'spend' && <SpendView onClose={() => setShowing(null)} />}
      {showing === 'usage' && <UsageView onClose={() => setShowing(null)} />}
      {showing === 'tokens' && sessionId && (
        <TokenView sessionId={sessionId} onClose={() => setShowing(null)} />
      )}

      <div
        data-testid="chat-rail"
        data-open={railOpen}
        className={cn(
          'z-30 h-full shrink-0 bg-background transition-transform md:relative md:translate-x-0',
          'absolute inset-y-0 left-0',
          railOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full',
        )}
      >
        <ChatSidebar
          projectId={projectId}
          projectPath={projectPath}
          openSessionId={sessionId}
          everything={everything}
          onOpen={(id) => { setRailOpen(false); open(id); }}
        />
      </div>
      {/* Mounted either way and faded, so the darkening arrives with the panel
          instead of snapping on in front of it (bw-7ks.22.12). */}
      <button
        type="button"
        aria-hidden={!railOpen}
        tabIndex={railOpen ? 0 : -1}
        aria-label="Close the chat list"
        data-testid="chat-rail-scrim"
        data-open={railOpen}
        className={cn(
          'absolute inset-0 z-20 bg-black/40 md:hidden',
          'transition-opacity duration-200 ease-out motion-reduce:transition-none',
          railOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={() => setRailOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">{inner}</div>
      {/* The chat's own column. Only when there IS a chat: an empty rail beside
          an empty screen says nothing and takes width to say it. */}
      {sessionId && (
        <ChatRightRail
          projectId={projectId}
          cards={cards}
          reports={ours}
          agents={view.agents}
          sessionId={sessionId}
          agentControls={view.menu.agentControls}
          onOpenAgent={setOpenAgent}
          open={rightOpen}
          onToggle={flipRight}
        />
      )}
      {sessionId && (
        <button
          type="button"
          aria-hidden={!rightOpen}
          tabIndex={rightOpen ? 0 : -1}
          aria-label="Close what this chat has touched"
          data-testid="chat-right-rail-scrim"
          data-open={rightOpen}
          className={cn(
            'absolute inset-0 z-20 bg-black/40 md:hidden',
            'transition-opacity duration-200 ease-out motion-reduce:transition-none',
            rightOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          onClick={flipRight}
        />
      )}
    </div>
  );

  if (!sessionId) {
    return shell(
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">No chat open for this project.</p>
        <Button variant="primary" onClick={() => void start()} disabled={starting} data-testid="new-chat">
          {starting ? null : <Plus data-testid="new-chat-empty-plus" aria-hidden="true" />}
          {starting ? 'Starting…' : 'New Chat'}
        </Button>
        {startError && <p className="max-w-lg text-center text-sm text-red-500">{startError}</p>}
      </div>,
    );
  }

  return shell(
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-tab" data-session-id={sessionId}>
      {/* One line, and nothing on it grows with the work: the cards, the
          reports and what the chat has spent are all in the column beside it
          (docs/agent-workbench.md §8.2.6). */}
      <div
        data-testid="chat-status-line"
        className="flex h-10 shrink-0 items-center gap-3 overflow-hidden border-b border-border/60 px-4 text-sm"
      >
        {/* A chat another program is working in has no agent of OURS attached,
            which is what "Asleep" describes and not what the reader is looking
            at: the messages arrive as that program works. So the line says what
            the holder says it is doing, and wears the badge beside it — the two
            are separate facts and the badge never stands in for the first
            (bw-96is). Both clear themselves when that program stops, because
            the stream they are read from does (bw-dmxj.10). */}
        <span
          data-testid="session-state"
          data-state={held ? 'held' : view.state}
          className="flex shrink-0 items-center gap-2"
        >
          <ChatStateChip state={state} size="line" testId="session-state-chip" />
          {state.external && <ExternalBadge holder={state.external.holder} size="line" />}
        </span>
        {/* The one thing on this line allowed to give way when the line runs
            short, and the only one that can: the model and the permission mode
            are both named again on the writing box below, while every chip
            beside it is a number or a name that means nothing half-drawn. Left
            to itself it kept its full width and the chips shrank under their
            own words, so what the chat was running printed straight across the
            folder chip (bw-7ks.22.15). */}
        <span
          data-testid="session-meta"
          className="min-w-0 shrink truncate whitespace-nowrap text-xs text-muted-foreground"
        >
          claude
          {view.model ? ` · ${view.model}` : ''}
          {view.permissionMode ? ` · permission mode: ${view.permissionMode}` : ''}
        </span>
        {facts?.folder && (
          <Badge
            hue={hueFor(facts.folder)}
            appearance="light"
            size="sm"
            shape="circle"
            data-testid="chat-folder-chip"
            data-folder={facts.folder}
            data-branch={facts.branch ?? ''}
            // The whole path and the branch in the tooltip: the chip has room
            // for the one word that tells two copies of a project apart.
            title={[facts.cwd, facts.branch].filter(Boolean).join(' · ')}
            // Never squeezed by the line, and never wider than a name: a chip
            // that shrinks under its own text spills it over its neighbour
            // (bw-7ks.22.15).
            className="max-w-40 shrink-0 truncate font-mono"
          >
            {facts.folder}
          </Badge>
        )}
        {/* What this chat is using and what it has spent, then how much of the
            account's own five-hour allowance is gone. All three are numbers a
            reader watching the work has to see without opening anything, so
            they live on the line and not in the column beside it — the column
            holds what the chat produced (bw-7ks.22.13, bw-malh). Each wears its
            own mark, because three bare numbers in a row read as one. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {view.context && (
            <ContextChip
              used={view.context.used}
              window={view.context.window}
              onOpen={() => setShowing('tokens')}
            />
          )}
          {view.cost && (
            <Badge
              variant="secondary"
              appearance="light"
              size="sm"
              data-testid="cost-chip"
              data-kind={view.cost.kind}
              data-total={view.cost.kind === 'usd' ? view.cost.usd : view.cost.total}
              title="What this conversation has spent so far, counting every agent it sent off"
              className="font-mono"
            >
              <Coins />
              {costLabel(view.cost)}
            </Badge>
          )}
          <PlanChip usage={plan} onOpen={() => setShowing('usage')} />
        </div>
      </div>

      {view.todos.length > 0 && (
        <div className="border-b border-border/60 px-4 py-2">
          <TodoPanel items={view.todos} />
        </div>
      )}

      <SplitPaths.Provider value={splitPaths}>
      {/* The conversation and the one way back to it, which floats over its
          bottom corner rather than taking a line of its own. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={paneRef}
        // The browser keeps a pane's place for it by moving the pane when
        // something above changes size, which is a scroll nobody made and which
        // this chat reads as the reader taking it over. It holds its own place —
        // at the end while that is what he is watching, and on his own row when
        // older messages arrive above him — so the browser's guess is turned off.
        className="mx-auto w-full max-w-[110ch] flex-1 overflow-y-auto px-4 py-4 [overflow-anchor:none]"
        data-testid="transcript"
        // One listener for every file chip in the conversation, wherever it was
        // drawn: in a message, in a command, or on a tool row's own line. A
        // chip that answers here never lets the click reach what it sits inside
        // (bw-khe.13).
        //
        // On the way DOWN, not up: a tool row's toggle sits below this, and by
        // the time a click had bubbled back to here that button had already run
        // and opened the row. Caught on the way down, stopping the click stops
        // everything under it — the row a chip sits on stays as the reader left
        // it, which the browser check proves.
        onClickCapture={(e) => openPathClicked(e)}
      >
        {/* One box around the whole conversation, whose height is what says the
            conversation grew — a picture arriving late or a line still being
            typed moves it without a row being added, and the reader watching
            the end must stay at the end through both. */}
        <div ref={contentRef} data-testid="transcript-rows" className="flex flex-col gap-3">
        {rows.length === 0 && view.items.length > 0 && (
          <NothingShowing hidden={view.items.length} onShowAll={() => changeKinds(EVERYTHING)} />
        )}
        <DrawnTranscript
          rows={drawn}
          sessionId={sessionId}
          mentions={mentions}
          onLook={setLooking}
          pane={pane}
          held={atTheEnd}
        />
        {view.error && <div className="text-sm text-red-500">{view.error}</div>}
        {/* What it is doing, where he is looking. Present exactly while it owes
            an answer (docs/agent-workbench.md §8.2.2). */}
        {busy && (
          <WorkingLine
            label={view.stateLabel}
            since={busySince}
            reported={reported}
            waiting={view.state === 'waiting_permission'}
            thought={view.thinkingTokens}
          />
        )}
        </div>
      </div>
      {/* The way back floats over the conversation's own bottom corner, the way
          every chat draws it. It was given a strip of its own for a while, to
          keep it off the last line of text (bw-n6yh.9); a whole row of empty
          screen between the conversation and the box you type in costs more
          than the corner of one line it sits over, and the manager asked for it
          floating (bw-n6yh.13). The frame is the width of the conversation
          rather than the window, so the button sits at the text's own right
          edge on a wide screen, and passes clicks through everywhere else. */}
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-full max-w-[110ch] -translate-x-1/2">
        <BackToNow missed={missed} shown={!atTheEnd} onClick={() => toTheEnd('smooth')} />
      </div>
      </div>
      </SplitPaths.Provider>

      <div className="border-t border-border/60 px-4 py-3">
        {/* Nothing to write in while another program holds the conversation.
            The box used to be drawn in full and refuse every keystroke, which
            is a door with a lock on it where there is no door: typing here
            would wake a SECOND agent on the same record (§6.3.3), so what
            stands in its place is the one line that says who is in there. It
            comes back by itself when they let go, because the stream this is
            read from does (bw-96is). The line's words are the reading's, so it
            cannot contradict the mark at the top of the pane (bw-96is.9). */}
        {held ? (
          <p data-testid="held-elsewhere" className="mx-auto w-full max-w-[110ch] px-1 text-xs text-muted-foreground">
            {heldLine(state)}
          </p>
        ) : (
        <div
          data-testid="composer-frame"
          className={cn(
            'mx-auto w-full max-w-[110ch] rounded-2xl border bg-surface-raised px-4 py-3 shadow-sm transition-colors',
            'border-border focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30',
          )}
        >
          {attached.length > 0 && (
            <div data-testid="attachment-tray" className="mb-2 flex flex-wrap gap-2">
              {attached.map((img, i) => (
                <span key={i} className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    data-testid="attachment-thumb"
                    src={img.dataUrl}
                    alt={img.alt}
                    title={`${img.alt} — click to see it full size`}
                    onClick={() => setLooking(img)}
                    className="h-12 w-12 cursor-zoom-in rounded border border-border/60 object-cover"
                  />
                  <button
                    type="button"
                    data-testid="attachment-remove"
                    aria-label={`Remove ${img.alt}`}
                    onClick={() => setAttached((all) => all.filter((_, at) => at !== i))}
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-background p-0.5 text-muted-foreground shadow hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* His own commands and skills, as this session announced them (§7). */}
          <CommandMenu matches={matches} active={pick} onPick={take} />
          {steerError && (
            <p data-testid="steer-error" className="mb-2 text-xs text-red-500">
              {steerError}
            </p>
          )}
          {sendError && (
            <p data-testid="send-error" className="mb-2 text-xs text-red-500">
              {sendError}
            </p>
          )}
          <input
            ref={picker}
            data-testid="image-input"
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => void absorb(e.target.files)}
          />
          <Textarea
            ref={typing}
            data-testid="composer"
            rows={1}
            value={draft}
            onChange={(e) => {
              setShut(false);
              setDraft(e.target.value);
            }}
            onPaste={(e) => void absorb(Array.from(e.clipboardData.files))}
            onDrop={(e) => {
              e.preventDefault();
              void absorb(e.dataTransfer.files);
            }}
            onKeyDown={(e) => {
              if (matches.length) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setPick((n) => (n + 1) % matches.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setPick((n) => (n - 1 + matches.length) % matches.length);
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault();
                  take(matches[pick] ?? matches[0]!);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setShut(true);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            // No held case here: a held chat draws no box at all, so a disabled
            // one with a sentence in it is unreachable — and the sentence it
            // still carried claimed the holder was working, which is the whole
            // thing this job took out of the screens (bw-96is.13).
            placeholder="Ask the agent to do something…"
            // The frame is the box; the typing area inside it carries no second
            // edge, no shadow and no colour of its own, and it grows with what
            // is written until it would take the conversation's room.
            className="max-h-56 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-[15px] leading-6 shadow-none focus-visible:ring-0"
          />
          <div className="mt-1.5 flex items-center gap-1">
            {/* A plain button, not the toolbar's: that one speaks through a
                tooltip and only works inside the bar that hosts one. */}
            <Button
              variant="ghost"
              mode="icon"
              size="sm"
              aria-label="Attach a picture"
              title="Attach a picture"
              data-testid="attach-picture"
              className="rounded-full text-muted-foreground"
              onClick={() => picker.current?.click()}
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            {/* Both act on THIS chat, and are kept in his own settings so the
                next one opens on them too (§8.2.3). */}
            <Picker
              icon={<ShieldCheck className="h-3.5 w-3.5" />}
              label="Permission mode"
              testid="mode-picker"
              current={view.permissionMode}
              asleep={asleep}
              // The setting's own spelling is not a label: `bypassPermissions`
              // is what he has to read to know whether this chat still asks
              // (src/workbench/machine-words.ts, bw-iiv6).
              options={view.menu.permissionModes.map((m) => ({
                value: m,
                label: PERMISSION_MODE[m]?.label ?? inWords(m),
              }))}
              onPick={(mode) => {
                setSteerError(null);
                void sendCommand({ type: 'session.mode', sessionId, mode }).catch((e: unknown) =>
                  setSteerError(e instanceof Error ? e.message : String(e)),
                );
              }}
            />
            <Picker
              icon={<Cpu className="h-3.5 w-3.5" />}
              label="Model"
              testid="model-picker"
              // A session that has not been given a model is on the brand's own
              // default, and the list has a row for exactly that.
              current={view.model ?? BRAND_DEFAULT_MODEL}
              asleep={asleep}
              options={view.menu.models.map((m) => ({
                value: m.value,
                label: m.displayName,
                hint: m.description,
              }))}
              onPick={(model) => {
                setSteerError(null);
                void sendCommand({ type: 'session.model', sessionId, model }).catch((e: unknown) =>
                  setSteerError(e instanceof Error ? e.message : String(e)),
                );
              }}
            />
            <span className="ml-auto" />
            {busy ? (
              <Button
                variant="destructive"
                mode="icon"
                size="sm"
                aria-label="Stop"
                data-testid="stop-button"
                className="rounded-full"
                onClick={() => void sendCommand({ type: 'session.stop', sessionId })}
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                variant="primary"
                mode="icon"
                size="sm"
                aria-label="Send"
                data-testid="send-button"
                className="rounded-full"
                onClick={() => void submit()}
                // Nothing about who holds the chat here: a held one draws no
                // box at all a few lines up, so a second half to this test
                // could never come out true. What stops a send while someone
                // else is in there is the composer not being drawn at all,
                // which is what the browser checks measure (bw-96is.23).
                disabled={!draft.trim()}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        )}
      </div>

      {looking && <PictureViewer image={looking} onClose={() => setLooking(null)} />}
      {/* Read from the row as it stands right now, never from what was clicked:
          an agent opened while it works goes on working, and its clock, its
          spend and its answer keep arriving behind the pane. */}
      {agentOpen && (
        <AgentView
          row={agentOpen}
          items={view.items}
          sessionId={sessionId}
          controls={view.menu.agentControls}
          mentions={mentions}
          onClose={() => setOpenAgent(null)}
        />
      )}
    </div>,
  );
}
