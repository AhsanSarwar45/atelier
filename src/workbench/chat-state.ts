/**
 * What a chat is, in the three facts a reader actually asks for.
 *
 * Until this, every screen answered the question its own way and none of them
 * answered all of it. The chat's own line drew one word that was either the
 * driver's label or the word "working"; a row in the list drew a pill that was
 * either "ready" or "working"; a board card drew an activity; and the word
 * "working" — the loudest of them — meant only that a live process was holding
 * the conversation, which a terminal sitting at an empty prompt does all night.
 * The manager's reading of it, 2026-08-21: "just make sure everything about the
 * state of chat is intuitive. currently its awful."
 *
 * So there is one reading, and it separates three facts that were tangled into
 * one word:
 *
 * - **what it is doing this second** — working or not, in its own verb, with
 *   the seconds it has been at it. This is the moving mark, and it is the same
 *   mark whether an agent of ours is driving or a terminal is (§8.2.2).
 * - **where it stands when it is not working** — Ready, Asleep, Stopped,
 *   Failed. One word, and never at the same time as the mark, because a chat
 *   that is working is not also asleep.
 * - **who holds it** — nobody, or another program. This never stands in place
 *   of the other two: it is a badge beside them, so a held chat that is
 *   working says both (bw-96is).
 *
 * Pure, and here rather than in a component, because four screens draw it and
 * the whole point is that they cannot disagree.
 */
import type { SentAway, TranscriptItem } from '@/workbench/fold';
import type { AgentState, SessionState } from '@/workbench/protocol';
// Spelled the long way on purpose: this file is one the chat's own server
// reads, and Node has no aliases (bw-jaoz.5). A type import beside it may keep
// the short spelling — it is erased before Node ever sees it.
import { isOver } from './protocol.ts';

/** Which kind of program is holding a conversation of somebody else's. */
export type Holder = 'terminal' | 'program';

/**
 * What a held conversation is doing, as far as the machine can tell.
 *
 * The same vocabulary a chat of ours is drawn from, and not a shorter one:
 * a terminal summarising itself is doing the same thing ours does, and the
 * reader is owed the same word for it. What differs between the two is only
 * how much of it the machine can see, which {@link ChatState.told} carries.
 */
export type HeldDoing = Doing;

/**
 * A conversation another program holds, as the sidecar reports it.
 *
 * `doing` is `unknown` when nothing on the machine will say: a host-driven
 * process writes no status, and if its record has not moved either then the
 * honest answer is that we do not know, not that it is idle. The badge says
 * somebody is in there; nothing pretends to know what they are up to.
 */
export interface HeldChat {
  /** The tool's own id for the conversation — the id the running set is keyed by. */
  id: string;
  holder: Holder;
  doing: HeldDoing;
  /** When it started doing THAT — the current step — or null when unknown. */
  since: number | null;
  /**
   * When the turn it is part of began, ms since the epoch, or null when
   * unknown. Absent reads as unknown, which is what every holder said before
   * anything counted two clocks.
   */
  turnSince?: number | null;
  /**
   * What it is doing, in its own words — the command in flight, the reason a
   * retry is waiting, how many helpers are out. Absent when the state carries
   * nothing beyond itself.
   */
  detail?: string | null;
  /**
   * Whether the holder said this itself or we worked it out from its record.
   * Absent reads as worked out, which is what every reading of a held chat was
   * before anything told us anything.
   */
  told?: boolean;
  /**
   * How long a summarising run usually takes in THIS project, measured from the
   * runs the app has watched begin and end — or null until it has watched
   * enough of them, and on every state that is not summarising, which has
   * nothing to fill a bar with (bw-jaoz.14.9).
   */
  typicalMs?: number | null;
}

/**
 * The same held chat with what it was doing taken out of it.
 *
 * For the moment a screen is holding an answer it can no longer stand behind:
 * the stream that keeps this current has dropped, and what it said last is a
 * memory. Who is in there survives that — a terminal does not walk away
 * because a browser lost its connection — and what they were doing does not,
 * because that is the half that was changing second by second. The reading
 * then draws the badge and no mark at all, which is the screen saying it does
 * not know rather than drawing a clock that is still ticking on a dead fact
 * (bw-96is.22).
 */
export function holderOnly(held: HeldChat | null | undefined): HeldChat | null {
  return held ? { ...held, doing: 'unknown', since: null, turnSince: null, detail: null, told: false } : null;
}

/**
 * Which mark stands beside the word.
 *
 * A chat that is doing something and one waiting on the reader each had one;
 * every other standing had a bare word, on a line where every neighbour is a
 * chip with a mark of its own (bw-ja9l.12). The kind is decided here, with the
 * word, because it is the same reading — the chip only knows how to draw it.
 */
export type StateMark =
  | 'thinking'
  | 'answering'
  | 'running'
  | 'summarising'
  | 'retrying'
  | 'helping'
  | 'working'
  | 'waiting'
  | 'ready'
  | 'asleep'
  | 'stopped'
  | 'failed';

