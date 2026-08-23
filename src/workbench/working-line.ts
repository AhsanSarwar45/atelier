/**
 * Whether the foot of a conversation is drawing a turn in flight, and in whose
 * words.
 *
 * The line under the last message is the thing a reader watches while they wait
 * — its spinner is how a screen says "still going" — and it asked one question
 * to decide whether to draw at all: is a driver of OURS busy. A chat a terminal
 * is working in has no driver of ours, so the foot of it was blank however hard
 * that terminal worked, beside a chip an inch above it that said Working
 * (bw-jaoz.3).
 *
 * So the decision is made once, here, from the same reading the chip is drawn
 * from — and the two cannot say different things. Ours wins when we have one,
 * because our own driver names its state every second and the holder's reading
 * is inferred from a file.
 *
 * Pure and out of the component so it can be read on its own: the component
 * around it is a chat screen with a stream, a store and a text box in it.
 */
import type { ChatState, Doing } from '@/workbench/chat-state';

/** Everything the line draws, or nothing when no turn is in flight. */
export interface WorkingLineNow {
  /** What is happening, in the words of whoever is doing it. */
  label: string;
  /**
   * What this particular one is, beside the label: the time a limit lifts, how
   * many helpers are out. Off the one reading, so the foot and the chip an inch
   * above it name the same thing (bw-jaoz.14.8).
   */
  detail: string | null;
  /**
   * What the bar fills against, in milliseconds — this project's own median
   * once the app has watched enough of its runs, null for the machine-wide one
   * (summarising.ts).
   */
  typicalMs: number | null;
  /**
   * Which of the things a chat does this is, off the one reading — so the line
   * can draw what a word cannot. Summarising is the state that gets a bar
   * (bw-jaoz.14.5); everything else is open-ended and gets a clock.
   */
  doing: Doing;
  /** When THIS step started, ms since the epoch, for the count beside the label. */
  since: number | null;
  /**
   * When the whole turn started, for the quieter number beside that one. Null
   * when the step already says everything there is to say (turnWorthSaying).
   */
  turn: number | null;
  /** The brand's own count for the call being made, in seconds; 0 when none. */
  reported: number;
  /** It is waiting on the reader rather than working — a different mark. */
  waiting: boolean;
  /** Thinking the brand did but withheld, as its own estimate of the size. */
  thought: number;
}

/**
 * The call in flight, whoever is making it: our own driver's, or — since a held
 * chat's record is now drawn as it is written (bw-jaoz.5) — the holder's.
 */
export interface CallInFlight {
  title: string;
  seconds: number;
}

export function workingLine(now: {
  /** Whether a driver of ours owes an answer on this chat. */
  busy: boolean;
  /** Our own driver's word for what it is doing. */
  label: string;
  /** When our own driver started owing that answer. */
  since: number | null;
  /** Our own driver is waiting on the reader. */
  waiting: boolean;
  /** Our own driver's withheld thinking. */
  thought: number;
  /** The one reading, as the chip beside it draws it (chat-state.ts). */
  state: ChatState;
  running: CallInFlight | null;
  /** How long this project's summarising runs take, when it has enough of its own. */
  typicalMs?: number | null;
}): WorkingLineNow | null {
  const reported = now.running?.seconds ?? 0;
  if (now.busy) {
    return {
      label: now.label,
      detail: now.state.detail,
      typicalMs: now.typicalMs ?? null,
      doing: now.state.doing,
      since: now.since,
      // Off the one reading, so the line and the chip an inch above it cannot
      // disagree about whether the turn is worth a second number at all.
      turn: now.state.turnSince,
      reported,
      waiting: now.waiting,
      thought: now.thought,
    };
  }
  // Somebody else's turn. The label is the command they are running when there
  // is one — which is what their terminal is showing them — and their own state
  // word otherwise, so a think says Working rather than naming a stale call.
  // Never `waiting`: that mark means the chat is asking THIS reader for
  // something, and a chat held elsewhere is asking its holder, not them.
  if (now.state.working) {
    return {
      label: now.running?.title ?? now.state.word,
      detail: now.state.detail,
      typicalMs: now.typicalMs ?? null,
      doing: now.state.doing,
      since: now.state.since,
      turn: now.state.turnSince,
      reported,
      waiting: false,
      thought: 0,
    };
  }
  return null;
}
