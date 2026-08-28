/**
 * The Chat tab: transcript, composer, Stop button, permission cards, the tool
 * feed with its diffs and subagent nesting, and the checklist.
 *
 * Design: docs/agent-workbench.md §8.2. The sidebar, the card rail and the
 * report viewer arrive with their own work items.
 */
'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import { useRouter, useSearchParams } from 'next/navigation';

import {
  ArrowDown,
  ArrowUp,
  Coins,
  Cpu,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderGit2,
  Gauge,
  GitBranch,
  Loader2,
  ListChecks,
  PanelLeft,
  PanelRight,
  PanelRightClose,
  Paperclip,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Star,
  Workflow,
  X,
} from 'lucide-react';

import { BeadChip } from '@/components/bead-chip-row';
import { type Mentions } from '@/components/markdown-body';
import { TabLead, TabTools, TabTrail, ToolButton } from '@/components/shell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Panel } from '@/components/ui/panel';
import { Row } from '@/components/ui/row';
import { Textarea } from '@/components/ui/textarea';
import { useHeldAtTheEnd } from '@/hooks/held-at-the-end';
import { addressWith } from '@/lib/address';
import { hueFor } from '@/lib/bead-labels';
import { cn } from '@/lib/utils';
import { ChatRightRail, useGitPanel, useRightRail } from '@/workbench/chat-right-rail';
import { ChatSidebar } from '@/workbench/chat-sidebar';
import { useUnsentLine, useUnsentPictures } from '@/workbench/drafts';
import { chatState, heldLine, holderOnly } from '@/workbench/chat-state';
import { ExternalBadge } from '@/workbench/chat-state-chip';
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
import { EVERYTHING, hisDoing, remember, remembered, showing as stillShowing, type KindId } from '@/workbench/message-filter';
import type { Brand, CommandInfo, Cost, ImageComparison, ImagePayload, LookableImage, TodoItem } from '@/workbench/protocol';
import { BRAND_DEFAULT_MODEL } from '@/workbench/protocol';
import { heldElsewhere, sessionOwnership } from '@/workbench/running';
import { SearchPanel } from '@/workbench/search-panel';
import { AgentView } from '@/workbench/agent-view';
import { DrawnTranscript } from '@/workbench/drawn-transcript';
import { WorkingLine, whatItWasAsked } from '@/workbench/transcript-rows';
import { ContextChip, TokenView } from '@/workbench/token-view';
import { PlanChip, UsageView } from '@/workbench/usage-view';
import { CHIP_GAP, ModeMark, modelName, modeWords, WhatItRuns } from '@/workbench/what-it-runs';
import { isBusy, readImage, sendCommand, useSession, useSessionFacts, type TranscriptItem } from '@/workbench/use-session';
import { whatItRan, whileItRuns } from '@/workbench/said-what-it-ran';
import { BrandIcon, ProviderBadge, brandName } from '@/workbench/brand-icon';
import { workingLine } from '@/workbench/working-line';
import { PictureViewer } from '@/workbench/picture-viewer';

export { PictureViewer } from '@/workbench/picture-viewer';

/** Where the "show me everything" switch is remembered between visits. */
const EVERY_CHAT = 'workbench.every-chat';
const NEW_CHAT_DEFAULT = 'workbench.new-chat-default';
const LEFT_PANEL_WIDTH = 'workbench.left-panel-width';
const RIGHT_PANEL_WIDTH = 'workbench.right-panel-width';
const DEFAULT_PANEL_WIDTH = 288;
const MIN_PANEL_WIDTH = 208;
const MAX_PANEL_WIDTH = 560;
const MIN_CHAT_WIDTH = 320;

function rememberedPanelWidth(key: string): number {
  const width = Number(localStorage.getItem(key));
  return Number.isFinite(width) && width >= MIN_PANEL_WIDTH ? Math.min(width, MAX_PANEL_WIDTH) : DEFAULT_PANEL_WIDTH;
}

export function ResizeDivider({ side, value, onChange, maximum, onDragging }: {
  side: 'left' | 'right';
  value: number;
  onChange: (width: number) => void;
  maximum: () => number;
  onDragging?: (dragging: boolean) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (width: number) => onChange(Math.max(MIN_PANEL_WIDTH, Math.min(width, MAX_PANEL_WIDTH, maximum())));
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const distance = event.clientX - drag.current.x;
    resize(drag.current.width + (side === 'left' ? distance : -distance));
  };
  return (
    <div
      role="separator"
      aria-label={`Resize ${side} panel`}
      aria-orientation="vertical"
      aria-valuemin={MIN_PANEL_WIDTH}
      aria-valuemax={Math.max(MIN_PANEL_WIDTH, maximum())}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      data-testid={`${side}-panel-resizer`}
      className="group relative z-40 -mx-1 hidden w-2 shrink-0 cursor-col-resize touch-none md:block"
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, width: value };
        onDragging?.(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={move}
      onPointerUp={(event) => {
        drag.current = null;
        onDragging?.(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; onDragging?.(false); }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const direction = event.key === 'ArrowRight' ? 1 : -1;
        resize(value + direction * (side === 'left' ? 16 : -16));
      }}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/60 transition-colors group-hover:bg-primary group-focus:bg-primary" />
    </div>
  );
}

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

/** A prompt remains editable only until the agent puts anything of its own after it. */
interface RecallablePrompt {
  text: string;
  images: ImagePayload[];
  itemsBeforeSend: Set<string>;
}

/** Whether the agent has begun answering since a prompt was submitted. */
export function agentRespondedSince(items: TranscriptItem[], before: Set<string>): boolean {
  return items.some(
    (item) =>
      !before.has(item.id) &&
      (item.kind === 'thinking' || item.kind === 'tool' || (item.kind === 'message' && item.role === 'assistant')),
  );
}

/**
 * One picker on the composer's row. What it lists is what the session itself
 * announced it can do, so it is never a list of guesses (§7).
 */