/**
 * The whole vocabulary for what a chat is doing this second, and the only list
 * any screen draws from.
 *
 * There used to be one word for all of it. A chat summarising itself, one
 * thinking, one stopped dead on a permission prompt, one retrying after the
 * model refused and one whose helper is doing the work all drew "Working",
 * because the only signal read off a running session was a single yes-or-no.
 * The manager's screenshot, 2026-08-22: a two-minute summarising run drawn as
 * `Working 1h 38m` beside a command card that had already finished.
 *
 * `working` survives as its own member and is not a failure of this list: it is
 * what an honest reading says when the session is plainly busy and nothing on
 * the machine says at what. Guessing which of the seven it is would be worse
 * than the word it replaces.
 */
export type Doing =
  | 'thinking'
  | 'answering'
  | 'running'
  | 'waiting'
  | 'summarising'
  | 'retrying'
  | 'helping'
  | 'working'
  | 'idle'
  | 'unknown';

/**
 * The word each one draws. Empty for `unknown`, which is the reading declining
 * to claim anything — a badge may still say who holds the chat.
 */
export const DOING_WORD: Record<Doing, string> = {
  thinking: 'Thinking',
  answering: 'Answering',
  running: 'Running',
  waiting: 'Waiting for you',
  summarising: 'Summarising',
  retrying: 'Retrying',
  helping: 'Helper working',
  working: 'Working',
  idle: 'Idle',
  unknown: '',
};

/** The mark each one wears, per {@link StateMark}. */
export const DOING_MARK: Record<Doing, StateMark> = {
  thinking: 'thinking',
  answering: 'answering',
  running: 'running',
  waiting: 'waiting',
  summarising: 'summarising',
  retrying: 'retrying',
  helping: 'helping',
  working: 'working',
  idle: 'ready',
  unknown: 'ready',
};

/**
 * Whether seconds are counted beside the word.
 *
 * Everything happening counts, including the wait on the reader — a permission
 * prompt that has been up for four minutes is the one number that says so.
 * Nothing at rest counts: a clock ticking beside "Idle" is a claim that
 * something is going on.
 */
export const DOING_COUNTS: Record<Doing, boolean> = {
  thinking: true,
  answering: true,
  running: true,
  waiting: true,
  summarising: true,
  retrying: true,
  helping: true,
  working: true,
  idle: false,
  unknown: false,
};

/**
 * Which of them mean the chat owes an answer.
 *
 * The wait on the reader is deliberately not one: it is the chat asking rather
 * than working, and it has always drawn its own mark for exactly that reason.
 */
const DOING_WORKING: ReadonlySet<Doing> = new Set<Doing>([
  'thinking',
  'answering',
  'running',
  'summarising',
  'retrying',
  'helping',
  'working',
]);

/** Whether this is the chat doing something, as opposed to asking or resting. */
export function isWorking(doing: Doing): boolean {
  return DOING_WORKING.has(doing);
}

/** The three facts, as every screen draws them. */
export interface ChatState {
  /** Draw the moving mark: something is happening and the screen must not look still. */
  working: boolean;
  /** It is not working because it is waiting on the reader — a different mark. */
  waiting: boolean;
  /** Which of the vocabulary this is, for a screen that draws more than a word. */
  doing: Doing;
  /** Its own verb while working, where it stands otherwise, empty when unknown. */
  word: string;
  /**
   * What this particular one is doing, in its own words — the command being
   * run, the reason a retry is waiting, how many helpers are out. Null when
   * the state carries nothing beyond itself.
   */
  detail: string | null;
  /**
   * Whether the session said this itself, or we worked it out from its record.
   * Kept because the two tiers are combined by rule and the rule is worth
   * proving; a screen may also choose to be quieter about a guess.
   */
  told: boolean;
  /** Which mark goes beside that word. */
  mark: StateMark;
  /**
   * Where the loud seconds count from — the start of THIS step, ms since the
   * epoch, or null for no count.
   *
   * The step and not the turn. One clock counted the whole answer, so the
   * manager's screenshot said `1h 38m` beside a summarising run forty seconds
   * old: a number that cannot say whether anything is stuck, which is the one
   * question it is watched for (bw-jaoz.14.4).
   */
  since: number | null;
  /**
   * Where the quiet second number counts from — the start of the whole turn.
   *
   * Null when there is nothing more to say than the step already says, which
   * {@link turnWorthSaying} decides. The turn total is not deleted, only moved
   * off the loud number: how long this has been going on overall is worth
   * knowing, and it is not what the reader is asking when they look at a
   * spinner.
   */
  turnSince: number | null;
  /** Set only when another program holds it. */
  external: { holder: Holder } | null;
}

/**
 * How much longer the turn must have run than the step before it is worth a
 * second number.
 *
 * Below this the two numbers are the same fact printed twice — `40s · 41s` —
 * and a reader who has to compare two clocks to learn nothing is worse off than
 * one reading a single number. Above it the turn total says the thing the step
 * clock cannot: that this has been going on far longer than the piece of it you
 * can see. A legibility threshold, not a measurement.
 */
