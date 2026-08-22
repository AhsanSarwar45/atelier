/**
 * The one thing every screen draws about a chat.
 *
 * A moving mark and its own verb while something is happening, one word where
 * it stands otherwise, and — beside it, never instead of it — the badge that
 * says another program is holding it. The reading behind it is
 * {@link chatState}; this file is only how it looks (bw-96is).
 *
 * The seconds come off one clock for the whole page. A list of forty rows drew
 * forty intervals before, each one waking React on its own second, and the
 * number they were all counting is the same number.
 */
'use client';

import { useSyncExternalStore } from 'react';

import {
  Bot,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  Hand,
  Loader2,
  Moon,
  SquareTerminal,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { HOLDER_WORD, type ChatState, type Holder, type StateMark } from '@/workbench/chat-state';
import { forHowLong } from '@/workbench/elapsed';

/**
 * The mark on the badge, one per kind of holder.
 *
 * It carries the tooltip's fact without the tooltip: a window somebody types
 * in, or a program driving the kit. It is also half of what tells the badge
 * from the chip beside it at a glance — the other half being the colour and
 * the corners (bw-96is.10).
 */
const HOLDER_ICON: Record<Holder, typeof Bot> = {
  terminal: SquareTerminal,
  program: Bot,
};

/**
 * The mark for each standing a chat can be in.
 *
 * Only the two moving ones had a mark before, so a chat at rest was a bare word
 * on a line where every other chip carries one — and "Stopped", "Failed" and
 * "Ended" all read alike at a glance because the word was the whole of the
 * difference (bw-ja9l.12).
 */
const MARK: Record<StateMark, typeof Bot> = {
  working: Loader2,
  waiting: Hand,
  ready: CircleCheck,
  asleep: Moon,
  stopped: CircleSlash,
  failed: CircleAlert,
  ended: CircleDashed,
};

/** The two that must not look still, and the rule for how they move. */
const MOVES: Partial<Record<StateMark, string>> = {
  working: 'animate-spin',
  waiting: 'animate-pulse',
};

const listeners = new Set<() => void>();
let beat: ReturnType<typeof setInterval> | null = null;
let tick = Date.now();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!beat) {
    beat = setInterval(() => {
      tick = Date.now();
      listeners.forEach((f) => f());
    }, 1000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size > 0 || !beat) return;
    clearInterval(beat);
    beat = null;
  };
}

/** The current second, shared by every chip on the page. */
function useSecond(): number {
  return useSyncExternalStore(
    subscribe,
    () => tick,
    () => 0,
  );
}

/** How long it has been at it, or an empty string when nothing is counting. */
function seconds(since: number | null, now: number): string {
  if (!since) return '';
  return forHowLong(Math.max(0, Math.floor((now - since) / 1000)));
}

/**
 * The chip.
 *
 * `size` says whether it is a chip of its own — a row in the list, the open
 * chat's own line — or the small print inside a board card's line of text.
 *
 * A row and a line are the same size now. The row's was one step smaller, which
 * put its word one point off each edge against the line's four, so the same
 * chip read as crammed and sitting high on the list and correct in the chat
 * beside it — one screen disagreeing with another about a thing the reader
 * compares directly (bw-jaoz.1).
 */
