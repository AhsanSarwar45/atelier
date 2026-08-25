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
  Brain,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Hand,
  Loader2,
  MessageSquareDot,
  Moon,
  RefreshCw,
  Shrink,
  SquareTerminal,
  Terminal,
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
 * on a line where every other chip carries one — and "Stopped" and "Failed"
 * read alike at a glance because the word was the whole of the difference
 * (bw-ja9l.12).
 */
const MARK: Record<StateMark, typeof Bot> = {
  thinking: Brain,
  answering: MessageSquareDot,
  running: Terminal,
  summarising: Shrink,
  retrying: RefreshCw,
  helping: Bot,
  working: Loader2,
  waiting: Hand,
  ready: CircleCheck,
  asleep: Moon,
  stopped: CircleSlash,
  failed: CircleAlert,
};

/**
 * The ones that must not look still, and the rule for how each moves.
 *
 * Everything happening moves; everything at rest is still. They do not all move
 * the same way, because the difference is the point — a spin reads as a machine
 * turning something over, a pulse as something waiting to be attended to. The
 * two that are waiting on a person or on a clock pulse; the rest spin.
 */
const MOVES: Partial<Record<StateMark, string>> = {
  thinking: 'animate-pulse',
  answering: 'animate-pulse',
  running: 'animate-pulse',
  summarising: 'animate-pulse',
  retrying: 'animate-spin',
  helping: 'animate-pulse',
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
 * Short enough that splitting it buys nothing: any line with room for the word
 * has room for this whole.
 */
const WHOLE = 20;

/**
 * The most a pinned tail may take. Past this it is not the end of a line, it is
 * a second line, and it would push the word and the counter off the front the
 * way the whole clause used to.
 */
const TAIL_MOST = 22;

/** And the least it keeps when there is no seam worth cutting at. */
const TAIL_LEAST = 12;

/**
 * The detail, split where the ellipsis should fall.
 *
 * The manager, 2026-08-25, photographing the list: "ing for
 * NothingShowing|KindFilter in workbench/chat-". Both ends of what the chat was
 * doing were gone — the front because the mark and the word were pushed off the
 * line, the back because the browser only ever cuts at the end. What he asked
 * for is a cut in the middle, with the mark and the counter always on screen.
 *
 * So the clause is drawn as two pieces rather than one: a head that gives way,
 * and a tail that does not. The browser's own ellipsis then lands where the head
 * is cut, which is the middle of the string, and both ends read —
 * "Searching for Nothing…/chat-sidebar.tsx". Nothing here is measured: no
 * observer, no text metrics, no second pass. A list of forty rows costs what
 * forty rows cost before, which is the whole reason it is done this way and not
 * by asking the browser how wide the line came out.
 *
 * The seam is chosen so what survives on the right is worth reading — the last
 * part of a path, or the last word — and so any space at the seam rides in the
 * tail, where `whitespace-pre` keeps it. A space left at the end of the head is
 * at the end of its own line box, and the browser throws those away, which
 * would glue the two halves together the moment there was room for both.
 *
 * Returns the tail empty when there is nothing to gain, and head + tail is
 * always exactly what came in.
 */
export function splitDetail(text: string): [head: string, tail: string] {
  if (text.length <= WHOLE) return [text, ''];

  const slash = text.lastIndexOf('/');
  if (slash > 0 && text.length - slash <= TAIL_MOST) return [text.slice(0, slash), text.slice(slash)];

  const word = text.lastIndexOf(' ', text.length - 2);
  if (word > 0 && text.length - word <= TAIL_MOST) return [text.slice(0, word), text.slice(word)];

  const cut = text.length - TAIL_LEAST;
  return [text.slice(0, cut), text.slice(cut)];
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
  // Whether seconds are counted is the reading's call, not this file's: it
  // nulls `since` for everything at rest. Gating on `working` on top of that
  // silently dropped the one clock that matters most — how long a chat has been
  // stopped waiting for somebody to approve something (bw-jaoz.14.3).
  const count = seconds(state.since, now);
  // Split before anything is drawn rather than inside the markup: what the two
  // halves are is a reading of the string, and the markup below is only where
  // they go (bw-gnzl).
  const [said, ended] = state.detail ? splitDetail(state.detail) : ['', ''];
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
      {/* The word is never the thing that gives way. On a narrow rail the chip
          shrinks, and cutting the word first drew "Helper wo…", which is the
          one part of the chip that has to be read whole — what it is on can be
          cut short and still leave a true line (bw-jaoz.14.14). */}
      <span className="shrink-0">{state.word}</span>
      {/* What this particular one is — the time a limit lifts, how many helpers
          are out, the path being searched. Quieter than the word, and cut short
          rather than wrapping: "Retrying" alone leaves the reader watching a
          chat that says nothing about when it comes back (bw-jaoz.14.8).

          It is the only thing on this line that gives way, and it gives way in
          the middle. The head shrinks and the browser cuts it; the tail is
          pinned, so the end of the path or the last word survives a rail too
          narrow for the rest (splitDetail, bw-gnzl). That is also what keeps
          the mark and the counter on screen: with a child that can shrink, the
          chip fits itself to the line instead of overflowing an edge that hides
          whatever crosses it. */}
      {state.detail && (
        <span
          data-testid="chat-state-detail"
          // `overflow-hidden` because the tail does not give way: on a rail too
          // narrow for both halves the head shrinks to nothing and the tail
          // carries on past the box, and with nothing clipping it, it was drawn
          // straight over the counter beside it.
          className="flex min-w-0 items-center overflow-hidden opacity-70"
        >
          <span className="truncate">· {said}</span>
          {/* Nearly pinned, not pinned. A tail that cannot give way at all is
              a fixed width the rest of the line has to find room for, and when
              it could not, the head went to nothing and the end of the clause
              was all that was left. A shrink factor this small means the head
              gives up nine tenths of whatever is missing and the tail a tenth,
              so both ends of the clause survive a rail too narrow for it. */}
          {ended && <span className="min-w-0 shrink-[0.12] overflow-hidden whitespace-pre">{ended}</span>}
        </span>
      )}
      {count && (
        <span data-testid="chat-state-count" className="shrink-0 font-mono tabular-nums opacity-70">
          {count}
        </span>
      )}
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
        // `justify-start`, against the chip's own `justify-center`: a centred
        // box spreads whatever will not fit over BOTH its edges, so the moment
        // the line ran long the mark went off the front and the counter off the
        // back, and the row wrapper's `overflow-hidden` hid both. Packed to the
        // start, anything that will not fit can only go off the end — and with
        // the clause able to shrink, nothing does.
        'shrink-0 justify-start gap-1.5',
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