export const TURN_WORTH_SAYING_MS = 30_000;

/**
 * The turn's start, or null when the step already tells the whole story.
 *
 * One place, because the chip, the foot line and a board card must not disagree
 * about whether there is a second number at all.
 */
export function turnWorthSaying(step: number | null, turn: number | null): number | null {
  if (step === null || turn === null) return null;
  return step - turn >= TURN_WORTH_SAYING_MS ? turn : null;
}

/**
 * What each of our own states is, when the driver sent no word of its own.
 *
 * The driver names every state it publishes, so this is a floor rather than the
 * usual answer: a chat whose label came from a log line written by a process
 * that has since died would otherwise draw that dead process's last word.
 */
const OWN_WORD: Record<SessionState, string> = {
  // Read only for a chat that has something to come back to; one nobody has
  // spoken in yet never reaches this row ({@link standing}).
  starting: 'Coming back',
  idle: 'Ready',
  thinking: 'Thinking',
  streaming: 'Answering',
  running_tool: 'Running',
  waiting_permission: 'Waiting for you',
  stopped: 'Stopped',
  errored: 'Failed',
  dormant: 'Asleep',
};

/** Which mark each of our own states wears, per {@link StateMark}. */
const OWN_MARK: Record<SessionState, StateMark> = {
  starting: 'working',
  idle: 'ready',
  thinking: 'thinking',
  streaming: 'answering',
  running_tool: 'running',
  waiting_permission: 'waiting',
  stopped: 'stopped',
  errored: 'failed',
  dormant: 'asleep',
};

/**
 * Which of the vocabulary each of our own states is.
 *
 * Our own driver has always published a state per second; what it never had was
 * a shared word for it, so the three busy ones all drew one mark and a chat of
 * ours read no better than a terminal's. They map straight across — the
 * vocabulary was built to hold both — and the states that are not the chat
 * doing something map to `idle`, because where it stands is the other half of
 * the reading and is drawn from {@link OWN_WORD} rather than from here.
 */
const OWN_DOING: Record<SessionState, Doing> = {
  starting: 'working',
  idle: 'idle',
  thinking: 'thinking',
  streaming: 'answering',
  running_tool: 'running',
  waiting_permission: 'waiting',
  stopped: 'idle',
  errored: 'idle',
  dormant: 'idle',
};

/** The states in which an agent of ours owes an answer. */
const OWN_WORKING: ReadonlySet<SessionState> = new Set<SessionState>([
  'starting',
  'thinking',
  'streaming',
  'running_tool',
]);

/**
 * Whether one of our own states counts seconds beside its word.
 *
 * Working, or waiting on him — the two things that are still going on while he
 * reads them. Exported because the live store stamps the moment they begin and
 * needs the same list the reading uses (live.ts).
 */
export function counting(state: SessionState): boolean {
  return OWN_WORKING.has(state) || state === 'waiting_permission';
}

export interface ChatStateInput {
  /** The state our own driver last published for this chat. */
  state: SessionState;
  /**
   * Whether anything has ever been said in this chat.
   *
   * Only `starting` needs it, and {@link standing} says why. Absent reads as
   * yes, so a caller that has no way of knowing — and every caller written
   * before the question was asked — reads a chat exactly as it always did.
   */
  spokenIn?: boolean;
  /** The word it published with it, if any. */
  label?: string | null;
  /** When that state began, ms since the epoch, for the loud seconds count. */
  since?: number | null;
  /**
   * When the turn that state is part of began — the quiet second number. Our
   * own driver restarts `since` on every change of words, which is what makes
   * it a step clock and this the only place the whole answer's length lives.
   */
  turnSince?: number | null;
  /** What the sidecar says about the program holding it, when one does. */
  held?: HeldChat | null;
  /**
   * What this one is doing, in its own words — the command being run, why a
   * retry is waiting. Drawn beside the word, never in place of it.
   */
  detail?: string | null;
}

/**
 * Which of our own states a chat is really in.
 *
 * One word, `starting`, is published for two different things: a conversation
 * being woken with everything already said in it, and a chat that has just been
 * made and never asked anything. Only the first is coming back from somewhere.
 * The second has no turn to watch, so its clock counted from the moment it was
 * created — a spinner reading `Starting 0s` over a blank chat, and a row beside
 * it saying `Coming back 6s` from a chat that had never been anywhere.
 *
 * So a chat nothing has been said in stands where it is, and the word, the
 * mark, whether the mark moves and both clocks all follow from that. Decided
 * here for the reason everything else is: four screens draw this and they must
 * not disagree about which of the two a chat is.
 */
function standing(input: ChatStateInput): SessionState {
  return input.state === 'starting' && input.spokenIn === false ? 'idle' : input.state;
}