export function ChatStateChip({
  state,
  size = 'chip',
  testId = 'chat-state',
  className,
}: {
  state: ChatState;
  size?: 'chip' | 'inline';
  testId?: string;
  className?: string;
}) {
  const now = useSecond();
  const count = state.working ? seconds(state.since, now) : '';
  // Nothing is known and nothing is claimed: the external badge beside this is
  // the whole of what the screen can honestly say.
  if (!state.word) return null;

  const Mark = MARK[state.mark];
  const body = (
    <>
      <Mark
        className={cn('size-3 shrink-0', MOVES[state.mark])}
        aria-hidden="true"
        data-testid="chat-state-mark"
        data-mark={state.mark}
      />
      <span className="truncate">{state.word}</span>
      {count && <span className="shrink-0 font-mono tabular-nums opacity-70">{count}</span>}
    </>
  );

  if (size === 'inline') {
    return (
      <span
        data-testid={testId}
        data-working={state.working ? 'yes' : 'no'}
        data-word={state.word}
        className={cn('flex min-w-0 items-center gap-1.5 text-[11px]', className)}
      >
        {body}
      </span>
    );
  }

  // A chip that is neither working nor waiting is filled with the theme's
  // `secondary`, and in every theme this app ships that is the same colour as
  // `accent`, which is what fills the row the reader has open. So "Idle" and
  // "Asleep" lost their shape on exactly the row he is looking at and read as
  // loose text — the fault just fixed on the badge beside them (bw-96is.16).
  //
  // The fill stays, because on the other forty rows it is right. What is added
  // is an edge, so the shape survives whatever the chip is standing on. Mixed
  // from the chip's own text colour rather than named from a theme token:
  // `border` too equals `secondary` in half the themes, while the text has to
  // contrast with the fill or the chip could not be read at all.
  const atRest = !state.working && !state.waiting;

  return (
    <Badge
      variant={state.working ? 'primary' : state.waiting ? 'warning' : 'secondary'}
      appearance="light"
      size="sm"
      shape="circle"
      data-testid={testId}
      data-working={state.working ? 'yes' : 'no'}
      data-word={state.word}
      className={cn(
        'shrink-0 gap-1.5',
        atRest && 'border-[color-mix(in_srgb,currentColor_30%,transparent)]',
        className,
      )}
    >
      {body}
    </Badge>
  );
}

/**
 * The badge that says this conversation is somebody else's right now.
 *
 * Never in place of the chip: a held chat that is answering says both, which is
 * the whole correction — the word it replaced said "occupied" and was read as
 * "working" (bw-96is).
 *
 * Three things keep it apart from the chip it stands next to, none of which is
 * reading it: its own colour, square corners against the chip's round ones, and
 * a mark for the kind of holder. It was drawn `secondary`/`outline`, for which
 * the badge has no rule of its own, so it fell back to the same flat grey as an
 * idle chip — and on a selected row, whose background is that same grey, it
 * lost its shape entirely and read as loose text (bw-96is.10).
 *
 * Quieter than the chip on purpose: an outline against the chip's fill. What
 * the chat is doing is the thing being read; who holds it is the footnote.
 */
export function ExternalBadge({
  holder,
  className,
}: {
  holder: Holder;
  className?: string;
}) {
  const Mark = HOLDER_ICON[holder];
  return (
    <Badge
      variant="info"
      appearance="outline"
      size="sm"
      shape="default"
      data-testid="chat-external"
      data-holder={holder}
      // The sentence is the reading's, not this file's, so the tooltip on a row
      // and the line where that chat's writing box would be cannot drift apart
      // (bw-96is.13). It punctuates here because a tooltip is one sentence; the
      // line continues its own.
      title={`${HOLDER_WORD[holder]}.`}
      // Outline, not fill. A filled badge in its own colour beat the chip
      // beside it, so the eye landed on who holds the chat before what the
      // chat is doing, which is the wrong way round.
      //
      // Which makes the border the whole of its shape, and the first attempt
      // at one drew nothing: `border-[var(--color-info-accent)]/45` asks the
      // styling tool to fade an arbitrary variable, which it cannot do, so it
      // emitted no border rule at all — the built sheet had that colour as
      // text and as a background and never as an edge — and the badge went on
      // vanishing into the open row exactly as before (bw-96is.19).
      //
      // Mixed from its own text colour instead, the same way the chip beside
      // it is (bw-96is.16): that compiles, and it cannot collide with what the
      // badge is standing on, because the text has to be readable against
      // whatever that is or there would be nothing to read.
      className={cn(
        'shrink-0 gap-1 border-[color-mix(in_srgb,currentColor_55%,transparent)] bg-transparent',
        className,
      )}
    >
      <Mark aria-hidden="true" />
      external
    </Badge>
  );
}