function Picker({
  icon,
  label,
  current,
  currentLabel,
  options,
  testid,
  asleep,
  onPick,
  defaultValue,
  onDefault,
  cannotDefault,
}: {
  icon: ReactNode;
  label: string;
  current: string | null;
  /**
   * What to say when the list has no row for what is set. A chat can be running
   * something the list it announced does not offer, and the button then printed
   * the wire id straight at the reader — `claude-opus-5[1m]` (bw-ja9l.11).
   */
  currentLabel?: string | null;
  options: { value: string; label: string; hint?: string }[];
  testid: string;
  /** No agent is attached, so there is nothing to change until he writes. */
  asleep: boolean;
  onPick: (value: string) => void;
  defaultValue?: string | null;
  onDefault?: (value: string) => void;
  cannotDefault?: (value: string) => string | null;
}) {
  if (!options.length) return null;
  const shown = options.find((o) => o.value === current)?.label ?? currentLabel ?? current ?? label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          data-testid={testid}
          data-current={current ?? ''}
          data-asleep={asleep}
          disabled={asleep && !onDefault}
          aria-label={label}
          // A sleeping chat has no agent to tell, and the command behind this
          // would fail silently; sending a message wakes it (bw-f1q.12).
          title={asleep && !onDefault ? `${label} — send a message to wake this chat first` : label}
          className="h-7 gap-1.5 rounded-full px-2 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {icon}
          <span className="max-w-[18ch] truncate">{shown}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto" data-testid={`${testid}-menu`}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {options.map((o) => (
          <div key={o.value} className="px-1 py-0.5">
            <div className="flex items-center gap-1">
              <DropdownMenuItem
                data-testid={`${testid}-option`}
                data-value={o.value}
                data-picked={o.value === current}
                disabled={asleep}
                onSelect={() => onPick(o.value)}
                className="h-7 min-w-0 flex-1 px-2 py-1"
              >
                <span className={cn('truncate text-sm', o.value === current && 'font-semibold text-foreground')}>{o.label}</span>
              </DropdownMenuItem>
              {onDefault && (
                <Button
                  size="xs"
                  variant="ghost"
                  className="h-5 w-5 shrink-0 rounded-sm p-0"
                  data-testid={`${testid}-default-${o.value}`}
                  data-default={defaultValue === o.value}
                  aria-pressed={defaultValue === o.value}
                  disabled={Boolean(cannotDefault?.(o.value))}
                  aria-label={cannotDefault?.(o.value) ?? (defaultValue === o.value ? `${o.label} is the default` : `Make ${o.label} the default`)}
                  title={cannotDefault?.(o.value) ?? (defaultValue === o.value ? 'Default' : 'Make default')}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!cannotDefault?.(o.value)) onDefault(o.value);
                  }}
                >
                  <Star className={cn('h-3 w-3', defaultValue === o.value && 'fill-current text-primary')} aria-hidden="true" />
                </Button>
              )}
            </div>
            {o.hint && <p className="px-2 pb-1 text-xs text-muted-foreground">{o.hint}</p>}
          </div>
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
    <Panel tone="overlay" inset="none" data-testid="command-menu" className="mb-2 max-h-64 overflow-y-auto p-1">
      {matches.map((c, i) => (
        <Row
          key={`${c.kind}:${c.name}`}
          inset="sm"
          radius="md"
          // The one the arrow keys are on, which is not the one the mouse is
          // over: both light up, and while he is arrowing through the list with
          // the pointer resting on it he can see both answers.
          selected={i === active}
          data-testid="command-option"
          data-command={c.name}
          data-kind={c.kind}
          data-active={i === active}
          onMouseDown={(e) => {
            // Down, not click: the box must not lose focus before the pick lands.
            e.preventDefault();
            onPick(c);
          }}
          className="flex items-baseline gap-2 text-sm"
        >
          <span className="shrink-0 font-mono">/{c.name}</span>
          {c.argumentHint && <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.argumentHint}</span>}
          <span className="min-w-0 truncate text-xs text-muted-foreground">{c.description}</span>
          {c.kind === 'skill' && (
            <Badge variant="secondary" appearance="light" size="xs" shape="circle" className="ml-auto shrink-0">
              skill
            </Badge>
          )}
        </Row>
      ))}
    </Panel>
  );
}

/**
 * A picture at full size, over the chat. Escape or a click away closes it.
 *
 * The window is the library's, wearing its full-screen shape: the dim behind
 * the picture, the way out on Escape and the page held still underneath are the
 * same ones every other popup in the app gets, rather than a backdrop and a key
 * listener this screen kept for itself (bw-dks8.10).
 */
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
    <Button
      variant="outline"
      size="sm"
      radius="full"
      data-testid="back-to-now"
      data-shown={shown ? 'yes' : 'no'}
      data-missed={missed}
      aria-hidden={!shown}
      tabIndex={shown ? 0 : -1}
      onClick={onClick}
      title={missed > 0 ? `${missed} more since you scrolled up — back to now` : 'Back to the newest message'}
      className={cn(
        'absolute bottom-4 right-4 z-10 shadow-lg transition-all',
        shown ? 'pointer-events-auto opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
      )}
    >
      <ArrowDown className="h-4 w-4" />
      {missed > 0 && (
        <span data-testid="back-to-now-count" className="text-xs font-medium tabular-nums">
          {missed}
        </span>
      )}
    </Button>
  );
}