/**
 * The one reading. Every screen draws this and nothing else.
 *
 * A held chat is read from what the holder says about itself, not from our own
 * last state: our state for such a chat is `dormant` — no agent of ours is
 * attached — and drawing "Asleep" over a terminal in the middle of a turn is
 * the exact lie this replaces. The reverse holds too: a chat of ours that is
 * answering is never held, because the server removes provider processes owned
 * by our driver before publishing the outside-owner set. A read-only follower
 * may itself be awake while it tails a held external transcript.
 */
export function chatState(input: ChatStateInput): ChatState {
  const held = input.held ?? null;
  if (held) {
    const doing = held.doing;
    return {
      working: isWorking(doing),
      // A held chat can be stopped on a permission prompt too, and it draws the
      // same warning mark ours does. This used to be flatly `false` on the
      // grounds that a held chat asks its holder rather than this reader — true
      // of who answers it, and beside the point on a screen whose whole job is
      // to show that something has stopped and is waiting on a person
      // (bw-jaoz.14.3).
      waiting: doing === 'waiting',
      doing,
      word: DOING_WORD[doing],
      detail: held.detail ?? null,
      told: held.told ?? false,
      // A held chat that is doing nothing is standing there, which is what
      // "Idle" says; the badge beside it is who is holding it.
      mark: DOING_MARK[doing],
      since: DOING_COUNTS[doing] ? held.since : null,
      turnSince: DOING_COUNTS[doing] ? turnWorthSaying(held.since, held.turnSince ?? null) : null,
      external: { holder: held.holder },
    };
  }

  const state = standing(input);
  const word = input.label && input.label.length > 0 ? input.label : OWN_WORD[state];
  const working = OWN_WORKING.has(state);
  return {
    working,
    waiting: state === 'waiting_permission',
    doing: OWN_DOING[state],
    word: word ?? '',
    detail: input.detail ?? null,
    // Our own driver publishes its state every second; nothing here is inferred.
    told: true,
    // Off the state and never off the word: the driver names its own states, so
    // the word can be anything it likes while the standing behind it is one of
    // ten we know (bw-ja9l.12).
    mark: OWN_MARK[state],
    since: working || state === 'waiting_permission' ? (input.since ?? null) : null,
    turnSince:
      working || state === 'waiting_permission'
        ? turnWorthSaying(input.since ?? null, input.turnSince ?? null)
        : null,
    external: null,
  };
}

/**
 * Where a helper stands, said in the chat's own words.
 *
 * A helper has a vocabulary of its own — running, waiting, parked, done,
 * failed, stopped — and the reader is not owed a second one. Each is spoken
 * here as one of ours, so the mark on a helper's card is the mark he already
 * knows from the chat's own line and from the row in the list.
 *
 * `parked` is the only one that needs a word of its own: it is still running,
 * so it wears the running mark, and "Working" would not say the thing that is
 * true about it.
 */
const HELPER_STANDS: Record<AgentState, { state: SessionState; label: string | null }> = {
  running: { state: 'running_tool', label: null },
  waiting: { state: 'waiting_permission', label: null },
  parked: { state: 'running_tool', label: 'In background' },
  done: { state: 'idle', label: 'Done' },
  failed: { state: 'errored', label: null },
  stopped: { state: 'stopped', label: null },
};

/** The last thing this helper produced, or null before it has produced one. */
function itsLastRow(row: SentAway, items: readonly TranscriptItem[]): TranscriptItem | null {
  // The call that sent it off is the join key everywhere, not the id the kit
  // gave the agent: that is what its rows carry (fold.ts, `parentId`).
  const key = row.toolCallId ?? row.id;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if ('parentId' in item && item.parentId === key) return item;
  }
  return null;
}

/**
 * What one helper is doing this second, for the card that stands in for it.
 *
 * Read from the helper's own rows rather than from the progress the kit sends
 * about it. The kit reports about twice a minute, so a card drawn from
 * {@link SentAway.doing} alone goes on saying "Reading the router" for half a
 * minute after the router was read. Its rows arrive as they happen, and now
 * that they are no longer drawn in the manager's transcript they are exactly
 * what the card is for.
 *
 * No seconds: `since` is left null on purpose, because the card counts its own
 * clock beside this, and two counts of one thing that disagree by a second is
 * a fault this app has already fixed once (bw-jaoz.6).
 *
 * A helper that has finished settles rather than going blank — Done, Failed,
 * Stopped — because a card whose line empties reads as a card that has lost
 * track of its own work.
 */
