/**
 * The Chat tab: transcript, composer, Stop button, permission cards, the tool
 * feed with its diffs and subagent nesting, and the checklist.
 *
 * Design: docs/agent-workbench.md §8.2. The sidebar, the card rail and the
 * report viewer arrive with their own work items.
 */
'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import {
  ArrowUp,
  Bot,
  Cpu,
  ListTree,
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
import { addressWith } from '@/lib/address';
import { hueFor } from '@/lib/bead-labels';
import { cn } from '@/lib/utils';
import { ChatRightRail, useRightRail } from '@/workbench/chat-right-rail';
import { ChatSidebar } from '@/workbench/chat-sidebar';
import { KindFilter, NothingShowing } from '@/workbench/filter-tree';
import { useKnownCards } from '@/workbench/known-cards';
import { mentionsIn } from '@/workbench/mentions';
import { useLiveSessions, useRunningElsewhere } from '@/workbench/live';
import { EVERYTHING, drawable, remember, remembered, showing as stillShowing, type KindId } from '@/workbench/message-filter';
import type { CommandInfo, ImagePayload, TodoItem } from '@/workbench/protocol';
import { ReportChip } from '@/workbench/report-view';
import { heldElsewhere } from '@/workbench/running';
import { SearchPanel } from '@/workbench/search-panel';
import { SpendView } from '@/workbench/spend-view';
import { TranscriptRow, WorkingLine } from '@/workbench/transcript-rows';
import { isBusy, readImage, sendCommand, useSession, useSessionFacts } from '@/workbench/use-session';