/** The agent's checklist, as it stands right now. */
export function TodoPanel({ items }: { items: TodoItem[] }) {
  const complete = items.filter((item) => item.status === 'completed').length;
  const allComplete = complete === items.length;
  const [expanded, setExpanded] = useState(!allComplete);
  const wasComplete = useRef(allComplete);

  useEffect(() => {
    // A new active plan deserves to be seen immediately. Once its last item is
    // checked, it gets out of the transcript's way without disappearing.
    if (allComplete && !wasComplete.current) setExpanded(false);
    if (!allComplete && wasComplete.current) setExpanded(true);
    wasComplete.current = allComplete;
  }, [allComplete]);

  if (!items.length) return null;
  return (
    <Panel data-testid="todo-panel" inset="none" data-expanded={expanded ? 'yes' : 'no'} className="overflow-hidden">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={expanded}
        aria-controls="active-checklist-items"
        onClick={() => setExpanded((open) => !open)}
        className="flex min-h-9 w-full justify-start gap-2 rounded-none px-3 py-2 text-left hover:bg-muted/40"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <ListChecks className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Checklist</span>
        {!expanded && !allComplete && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {items.find((item) => item.status === 'in_progress')?.text ?? items.find((item) => item.status === 'pending')?.text}
          </span>
        )}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">{complete}/{items.length}</span>
      </Button>
      <ul id="active-checklist-items" hidden={!expanded} className="space-y-1 border-t border-border/60 px-3 py-2">
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

/** Desktop keeps its quick Enter shortcut; phone keyboards always make a new line. */
export function enterSubmits(
  event: Pick<KeyboardEvent<HTMLTextAreaElement>, 'key' | 'shiftKey'>,
  mobile = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(max-width: 767px)').matches),
): boolean {
  return event.key === 'Enter' && !event.shiftKey && !mobile;
}

export default function ChatTab({ projectId, projectPath, openSessionId }: ChatTabProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [leftWidth, setLeftWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [rightWidth, setRightWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [resizingRight, setResizingRight] = useState(false);

  useEffect(() => {
    setLeftWidth(rememberedPanelWidth(LEFT_PANEL_WIDTH));
    setRightWidth(rememberedPanelWidth(RIGHT_PANEL_WIDTH));
  }, []);

  const changeLeftWidth = useCallback((width: number) => {
    setLeftWidth(width);
    localStorage.setItem(LEFT_PANEL_WIDTH, String(Math.round(width)));
  }, []);
  const changeRightWidth = useCallback((width: number) => {
    setRightWidth(width);
    localStorage.setItem(RIGHT_PANEL_WIDTH, String(Math.round(width)));
  }, []);
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
  const [newBrand, setNewBrand] = useState<Brand>('claude');
  const [newChatDefault, setNewChatDefaultState] = useState<Brand | 'ask'>('ask');
  const [modelDefaults, setModelDefaults] = useState<Partial<Record<Brand, string>>>({});
  const [effortDefaults, setEffortDefaults] = useState<Partial<Record<Brand, string>>>({});
  const [composerSettingsOpen, setComposerSettingsOpen] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem(NEW_CHAT_DEFAULT);
    if (saved === 'claude' || saved === 'codex' || saved === 'ask') setNewChatDefaultState(saved);
  }, []);
  const setNewChatDefault = useCallback((choice: Brand | 'ask') => {
    setNewChatDefaultState(choice);
    localStorage.setItem(NEW_CHAT_DEFAULT, choice);
  }, []);
  /** What went wrong the last time he changed the mode or the model. */
  const [steerError, setSteerError] = useState<string | null>(null);
  /** Why the last thing he wrote did not go, if it did not go. */
  const [sendError, setSendError] = useState<string | null>(null);
  const start = useCallback(async (brand: Brand = newBrand) => {
    if (!projectId || !projectPath) return;
    setStarting(true);
    setStartError(null);
    try {
      const s = await sendCommand<{ id: string }>({
        type: 'session.start',
        projectId,
        projectPath,
        brand,
      });
      open(s.id);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, [projectId, projectPath, open, newBrand]);
  const view = useSession(sessionId);
  const facts = useSessionFacts(sessionId);
  // What the board knows plus what this chat has been seen doing since.
  const cards = Array.from(new Set([...(facts?.beads ?? []), ...view.beads]));
  // A card the agent NAMED in its own words opens from where it is
  // written. Only ones that exist: English is full of hyphenated words shaped
  // like a card id, so the board's own list and the reports this project has
  // is what decides (bw-4wcd.3, src/workbench/mentions.ts).
  const knownCards = useKnownCards(projectPath);

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
    return {
      split: (text) =>
        openableIn(
          text,
          { card: (id) => knownCards.has(id) },
          where,
          disk,
        ),
      path: (absolute, raw, line) => <PathChip absolute={absolute} raw={raw} line={line} />,
      card,
      //
      // An address that asks for a DIFFERENT project stays a link too, however
      // familiar its id looks: card ids repeat across boards, and a chip drawn
      // here would open this project's card of the same id and say nothing
      // about having gone somewhere else (bw-8fh2.8).
      link: (href) => {
        const named = addressedBy(href);
        if (!named) return null;
        if (named.project && named.project !== projectId) return null;
        return knownCards.has(named.id) ? card(named.id) : null;
      },
    };
  }, [knownCards, projectId, where, disk]);
  // Both are held against THIS chat's id, out where the tab bar cannot reach
  // them: leaving the chat for the board takes this whole screen down, and
  // switching chats does not take it down at all (src/workbench/drafts.ts).
  const [draft, setDraft] = useUnsentLine(sessionId ?? '');
  const [attached, setAttached] = useUnsentPictures(sessionId ?? '');
  /** The picture being looked at, from the tray or from a message. */
  const [looking, setLooking] = useState<LookableImage | null>(null);
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
  /** Which of the rail's two views it is on, remembered the same way (bw-8dp8.5). */
  const [gitOpen, flipGit] = useGitPanel();
  /**
   * The way into the Git view.
   *
   * A shut rail always opens ON Git: the button is a door, and a door that
   * opens onto the other room did nothing the reader pressed it for. With the
   * rail already open the same press swaps the two views, so this is also the
   * way back to what the chat has touched.
   */
  const showGit = useCallback(() => {
    if (!rightOpen) {
      flipRight();
      if (!gitOpen) flipGit();
      return;
    }
    flipGit();
  }, [rightOpen, gitOpen, flipRight, flipGit]);
  /** The ways in that live in this tab, each a full-screen panel. */
  const [showing, setShowing] = useState<'search' | 'usage' | 'tokens' | 'new-chat' | null>(null);
  const newChat = useCallback((brand?: Brand) => {
    if (brand) {
      setRailOpen(false);
      void start(brand);
    } else if (newChatDefault === 'ask') {
      setShowing('new-chat');
    } else {
      setRailOpen(false);
      void start(newChatDefault);
    }
  }, [newChatDefault, start]);
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
  /** The POST being accepted; Escape waits for it before sending Stop. */
  const sending = useRef<Promise<{ messageId: string }> | null>(null);
  const [recallable, setRecallable] = useState<RecallablePrompt | null>(null);
  /** The same prompt for a key pressed before React has committed the next render. */
  const recallableNow = useRef<RecallablePrompt | null>(null);

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
  const asleep = view.state === 'dormant';

  // Claude and Codex expose different first signs of life (thinking, a tool,
  // or assistant text). Any of them makes the prompt history, not a draft.
  useEffect(() => {
    setRecallable(null);
    recallableNow.current = null;
    sending.current = null;
  }, [sessionId]);
  useEffect(() => {
    if (recallable && agentRespondedSince(view.items, recallable.itemsBeforeSend)) {
      setRecallable(null);
      recallableNow.current = null;
      sending.current = null;
    }
  }, [recallable, view.items]);

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
  const sessionBrand = live?.brand ?? facts?.brand ?? 'claude';
  useEffect(() => {
    let current = true;
    void sendCommand<{ model: string | null; effort: string | null }>({ type: 'provider-defaults.read', brand: sessionBrand })
      .then((defaults) => {
        if (!current) return;
        setModelDefaults((was) => ({ ...was, [sessionBrand]: defaults.model ?? undefined }));
        setEffortDefaults((was) => ({ ...was, [sessionBrand]: defaults.effort ?? undefined }));
      })
      .catch((e: unknown) => current && setSteerError(e instanceof Error ? e.message : String(e)));
    return () => { current = false; };
  }, [sessionBrand]);
  const makeProviderDefault = useCallback((kind: 'model' | 'effort', value: string) => {
    setSteerError(null);
    void sendCommand<{ model: string | null; effort: string | null }>({
      type: 'provider-defaults.write', brand: sessionBrand, kind, value,
    }).then((defaults) => {
      setModelDefaults((was) => ({ ...was, [sessionBrand]: defaults.model ?? undefined }));
      setEffortDefaults((was) => ({ ...was, [sessionBrand]: defaults.effort ?? undefined }));
    }).catch((e: unknown) => setSteerError(e instanceof Error ? e.message : String(e)));
  }, [sessionBrand]);
  /** The selected provider account's allowance, never the other provider's. */
  const plan = usePlanUsage(sessionBrand);
  const externalId = live?.externalId ?? facts?.externalId ?? null;
  const held = heldElsewhere(view.state, externalId, elsewhere, facts?.runningElsewhere);
  const ownership = sessionOwnership(view.state, externalId, held);
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
   * When the whole turn began — the quiet second number.
   *
   * The same clock the one above used to be, kept where nothing restarts it:
   * this one moves only when a turn starts or ends, so what the step clock
   * gives up by counting steps is not lost, only moved off the loud number
   * (bw-jaoz.14.4).
   */
  const [turnSince, setTurnSince] = useState<number | null>(null);
  useEffect(() => {
    setTurnSince(busy ? Date.now() : null);
  }, [busy]);
  /**
   * The one reading every screen draws (chat-state.ts). A held chat is read
   * from what the holder says about itself; ours from our own driver's word.
   */
  const state = chatState({
    state: view.state,
    label: view.stateLabel,
    since: busySince,
    turnSince,
    held: held
      ? (holder ?? {
          id: externalId ?? '',
          holder: facts?.origin === 'terminal' ? 'terminal' : 'program',
          doing: 'working',
          since: null,
        })
      : null,
    // Whether anything has ever been said in this one. Only the stream knows —
    // the fold's own first reading is `starting` for a chat being woken and for
    // a chat made a second ago alike — so without a row from it we do not know,
    // and a chat we do not know about is read exactly as it always was.
    spokenIn: live ? live.lastSpokeAt !== null : true,
  });

  // The call in flight, whoever is making it: our own driver's, or — since the
  // record's tail is drawn as it is written (bw-jaoz.5) — the holder's.
  const inFlight = view.items.find((it) => it.kind === 'tool' && it.status === 'running');
  // Said in the present, because this line is what a reader watches while the
  // command runs, and said off the same arguments the row above it reads — so
  // the two name the same thing in the same words (bw-7ks.24.6).
  const running =
    inFlight?.kind === 'tool'
      ? {
          title: whileItRuns(whatItRan(inFlight.name, inFlight.input)?.said ?? inFlight.title),
          seconds: inFlight.seconds,
        }
      : null;
  /** The turn under the last message, in the words of whoever owes it. */
  const atWork = workingLine({
    busy,
    label: view.stateLabel,
    since: busySince,
    waiting: view.state === 'waiting_permission',
    thought: view.thinkingTokens,
    state,
    running,
    // Measured in this project, by the sidecar watching runs begin and end. Only
    // the bar reads it, and only while summarising (bw-jaoz.14.9).
    typicalMs: holder?.typicalMs ?? null,
  });

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
    const pending = { text: draft, images, itemsBeforeSend: new Set(view.items.map((item) => item.id)) };
    recallableNow.current = pending;
    setRecallable(pending);
    setDraft('');
    setAttached([]);
    setSendError(null);
    try {
      const sent = sendCommand<{ messageId: string }>({ type: 'prompt.send', sessionId, text, images, takeover: ownership.kind === 'elsewhere' });
      sending.current = sent;
      await sent;
    } catch (e) {
      // The server can refuse this: another program took the conversation over
      // between the box unlocking and the send, or the screen's own copy of who
      // is working was stale (bw-dmxj.12). Either way what he wrote is his, and
      // it goes back in the box he wrote it in rather than into the void.
      setDraft(draft);
      setAttached(images);
      setRecallable(null);
      recallableNow.current = null;
      sending.current = null;
      setSendError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Stop an unanswered turn and put its exact input back under the cursor. */
  async function recallLastPrompt() {
    if (!recallableNow.current || !sessionId) return;
    const pending = recallableNow.current;
    setRecallable(null);
    recallableNow.current = null;
    setDraft(pending.text);
    setAttached(pending.images);
    setSendError(null);
    typing.current?.focus();
    try {
      const accepted = await sending.current;
      await sendCommand({ type: 'session.stop', sessionId, retractMessageId: accepted?.messageId });
      sending.current = null;
    } catch (e) {
      setSendError(`Prompt restored, but the turn could not be stopped. ${e instanceof Error ? e.message : String(e)}`);
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
    <div ref={shellRef} className="relative flex min-h-0 flex-1">
      {/* First thing on the row, ahead of Chat/Board/Reports: the way into the
          chat list is not one tool among this tab's own, it opens a whole other
          pane, the same reason the right rail's own way in sits on the bar and
          not inside either pane (bw-81wt.5). */}
      <TabLead tab="chat">
        <ToolButton
          icon={<PanelLeft />}
          label="Chats"
          className="md:hidden"
          data-testid="chat-rail-toggle"
          onClick={() => setRailOpen((v) => !v)}
        />
      </TabLead>

      <TabTools tab="chat">
        {/* Search, "everything" and New Chat used to live here; they moved into
            the list they act on (bw-81wt.5). What is left is the kind filter,
            which reaches into this transcript rather than the list beside it.
            The way into the column on the right is not here: it is a door, and
            a door belongs on the side it opens (bw-81wt.29). */}
        <KindFilter items={view.items} off={offKinds} onChange={changeKinds} />
      </TabTools>

      {/* The far right of the bar, mirroring the chat list's button on the far
          left: the two panels of this screen, each reached from its own edge.
          Both toggles are pictures a reader learns once; a bar of words for six
          controls is the bar that put "New Chat" off the edge of a 390px
          screen (bw-81wt.5, .8). */}
      <TabTrail tab="chat">
        {/* What the project has changed, which is the chat's other subject: the
            agents in this transcript write those files, so the way to look at
            them belongs on this bar and not in a screen of its own (bw-8dp8). */}
        {sessionId && projectPath && (
          <ToolButton
            icon={<GitBranch />}
            label={gitOpen && rightOpen ? 'Hide Git' : 'Show Git'}
            emphasis={gitOpen && rightOpen ? 'loud' : 'quiet'}
            data-testid="chat-git-toggle"
            data-open={gitOpen && rightOpen}
            onClick={showGit}
          />
        )}
        {sessionId && (
          <ToolButton
            icon={rightOpen ? <PanelRightClose /> : <PanelRight />}
            label={rightOpen ? 'Hide chat details' : 'Show chat details'}
            emphasis={rightOpen ? 'loud' : 'quiet'}
            data-testid="chat-right-rail-toggle"
            data-open={rightOpen}
            onClick={flipRight}
          />
        )}
      </TabTrail>

      {showing === 'search' && <SearchPanel onClose={() => setShowing(null)} />}
      {showing === 'usage' && <UsageView brand={sessionBrand} onClose={() => setShowing(null)} />}
      {showing === 'tokens' && sessionId && (
        <TokenView sessionId={sessionId} onClose={() => setShowing(null)} />
      )}
      <Dialog open={showing === 'new-chat'} onOpenChange={(opened) => { if (!opened) setShowing(null); }}>
        <DialogContent className="sm:max-w-md" data-testid="new-chat-provider-dialog">
          <DialogHeader>
            <DialogTitle>Choose a coding agent</DialogTitle>
            <DialogDescription>This choice applies to this new chat.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2">
            {(['claude', 'codex'] as const).map((brand) => (
              <Button
                key={brand}
                variant={newBrand === brand ? 'primary' : 'outline'}
                data-testid={`new-chat-provider-${brand}`}
                onClick={() => setNewBrand(brand)}
              >
                <BrandIcon brand={brand} /> {brandName(brand)}
              </Button>
            ))}
          </div>
          <DialogFooter className="gap-2 sm:space-x-0">
            <Button variant="secondary" onClick={() => setNewChatDefault(newBrand)}>
              Use {newBrand === 'claude' ? 'Claude' : 'Codex'} by default
            </Button>
            <Button variant="primary" disabled={starting} onClick={() => { setShowing(null); setRailOpen(false); void start(newBrand); }}>
              {starting ? 'Starting…' : 'Start chat'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div
        data-testid="chat-rail"
        data-open={railOpen}
        style={{ '--chat-left-rail-width': `${leftWidth}px` } as CSSProperties}
        className={cn(
          // On a phone it is a sheet over the WHOLE screen, bars included, not
          // a panel inside the box the bars left over: a sheet that starts
          // below them reads as a stray box in the page, which is what the
          // manager sent this back for (bw-81wt.30). Hence `fixed` — the box
          // around it is only the work area. On a wide screen it is a column
          // of the row again, and behind the popups as it always was.
          'z-50 h-full shrink-0 bg-background transition-transform md:relative md:z-30 md:translate-x-0',
          'fixed inset-y-0 left-0 md:w-[var(--chat-left-rail-width)]',
          railOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full',
        )}
      >
        <ChatSidebar
          projectId={projectId}
          projectPath={projectPath}
          openSessionId={sessionId}
          everything={everything}
          onOpen={(id) => { setRailOpen(false); open(id); }}
          onSearch={() => setShowing('search')}
          onToggleEverything={flipEverything}
          // Same reason as `onOpen`: the drawer opened to reach this button, and
          // its job is done once the chat it starts exists — left open, it would
          // sit over the transcript it just created (bw-81wt.5).
          onNewChat={newChat}
          newChatDefault={newChatDefault}
          onNewChatDefault={setNewChatDefault}
          startingNewChat={starting}
          // The cross inside the drawer, for a phone where the bar that opened
          // it is behind the sheet (bw-81wt.30).
          onClose={() => setRailOpen(false)}
        />
      </div>
      <ResizeDivider
        side="left"
        value={leftWidth}
        onChange={changeLeftWidth}
        maximum={() => (shellRef.current?.clientWidth ?? window.innerWidth) - (rightOpen && sessionId ? rightWidth : 0) - MIN_CHAT_WIDTH}
      />
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
          // Over the whole screen, like the sheet it belongs to: the dimming
          // stops where the sheet stops, and a sheet that covers the bars with
          // bright bars showing through beside it is two panels arguing.
          // 80% and not 40%, which is what an opened card already uses: the
          // app's own background is 9,9,11, so a light wash over it moves
          // nothing an eye can see — what dims is the WRITING behind the
          // sheet, and 40% left it perfectly readable (bw-81wt.30).
          'fixed inset-0 z-40 bg-black/80 md:hidden',
          'transition-opacity duration-200 ease-out motion-reduce:transition-none',
          railOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={() => setRailOpen(false)}
      />
      <div className="flex min-w-0 flex-1 flex-col">{inner}</div>
      {/* The chat's own column. Only when there IS a chat: an empty rail beside
          an empty screen says nothing and takes width to say it. */}
      {sessionId && (
        <>
          {rightOpen && (
            <ResizeDivider
              side="right"
              value={rightWidth}
              onChange={changeRightWidth}
              onDragging={setResizingRight}
              maximum={() => (shellRef.current?.clientWidth ?? window.innerWidth) - leftWidth - MIN_CHAT_WIDTH}
            />
          )}
          <ChatRightRail
            projectId={projectId}
            cards={cards}
            agents={view.agents}
            items={view.items}
            sessionId={sessionId}
            agentControls={view.menu.agentControls}
            onOpenAgent={setOpenAgent}
            open={rightOpen}
            view={gitOpen ? 'git' : 'chat'}
            projectPath={projectPath}
            desktopWidth={rightWidth}
            resizing={resizingRight}
            onToggle={flipRight}
          />
        </>
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
            // Over the whole screen, like the sheet it belongs to: the dimming
          // stops where the sheet stops, and a sheet that covers the bars with
          // bright bars showing through beside it is two panels arguing.
          // 80% and not 40%, which is what an opened card already uses: the
          // app's own background is 9,9,11, so a light wash over it moves
          // nothing an eye can see — what dims is the WRITING behind the
          // sheet, and 40% left it perfectly readable (bw-81wt.30).
          'fixed inset-0 z-40 bg-black/80 md:hidden',
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
        <div className="flex items-center gap-2" role="group" aria-label="Coding agent">
          {(['claude', 'codex'] as const).map((brand) => (
            <Button
              key={brand}
              variant={newBrand === brand ? 'primary' : 'secondary'}
              onClick={() => setNewBrand(brand)}
              disabled={starting}
              data-testid={`agent-${brand}`}
            >
              {brand === 'claude' ? 'Claude' : 'Codex'}
            </Button>
          ))}
        </div>
        <Button variant="primary" onClick={() => void start()} disabled={starting} data-testid="new-chat">
          {starting ? null : <Plus data-testid="new-chat-empty-plus" aria-hidden="true" />}
          {starting ? 'Starting…' : `New ${newBrand === 'claude' ? 'Claude' : 'Codex'} chat`}
        </Button>
        {startError && <p className="max-w-lg text-center text-sm text-red-500">{startError}</p>}
      </div>,
    );
  }

  return shell(
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-tab" data-session-id={sessionId}>
      {/* Nothing on this line grows with the work: the cards, the reports and
          what the chat has spent are all in the column beside it
          (docs/agent-workbench.md §8.2.6). It is drawn as one line wherever
          there is room for one; short of that it wraps rather than clipping,
          because a pill that is merely cut off is a pill nobody can read and
          `overflow-hidden` used to make the wire's own model name push the
          plan chip and its number straight off a 390px screen with no way
          back to them (bw-81wt.5). */}
      <div
        data-testid="chat-status-line"
        // One distance between every two chips on this line, read from the one
        // place it is written. The model/mode group inside it held its own pair
        // half a step closer, so the four chips drew as two pairs instead of a
        // row (bw-ja9l.10). Wrapped rows sit closer than that, since the gap
        // across a row and the gap between two rows are not the same distance.
        className={cn(
          'flex min-h-10 shrink-0 flex-wrap items-center border-b border-border/60 px-4 py-1.5 text-sm',
          CHIP_GAP,
          'gap-y-1',
        )}
      >
        <ProviderBadge brand={sessionBrand} className="hidden sm:inline-flex" />
        {/* A chat another program is working in has no agent of OURS attached,
            which is what "Asleep" describes and not what the reader is looking
            at: the messages arrive as that program works. So the line says what
            the holder says it is doing, and wears the badge beside it — the two
            are separate facts and the badge never stands in for the first
            (bw-96is). Both clear themselves when that program stops, because
            the stream they are read from does (bw-dmxj.10). */}
        {state.external && <span
          data-testid="session-state"
          data-state={held ? 'held' : view.state}
          className={cn('hidden shrink-0 items-center sm:flex', CHIP_GAP)}
        >
          {/* No activity chip here: what the agent is doing now is already the
              live line at the foot of the transcript, and the same state is on
              the chat's row in the list beside it. Only the badge naming
              another program holding this chat stays — nothing else says it. */}
          <ExternalBadge holder={state.external.holder} />
        </span>}
        {/* The one thing on this line allowed to give way when the line runs
            short, and the only one that can: the model and the permission mode
            are both named again on the writing box below, while every chip
            beside it is a number or a name that means nothing half-drawn. Left
            to itself it kept its full width and the chips shrank under their
            own words, so what the chat was running printed straight across the
            folder chip (bw-7ks.22.15). It used to print the tool's own spelling
            as grey text — `claude · claude-opus-5 · permission mode:
            bypassPermissions` — an inch from a picker calling that same setting
            "Skip all checks" (bw-ja9l.1). */}
        <WhatItRuns
          model={view.model}
          permissionMode={view.permissionMode}
          models={view.menu.models}
          effort={view.effort}
          efforts={view.menu.efforts}
          collaborationMode={view.collaborationMode}
          collaborationModes={view.menu.collaborationModes}
          className="hidden sm:flex"
        />
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
            className="hidden max-w-40 shrink-0 gap-1 truncate sm:inline-flex"
          >
            {/* A folder that is a checkout says so: the branch is already in
                this chip's tooltip, and the mark is what says there is one to
                hover for (bw-ja9l.12). */}
            {facts.branch ? (
              <FolderGit2 className="size-3 shrink-0" aria-hidden="true" />
            ) : (
              <Folder className="size-3 shrink-0" aria-hidden="true" />
            )}
            <span className="relative top-px min-w-0 truncate">{facts.folder}</span>
          </Badge>
        )}
        {/* What this chat is using and what it has spent, then how much of the
            account's own five-hour allowance is gone. All three are numbers a
            reader watching the work has to see without opening anything, so
            they live on the line and not in the column beside it — the column
            holds what the chat produced (bw-7ks.22.13, bw-malh). Each wears its
            own mark, because three bare numbers in a row read as one. */}
        <div className={cn('ml-auto flex shrink-0 items-center', CHIP_GAP)}>
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
              className="hidden font-mono sm:inline-flex"
            >
              <Coins />
              {costLabel(view.cost)}
            </Badge>
          )}
          <PlanChip usage={plan} onOpen={() => setShowing('usage')} />
        </div>
      </div>

      {view.todos.length > 0 && (
        <div className="border-b border-border/60 px-4 py-2" aria-live="polite">
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
        className="w-full flex-1 overflow-y-auto [overflow-anchor:none]"
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
        <div ref={contentRef} data-testid="transcript-rows" className="mx-auto flex w-full max-w-[110ch] flex-col gap-3 px-4 py-4">
        {/* Only when what is hidden is his own doing: a chat that has said
            nothing yet holds the machine's own start-up lines and nothing else,
            and the quiet start hides those for him (bw-aqpc). */}
        {rows.length === 0 && hisDoing(view.items, offKinds) && (
          <NothingShowing hidden={view.items.length} onShowAll={() => changeKinds(EVERYTHING)} />
        )}
        <DrawnTranscript
          rows={drawn}
          sessionId={sessionId}
          mentions={mentions}
          onLook={setLooking}
          pane={pane}
          held={atTheEnd}
          onOlder={view.loadOlder}
        />
        {view.error && <div className="text-sm text-red-500">{view.error}</div>}
        {/* What it is doing, where he is looking. Present exactly while it owes
            an answer (docs/agent-workbench.md §8.2.2) — whoever owes it, which
            is the whole of what `workingLine` decides. */}
        {atWork && <WorkingLine {...atWork} />}
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
        <Panel
          tone="overlay"
          inset="none"
          data-testid="composer-frame"
          className={cn(
            'mx-auto w-full max-w-[110ch] px-4 py-3 shadow-sm transition-colors',
            'focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30',
          )}
        >
          {ownership.kind === 'elsewhere' && (
            <p data-testid="held-elsewhere" className="mb-2 text-xs text-info">
              {heldLine(state)} Sending here will stop that holder and move the chat into Atelier.
            </p>
          )}
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
                  <Button
                    variant="outline"
                    mode="icon"
                    size="xs"
                    radius="full"
                    data-testid="attachment-remove"
                    aria-label={`Remove ${img.alt}`}
                    onClick={() => setAttached((all) => all.filter((_, at) => at !== i))}
                    className="absolute -right-1.5 -top-1.5 h-5 w-5 shadow"
                  >
                    <X className="h-3 w-3" />
                  </Button>
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
              if (e.key === 'Escape' && recallableNow.current) {
                e.preventDefault();
                void recallLastPrompt();
                return;
              }
              if (enterSubmits(e)) {
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
            <div className="hidden items-center gap-1 sm:flex" data-testid="desktop-composer-settings">
            <Picker
              icon={<ModeMark mode={view.permissionMode} className="h-3.5 w-3.5" />}
              label="Permission mode"
              testid="mode-picker"
              current={view.permissionMode}
              currentLabel={modeWords(view.permissionMode)?.label}
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
            {view.menu.collaborationModes.length > 0 && (
              <Picker
                icon={<Workflow className="h-3.5 w-3.5" />}
                label="Collaboration mode"
                testid="collaboration-mode-picker"
                current={view.collaborationMode}
                currentLabel={view.menu.collaborationModes.find((mode) => mode.value === view.collaborationMode)?.displayName}
                asleep={asleep}
                options={view.menu.collaborationModes.map((mode) => ({
                  value: mode.value,
                  label: mode.displayName,
                  hint: mode.description,
                }))}
                onPick={(mode) => {
                  setSteerError(null);
                  void sendCommand({ type: 'session.collaboration-mode', sessionId, mode }).catch((e: unknown) =>
                    setSteerError(e instanceof Error ? e.message : String(e)),
                  );
                }}
              />
            )}
            <Picker
              icon={<Cpu className="h-3.5 w-3.5" />}
              label="Model"
              testid="model-picker"
              // A session that has not been given a model is on the brand's own
              // default, and the list has a row for exactly that.
              current={view.model ?? BRAND_DEFAULT_MODEL}
              currentLabel={modelName(view.model ?? BRAND_DEFAULT_MODEL)}
              asleep={asleep}
              // The list announces ids as often as names — `claude-opus-5[1m]`
              // is what one chat calls the model it is running — and the chip a
              // few lines above this said something else about the same build.
              // One function names it for both (bw-ja9l.11).
              options={view.menu.models.map((m) => ({
                value: m.value,
                label: modelName(m.value, m.displayName) ?? m.displayName,
                hint: m.description,
              }))}
              defaultValue={modelDefaults[sessionBrand] ?? null}
              onDefault={(model) => makeProviderDefault('model', model)}
              onPick={(model) => {
                setSteerError(null);
                void sendCommand({ type: 'session.model', sessionId, model }).catch((e: unknown) =>
                  setSteerError(e instanceof Error ? e.message : String(e)),
                );
              }}
            />
            <Picker
              icon={<Gauge className="h-3.5 w-3.5" />}
              label="Reasoning effort"
              testid="effort-picker"
              current={view.effort ?? null}
              asleep={asleep}
              options={view.menu.efforts.map((effort) => ({
                value: effort.value,
                label: effort.displayName,
                hint: effort.description,
              }))}
              defaultValue={effortDefaults[sessionBrand] ?? null}
              onDefault={(effort) => makeProviderDefault('effort', effort)}
              cannotDefault={(effort) => sessionBrand === 'claude' && effort === 'max'
                ? 'Claude supports Max for the current session only; it cannot be saved as the system default'
                : null}
              onPick={(effort) => {
                setSteerError(null);
                void sendCommand({ type: 'session.effort', sessionId, effort }).catch((e: unknown) =>
                  setSteerError(e instanceof Error ? e.message : String(e)),
                );
              }}
            />
            </div>
            <Button
              variant="ghost"
              mode="icon"
              size="sm"
              aria-label="Chat settings"
              title="Chat settings"
              data-testid="mobile-composer-settings"
              className="rounded-full text-muted-foreground sm:hidden"
              onClick={() => setComposerSettingsOpen(true)}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
            {view.menu.agentDefinitions.length > 0 && (
              <Badge
                variant="secondary"
                appearance="light"
                size="sm"
                title={view.menu.agentDefinitions.map((agent) => `${agent.name}${agent.description ? ` — ${agent.description}` : ''}`).join('\n')}
                data-testid="agent-definitions"
                className="hidden sm:inline-flex"
              >
                {view.menu.agentDefinitions.length} agent{view.menu.agentDefinitions.length === 1 ? '' : 's'}
              </Badge>
            )}
            <span className="ml-auto" />
            {busy ? (
              <Button
                variant="destructive"
                mode="icon"
                size="sm"
                aria-label="Stop"
                data-testid="stop-button"
                className="rounded-full"
                onClick={() => {
                  setSendError(null);
                  // A Stop that did not stop anything has to say so. It used to
                  // fail in silence: the rejection went nowhere, the chip went
                  // on spinning, and the only chat this ever happens in is one
                  // already broken enough that Stop is the last thing left to
                  // try (bw-sxzv.4).
                  void sendCommand({ type: 'session.stop', sessionId }).catch((e: unknown) => {
                    setSendError(`The chat could not be stopped. ${e instanceof Error ? e.message : String(e)}`);
                  });
                }}
              >
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                variant="primary"
                mode="icon"
                size="sm"
                aria-label={ownership.kind === 'elsewhere' ? 'Take over and send' : 'Send'}
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
        </Panel>
        <Dialog open={composerSettingsOpen} onOpenChange={setComposerSettingsOpen}>
          <DialogContent className="max-w-[calc(100vw-2rem)] sm:hidden" data-testid="mobile-composer-settings-dialog">
            <DialogHeader>
              <DialogTitle>Chat settings</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-2 [&_[data-testid$='-picker']]:h-10 [&_[data-testid$='-picker']]:w-full [&_[data-testid$='-picker']]:justify-start [&_[data-testid$='-picker']]:rounded-md">
              <Picker
                icon={<ModeMark mode={view.permissionMode} className="h-4 w-4" />}
                label="Permission mode"
                testid="mobile-mode-picker"
                current={view.permissionMode}
                currentLabel={modeWords(view.permissionMode)?.label}
                asleep={asleep}
                options={view.menu.permissionModes.map((mode) => ({
                  value: mode,
                  label: PERMISSION_MODE[mode]?.label ?? inWords(mode),
                }))}
                onPick={(mode) => {
                  setSteerError(null);
                  void sendCommand({ type: 'session.mode', sessionId, mode }).catch((error: unknown) =>
                    setSteerError(error instanceof Error ? error.message : String(error)),
                  );
                }}
              />
              {view.menu.collaborationModes.length > 0 && (
                <Picker
                  icon={<Workflow className="h-4 w-4" />}
                  label="Collaboration mode"
                  testid="mobile-collaboration-mode-picker"
                  current={view.collaborationMode}
                  currentLabel={view.menu.collaborationModes.find((mode) => mode.value === view.collaborationMode)?.displayName}
                  asleep={asleep}
                  options={view.menu.collaborationModes.map((mode) => ({
                    value: mode.value,
                    label: mode.displayName,
                    hint: mode.description,
                  }))}
                  onPick={(mode) => {
                    setSteerError(null);
                    void sendCommand({ type: 'session.collaboration-mode', sessionId, mode }).catch((error: unknown) =>
                      setSteerError(error instanceof Error ? error.message : String(error)),
                    );
                  }}
                />
              )}
              <Picker
                icon={<Cpu className="h-4 w-4" />}
                label="Model"
                testid="mobile-model-picker"
                current={view.model ?? BRAND_DEFAULT_MODEL}
                currentLabel={modelName(view.model ?? BRAND_DEFAULT_MODEL)}
                asleep={asleep}
                options={view.menu.models.map((model) => ({
                  value: model.value,
                  label: modelName(model.value, model.displayName) ?? model.displayName,
                  hint: model.description,
                }))}
                defaultValue={modelDefaults[sessionBrand] ?? null}
                onDefault={(model) => makeProviderDefault('model', model)}
                onPick={(model) => {
                  setSteerError(null);
                  void sendCommand({ type: 'session.model', sessionId, model }).catch((error: unknown) =>
                    setSteerError(error instanceof Error ? error.message : String(error)),
                  );
                }}
              />
              <Picker
                icon={<Gauge className="h-4 w-4" />}
                label="Reasoning effort"
                testid="mobile-effort-picker"
                current={view.effort ?? null}
                asleep={asleep}
                options={view.menu.efforts.map((effort) => ({
                  value: effort.value,
                  label: effort.displayName,
                  hint: effort.description,
                }))}
                defaultValue={effortDefaults[sessionBrand] ?? null}
                onDefault={(effort) => makeProviderDefault('effort', effort)}
                cannotDefault={(effort) => sessionBrand === 'claude' && effort === 'max'
                  ? 'Claude supports Max for the current session only; it cannot be saved as the system default'
                  : null}
                onPick={(effort) => {
                  setSteerError(null);
                  void sendCommand({ type: 'session.effort', sessionId, effort }).catch((error: unknown) =>
                    setSteerError(error instanceof Error ? error.message : String(error)),
                  );
                }}
              />
            </div>
          </DialogContent>
        </Dialog>
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