export function helperState(row: SentAway, items: readonly TranscriptItem[]): ChatState {
  const { state, label } = HELPER_STANDS[row.state];
  // Over is over, and waiting is his turn: neither reading is improved by
  // whatever row happened to arrive last.
  if (isOver(row.state)) return chatState({ state, label, since: null });
  if (row.state === 'waiting') return chatState({ state, label, since: null, detail: row.doing });

  const last = itsLastRow(row, items);
  if (last?.kind === 'tool' && last.status === 'running') {
    // Its own present-tense line where the kit has sent one for this call, the
    // call's own title otherwise. Never the bare name of the tool: the title is
    // what the transcript would have drawn, and this card stands in for it.
    return chatState({ state: 'running_tool', label, since: null, detail: last.summary ?? last.title });
  }
  if (last?.kind === 'thinking' && !last.done) return chatState({ state: 'thinking', label, since: null });
  if (last?.kind === 'message' && last.role === 'assistant' && !last.done) {
    return chatState({ state: 'streaming', label, since: null });
  }
  // Nothing of its own to read yet, or a moment between rows: the kit's last word.
  return chatState({ state, label, since: null, detail: row.doing });
}

/**
 * The two tiers of truth, in the one order they are ever combined.
 *
 * **Told** is a signal the session emitted about itself — our own driver's
 * published state, or a hook the session fired as it began summarising or put a
 * permission prompt up. It is exact.
 *
 * **Read** is what we worked out from the tail of its record. It is a good
 * guess and it is never better than a fact, so it never wins.
 *
 * The order is a rule rather than a preference, because the failure it prevents
 * is one-sided: a read that overrides a told signal draws a confident wrong
 * word (a summarising chat, silent for two minutes, reads as a chat somebody
 * walked away from), while a told signal that overrides a read one is only ever
 * more specific than what it replaced.
 *
 * `unknown` on either side is that side declining to say, not an answer, so it
 * never displaces the other.
 */
export function whatItIsDoing(now: {
  told: { doing: Doing; since: number | null; detail?: string | null } | null;
  read: { doing: Doing; since: number | null; detail?: string | null } | null;
}): { doing: Doing; since: number | null; detail: string | null; told: boolean } {
  const said = now.told && now.told.doing !== 'unknown' ? now.told : null;
  const seen = said ?? now.read;
  if (!seen) return { doing: 'unknown', since: null, detail: null, told: false };
  return {
    doing: seen.doing,
    since: DOING_COUNTS[seen.doing] ? seen.since : null,
    detail: seen.detail ?? null,
    told: said !== null,
  };
}

/**
 * How long a record must have been quiet before a chat nothing else will speak
 * for is called idle.
 *
 * A host-driven process writes no status, so the only sign of life left is its
 * own record growing. Ten seconds is long enough to cover the gap between two
 * lines of one answer — a tool call that takes a while writes nothing while it
 * runs — and short enough that a chat somebody walked away from stops claiming
 * to be working while the reader watches it.
 */
export const RECORD_QUIET_MS = 10_000;

/**
 * What a held conversation is doing, from the two signals there are.
 *
 * The holder's own word wins whenever it gives one: it is the tool saying what
 * it is doing rather than us inferring it from a file. Failing that, the record
 * moving is the only evidence on the machine — measured wrong for liveness
 * (a working chat was silent for 488 seconds, §6.3.4) but right for this, which
 * is the opposite question: a record that grew a moment ago is a chat producing
 * something now. And failing both, `unknown`, which draws no claim at all.
 *
 * Two of the vocabulary's words are not answers to "is anything happening" at
 * all, and neither the status bit nor a modified time will ever reach them: a
 * chat held back by a usage limit, and one whose work is being done by helpers.
 * Both are read off the record instead — the words on its last line, and the
 * files of the agents it sent off ({@link tailState}) — and both are preferred
 * to the timers, which cannot contradict them because they are answering a
 * narrower question.
 *
 * `burstAt` is when this chat was first seen working in the current burst, kept
 * by the caller across beats, so the turn counted is the turn's and not the
 * beat's. It comes back as `turnSince`, the quiet number; `since` is the start
 * of the step, which for a record we are only reading is its last write.
 */