/** Where the "show me everything" switch is remembered between visits. */
const EVERY_CHAT = 'workbench.every-chat';
/** Whether the transcript is showing every command's body and every quiet line. */
const CHAT_OPEN_ALL = 'workbench.open-all';

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
  const mentions = useMemo<Mentions>(
    () => ({
      split: (text) =>
        mentionsIn(text, { card: (id) => knownCards.has(id), report: (slug) => byName.has(slug) }),
      card: (id) => (
        <BeadChip id={id} projectId={projectId} size="xs" testId="mention-card" className="mx-0.5 align-baseline" />
      ),
      report: (slug) => {
        const found = byName.get(slug);
        if (!found) return slug;
        return (
          <span className="mx-0.5 inline-flex align-baseline">
            <ReportChip project={found.project} slug={found.slug} title={found.title} />
          </span>
        );
      },
    }),
    [knownCards, byName, projectId, projectPath],
  );
  const [draft, setDraft] = useState('');
  const [attached, setAttached] = useState<ImagePayload[]>([]);
  /** The picture being looked at, from the tray or from a message. */
  const [looking, setLooking] = useState<ImagePayload | null>(null);
  /** Which entry the `/` menu has under the cursor. */
  const [pick, setPick] = useState(0);
  /** The `/` menu, put away by hand until the next keystroke. */
  const [shut, setShut] = useState(false);
  /** Only ever seen on a narrow screen; the rail is always there on a wide one. */
  const [railOpen, setRailOpen] = useState(false);
  /** The chat's own column on the right, remembered between visits. */
  const [rightOpen, flipRight] = useRightRail();
  /** The two ways in that live in this tab's toolbar, each a full-screen panel. */
  const [showing, setShowing] = useState<'search' | 'spend' | null>(null);
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
   * Everything open: every command showing what it ran and printed, and every
   * line the machine says about itself. Ctrl+O, because that is the key that
   * does it in his terminal, and remembered for the browser rather than the
   * chat — it is a way of reading, not a property of one conversation
   * (docs/agent-workbench.md §8.2.4).
   */
  const [openAll, setOpenAll] = useState(false);

  useEffect(() => {
    setOpenAll(localStorage.getItem(CHAT_OPEN_ALL) === '1');
  }, []);

  /**
   * Which kinds of message the conversation draws. Remembered for the browser
   * rather than the chat for the same reason as the switch above it: it is a
   * way of reading, not a property of one conversation (bw-qdim).
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

  /** Every row this conversation could draw, before any switch is read. */
  const canDraw = useMemo(() => drawable(view.items, openAll), [view.items, openAll]);

  /** The rows this conversation draws, once the reader's switches are obeyed. */
  const rows = useMemo(() => stillShowing(canDraw, offKinds), [canDraw, offKinds]);

  /**
   * Written where it is CHANGED, never mirrored from an effect: an effect that
   * writes the state back runs once with the value the screen started at, which
   * overwrites what was remembered before the effect that reads it has taken —
   * so the choice was lost on every reload.
   */
  const flipOpenAll = useCallback(() => {
    setOpenAll((was) => {
      localStorage.setItem(CHAT_OPEN_ALL, was ? '0' : '1');
      return !was;
    });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== 'o') return;
      e.preventDefault();
      flipOpenAll();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flipOpenAll]);
  const endRef = useRef<HTMLDivElement>(null);
  const typing = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [view.items]);

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
  const held = heldElsewhere(view.state, live?.externalId ?? facts?.externalId, elsewhere, facts?.runningElsewhere);

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
        <ToolButton
          icon={<ListTree />}
          label={openAll ? 'Show less (Ctrl+O)' : 'Show everything (Ctrl+O)'}
          emphasis={openAll ? 'loud' : 'quiet'}
          data-testid="toggle-open-all"
          data-open-all={openAll}
          onClick={flipOpenAll}
        />
        <KindFilter items={canDraw} off={offKinds} onChange={changeKinds} />
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
      {railOpen && (
        <button
          type="button"
          aria-label="Close the chat list"
          data-testid="chat-rail-scrim"
          className="absolute inset-0 z-20 bg-black/40 md:hidden"
          onClick={() => setRailOpen(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">{inner}</div>
      {/* The chat's own column. Only when there IS a chat: an empty rail beside
          an empty screen says nothing and takes width to say it. */}
      {sessionId && (
        <ChatRightRail
          projectId={projectId}
          cards={cards}
          reports={ours}
          cost={view.cost}
          context={view.context}
          open={rightOpen}
          onToggle={flipRight}
        />
      )}
      {sessionId && rightOpen && (
        <button
          type="button"
          aria-label="Close what this chat has touched"
          data-testid="chat-right-rail-scrim"
          className="absolute inset-0 z-20 bg-black/40 md:hidden"
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
      <div className="flex h-10 shrink-0 items-center gap-3 overflow-hidden border-b border-border/60 px-4 text-sm">
        {/* A chat another program is working in has no agent of OURS attached,
            which is what "Asleep" describes and not what the reader is looking
            at: the messages arrive as that program works. It says the same word
            its row in the list says, and it clears itself when that program
            stops, because the stream it is read from does (bw-dmxj.10). */}
        <Badge
          variant={held ? 'success' : busy ? 'warning' : 'secondary'}
          appearance={held ? 'default' : 'light'}
          size="sm"
          shape="circle"
          data-testid="session-state"
          data-state={held ? 'working' : view.state}
          className="shrink-0"
        >
          {held ? 'working' : view.stateLabel}
        </Badge>
        <span data-testid="session-meta" className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
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
            className="font-mono"
          >
            {facts.folder}
          </Badge>
        )}
      </div>

      {view.todos.length > 0 && (
        <div className="border-b border-border/60 px-4 py-2">
          <TodoPanel items={view.todos} />
        </div>
      )}

      <div
        className="mx-auto flex w-full max-w-[110ch] flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
        data-testid="transcript"
      >
        {rows.length === 0 && canDraw.length > 0 && (
          <NothingShowing hidden={canDraw.length} onShowAll={() => changeKinds(EVERYTHING)} />
        )}
        {rows.map((item) => (
          <TranscriptRow
            key={item.id}
            item={item}
            openAll={openAll}
            sessionId={sessionId}
            mentions={mentions}
            onLook={setLooking}
          />
        ))}
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
        <div ref={endRef} />
      </div>

      <div className="border-t border-border/60 px-4 py-3">
        {/* One frame holds the typing, the pictures waiting to go and the button
            that sends them, so the whole thing reads as the place you write. */}
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
          {held && (
            <p data-testid="held-elsewhere" className="mb-2 text-xs text-muted-foreground">
              Another program is working in this chat. It draws here as it goes; you can type when it stops.
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
            disabled={held}
            placeholder={held ? 'Another program is working in this chat.' : 'Ask the agent to do something…'}
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
            {/* Both act on THIS chat, not the next one (§8.2.3). */}
            <Picker
              icon={<ShieldCheck className="h-3.5 w-3.5" />}
              label="Permission mode"
              testid="mode-picker"
              current={view.permissionMode}
              asleep={asleep}
              options={view.menu.permissionModes.map((m) => ({ value: m, label: m }))}
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
              current={view.model ?? 'default'}
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
                disabled={!draft.trim() || held}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>

      {looking && <PictureViewer image={looking} onClose={() => setLooking(null)} />}
    </div>,
  );
}