export function heldDoing(args: {
  status: string | null;
  statusAt: number | null;
  recordMovedAt: number | null;
  /**
   * Whether the end of the record leaves an answer owed, or null when nothing
   * could be read. {@link answerOwed}.
   */
  owed: boolean | null;
  /**
   * What that same last line named outright, where it named one of the two
   * states a modified time cannot reach. {@link tailState}.
   */
  tail?: TailState | null;
  /**
   * How many helpers this chat has out and still working, and when the oldest
   * went off — asked as a question rather than passed as a number, because the
   * answer is a directory listing and it is wanted in one case only: a turn of
   * its own that is over while theirs are not. Every other reading below is
   * settled without touching the disk again, and this is not asked at all.
   */
  helpersOut?: () => { out: number; since: number | null };
  burstAt: number | null;
  now: number;
}): { doing: HeldDoing; since: number | null; turnSince: number | null; detail?: string | null } {
  // The status bit says busy and nothing about steps: one clock, and no second
  // number to draw beside it.
  if (args.status === 'busy') return { doing: 'working', since: args.statusAt, turnSince: null };
  if (args.status === 'idle') return { doing: 'idle', since: null, turnSince: null };
  // A turn in flight, whether or not anything has been written this minute.
  //
  // The last line written is where the current step began: a command is issued,
  // the record moves, and then it runs silently for as long as it runs. That is
  // the number the reader is watching. The burst's own start is the turn behind
  // it, and it goes in the quiet second place rather than over the top of the
  // step (bw-jaoz.14.4).
  // What the last line SAID, before what its date implies. The two readings are
  // of the same line, so this costs nothing extra and is strictly more specific:
  // it names the step where the timers can only say that there is one.
  if (args.tail) {
    return {
      doing: args.tail.doing,
      since: args.recordMovedAt ?? args.burstAt ?? args.now,
      turnSince: args.burstAt,
      detail: args.tail.detail,
    };
  }
  if (args.owed === true) {
    return { doing: 'working', since: args.recordMovedAt ?? args.burstAt ?? args.now, turnSince: args.burstAt };
  }
  if (args.recordMovedAt === null) return { doing: 'unknown', since: null, turnSince: null };
  const moving = args.now - args.recordMovedAt < RECORD_QUIET_MS;
  if (!moving) {
    // Its own turn is over and somebody else's is not. A helper's turns are in
    // a file of its own and the chat's record says nothing more about it once
    // it has been sent off, so a chat with three agents mid-flight drew Idle —
    // and it is the ordinary way they run: of the 1,445 dispatches on this
    // machine, 1,344 were answered within two seconds and left the helper
    // working detached behind them (2026-08-22).
    const helpers = args.helpersOut?.() ?? { out: 0, since: null };
    if (helpers.out > 0) {
      return {
        doing: 'helping',
        since: helpers.since,
        // The chat's own turn ended, so there is no turn of its own left to
        // count: the helpers' own start is the only clock this state has.
        turnSince: null,
        detail: helperCount(helpers.out),
      };
    }
    return { doing: 'idle', since: null, turnSince: null };
  }
  return { doing: 'working', since: args.recordMovedAt, turnSince: args.burstAt };
}

/**
 * Does the end of a chat's record leave an answer owed?
 *
 * The question the ten-second rule below could not answer. A think writes
 * nothing at all — a minute of it, two minutes of it — so a chat in the middle
 * of one looked exactly like a chat somebody had walked away from, and the mark
 * on it went out and came back with every command it ran: the manager's "the
 * working chip only shows when its running some commands" (bw-jaoz.4).
 *
 * The last thing written says it — but only once the kit's own lines are told
 * from the person's. The kit writes into the person's half of a record: the
 * marker it leaves when a turn is stopped, and the echo of every slash command
 * typed. Read as prompts, those left a chat drawing Working for ever, because
 * no answer is ever coming for them. Measured over every record on this machine
 * (2,775 of them, 2026-08-21): 182 that nothing had touched for an hour still
 * read as a turn in flight, and 152 of those were one of those two lines.
 *
 * So the rules, each one measured and each one the kit's own where it has one
 * (docs/agent-workbench.md §6.3.5):
 *
 * - The person's own words leave an answer owed. So does a tool's result coming
 *   back, and so does an assistant line that asked for a tool.
 * - An assistant line that only thought leaves the turn in flight: nothing ends
 *   on a thought. No record on this machine ends on one, so this costs nothing
 *   and it is the whole of what a long think looks like from outside.
 * - The line the kit writes when the person stops a turn owes nothing, and
 *   neither does the echo of a slash command. Both are matched with the kit's
 *   own patterns, lifted from its reader rather than guessed at.
 * - A compaction's summary owes nothing by itself; the kit does not count it as
 *   something the person said either.
 *
 * False, not true, when nothing could be read: a record that is not there
 * cannot say a turn is in flight. What it cannot say is left to the quiet timer
 * above.
 */
export function answerOwed(
  // Open, because the kit's own declaration of a stored line is open: three
  // named keys and `[k: string]: unknown` for everything else it writes there.
  said: { type?: string; message?: unknown; isCompactSummary?: boolean; [k: string]: unknown } | null,
): boolean {
  if (!said) return false;
  if (said.type === 'assistant') return assistantOwes(said.message);
  if (said.type !== 'user') return false;
  // Not the person talking, per the kit's own reader, which skips it when it
  // looks for the last thing he said.
  if (said.isCompactSummary === true) return false;

  const content = (said.message as { content?: unknown } | null | undefined)?.content;
  const spoken: string[] = [];
  if (typeof content === 'string') {
    spoken.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const part = block as { type?: string; text?: unknown } | null;
      if (!part) continue;
      // A tool answering back is the middle of a turn, whatever else is on the
      // line — the kit stops reading a line the moment it sees one, for the
      // same reason: it is not the person.
      if (part.type === 'tool_result') return true;
      if (part.type === 'text' && typeof part.text === 'string') spoken.push(part.text);
    }
  }
  // A line with nothing readable on it — an image, a shape nothing here knows —
  // is the person putting something there.
  if (spoken.length === 0) return true;
  return spoken.some((line) => {
    const words = line.replaceAll('\n', ' ').trim();
    if (!words) return false;
    return !STOPPED_BY_HAND.test(words) && !KIT_WROTE_IT.test(words);
  });
}

/**
 * The kit's own marker for a turn the person stopped.
 *
 * Its literal, from the kit's reader (`sdk.mjs`, the pattern it tests a user
 * line against before calling it something he said): a stopped turn and a
 * stopped tool call both write it, differing only inside the brackets.
 */
const STOPPED_BY_HAND = /^\[Request interrupted by user[^\]]*\]/;

/**
 * A slash command's own echo, and the output it printed.
 *
 * The kit writes both into the person's half of the record. Its own reader
 * skips any line opening with a tag of this shape; this list is the narrower
 * one — the tags that are the kit talking to itself — because two others of
 * that shape, a helper's finish notice and a reminder pushed into a turn, ARE
 * things an agent is expected to answer, and calling those settled would put a
 * chat back to sleep in the middle of the turn they started.
 */
const KIT_WROTE_IT =
  /^<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr)[\s>]/;

/**
 * Whether an assistant's last line leaves its own turn unfinished.
 *
 * Asking for a tool does. Thinking with nothing said does — a turn never ends
 * on a thought, and the kit writes a thought as its own line, so this is what
 * the middle of a long think looks like from outside (43,814 such lines on this
 * machine, and not one record that ends on one). Anything it actually said is
 * the turn over.
 */
function assistantOwes(message: unknown): boolean {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return false;
  let thought = false;
  let spoke = false;
  for (const block of content) {
    const kind = (block as { type?: string } | null)?.type;
    // Every block, not the first that says something: a line can say a word and
    // then call a tool, and it is the call that decides.
    if (kind === 'tool_use') return true;
    if (kind === 'text') spoke = true;
    if (kind === 'thinking') thought = true;
  }
  return thought && !spoke;
}

/** The shape the kit stores a line in, as open as its own declaration of one. */
type StoredLine = { type?: string; message?: unknown; [k: string]: unknown };

/**
 * A state a record's own last line names, and what that line says about it.
 *
 * Only the two the timers cannot reach. Everything else about a chat somebody
 * else is driving is a question of whether anything is happening, which a
 * modified time answers; these two are questions of WHAT, which only the words
 * on the line answer.
 */
export interface TailState {
  doing: Extract<Doing, 'retrying' | 'helping'>;
  /** Its own text or its own count — the reset time, the brief, the number out. */
  detail: string | null;
}

/**
 * What the end of a record names outright, where it names one of those two.
 *
 * A chat held back by a usage limit is doing nothing at all and is not idle: it
 * is waiting on a clock it will not miss, and the reader wants the time it comes
 * round. A chat blocked on a helper is working, but not at anything of its own,
 * and six minutes of "Working" with no hint that the six minutes belong to
 * somebody else is the reading the manager complained about in its other form.
 *
 * Both are written down, and both were being thrown away. Measured over every
 * record on this machine (1,116 of them, 2026-08-22): 234 lines saying a limit
 * was hit, and 77 records whose last line is one — every one of those chats
 * drawing Idle while it sat waiting for the reset. And 1,445 helper dispatches,
 * of which 101 were still unanswered two seconds later, the longest for 616
 * seconds: ten minutes of a chat claiming to be working at something of its own.
 *
 * Null when the line names neither, which is the ordinary case and leaves the
 * timers to answer as they did before.
 */
export function tailState(said: StoredLine | null): TailState | null {
  if (!said || said.type !== 'assistant') return null;
  // The kit's own flag for a line it wrote in place of an answer. Asked first
  // because such a line carries text and nothing else, so the helper read below
  // could never match it anyway — but the order says which is meant.
  if (said.isApiErrorMessage === true) return heldByALimit(said.message);
  return helpersAskedFor(said.message);
}

/**
 * The kit's own words for a limit, and the time it lifts.
 *
 * Its literal, over the 234 real lines above: `You've hit your session limit ·
 * resets 4:40pm (Asia/Karachi)` — weekly in place of session on the long ones,
 * a date in front of the time when the wait needs one (`resets Aug 23, 1pm`),
 * and ` · progress saved` after it when the turn was kept.
 *
 * Only the reset survives into the detail. Which limit was hit does not change
 * what the reader does about it, and the time is the whole of what they want.
 * The zone in brackets is dropped: the kit prints this machine's own, and the
 * app is read on this machine.
 *
 * Every other thing the kit files as an API error is deliberately left to the
 * timers — a server overloaded, a connection lost mid-answer, credits run out,
 * a login gone stale (all four are on this disk). Not one of them names a
 * moment when anything resumes, and drawing Retrying over them would promise
 * a retry that is never coming.
 */
const A_LIMIT_LIFTING = /\blimit\b[^·]*·\s*(resets\b[^·(]+)/i;

/**
 * Everything a stored line said in words.
 *
 * The kit's own notices are text blocks like any other, and one of them is
 * written in several — so the blocks are joined rather than the first one taken.
 */
function wordsOn(message: unknown): string {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const words: string[] = [];
  for (const block of content) {
    const part = block as { type?: string; text?: unknown } | null;
    if (part?.type === 'text' && typeof part.text === 'string') words.push(part.text);
  }
  return words.join(' ');
}

function heldByALimit(message: unknown): TailState | null {
  const lifting = A_LIMIT_LIFTING.exec(wordsOn(message));
  if (!lifting) return null;
  return { doing: 'retrying', detail: lifting[1]!.trim() };
}

/** The kit's name for sending a helper off, and the name it used before. */
const A_HELPER_CALL: ReadonlySet<string> = new Set(['Agent', 'Task']);

/** How much of a brief fits beside a word, before it is cut short. */
const BRIEF_ROOM = 48;

/**
 * The helpers a line sent off and is still waiting on.
 *
 * A record is written by appending, so a dispatch standing at the END of one is
 * a dispatch nothing has answered yet: the chat is blocked on somebody else's
 * work. Both names are accepted — `Agent` is the call now, `Task` was the call
 * before, and records written by the older kit are still on the disk.
 *
 * One helper names itself: the brief its sender wrote is on the call, and it
 * says vastly more than the number 1. Several are a count, because eight briefs
 * do not fit beside a word.
 */
function helpersAskedFor(message: unknown): TailState | null {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return null;
  const sent: { description?: unknown; subagent_type?: unknown }[] = [];
  for (const block of content) {
    const part = block as { type?: string; name?: unknown; input?: unknown } | null;
    if (part?.type !== 'tool_use') continue;
    if (typeof part.name !== 'string' || !A_HELPER_CALL.has(part.name)) continue;
    sent.push((part.input ?? {}) as { description?: unknown; subagent_type?: unknown });
  }
  if (sent.length === 0) return null;
  return { doing: 'helping', detail: sent.length === 1 ? oneBrief(sent[0]!) : helperCount(sent.length) };
}

/** What one helper was sent to do, in as much of the sender's own words as fits. */
function oneBrief(input: { description?: unknown; subagent_type?: unknown }): string {
  const said = typeof input.description === 'string' ? input.description.trim().split('\n')[0]!.trim() : '';
  if (said) return said.length > BRIEF_ROOM ? cutShort(said) : said;
  // No brief on the call: the kind of helper is the next most useful thing, and
  // the count is what is left when the call says neither.
  const kind = typeof input.subagent_type === 'string' ? input.subagent_type.trim() : '';
  return kind || helperCount(1);
}

/**
 * A brief too long for the room, cut back to a whole word.
 *
 * Cut on the character alone it reads as broken rather than shortened — "holds
 * at the e…" — so the last part-word goes with it, unless dropping it would
 * throw away most of what there was room for.
 */
function cutShort(said: string): string {
  const room = said.slice(0, BRIEF_ROOM - 1);
  const lastGap = room.lastIndexOf(' ');
  return `${(lastGap > BRIEF_ROOM / 2 ? room.slice(0, lastGap) : room).trimEnd()}…`;
}

/** The count, said the way a reader says it. */
export function helperCount(out: number): string {
  return out === 1 ? '1 helper' : `${out} helpers`;
}

/**
 * Who has the chat, in words, one per kind of holder — and the only place they
 * are written.
 *
 * Two screens say this: the badge's tooltip on a row, and the line standing
 * where a held chat's writing box would be. They were typed out separately, so
 * a wording change had to be made twice and could drift apart between two
 * things the reader sees within a second of each other (bw-96is.13).
 *
 * Who has it, never what they are doing. The mark beside it is the only thing
 * that speaks for that, and a sentence claiming somebody was working
 * contradicted an "Idle" mark an inch away (bw-96is.9).
 *
 * No full stop: the callers punctuate, because one of them continues the
 * sentence.
 */
export const HOLDER_WORD: Record<Holder, string> = {
  terminal: 'Somebody has this chat open in a terminal',
  program: 'Another program has this chat open',
};

/**
 * The line drawn where a held chat's writing box would be.
 *
 * Here rather than in the component because it has to agree with the mark
 * beside it, and the mark is read here. It said "Somebody is working in this
 * chat" whatever the holder was doing, so a chat whose terminal had gone quiet
 * drew Idle and a line claiming somebody was working in it, a foot apart
 * (bw-96is.9). What is always true is that they have it open; the working half
 * is added only when the mark says so.
 *
 * "Let go", not "stop": the box comes back when the holder releases the
 * conversation, and a terminal that has merely stopped working still holds it.
 */
export function heldLine(state: ChatState): string {
  const open = HOLDER_WORD[state.external?.holder ?? 'program'];
  const now = state.working ? ', and is working in it now' : '';
  return `${open}${now}. It draws here as it goes; the writing box comes back when they let go of it.`;
}
