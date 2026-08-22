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
import type { SessionState } from '@/workbench/protocol';

/** Which kind of program is holding a conversation of somebody else's. */
export type Holder = 'terminal' | 'program';

/** What a held conversation is doing, as far as the machine can tell. */
export type HeldDoing = 'working' | 'idle' | 'unknown';

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
  /** When it started doing that, ms since the epoch, or null when unknown. */
  since: number | null;
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
  return held ? { ...held, doing: 'unknown', since: null } : null;
}

/**
 * Which mark stands beside the word.
 *
 * A chat that is doing something and one waiting on the reader each had one;
 * every other standing had a bare word, on a line where every neighbour is a
 * chip with a mark of its own (bw-ja9l.12). The kind is decided here, with the
 * word, because it is the same reading — the chip only knows how to draw it.
 */
export type StateMark = 'working' | 'waiting' | 'ready' | 'asleep' | 'stopped' | 'failed' | 'ended';

/** The three facts, as every screen draws them. */
export interface ChatState {
  /** Draw the moving mark: something is happening and the screen must not look still. */
  working: boolean;
  /** It is not working because it is waiting on the reader — a different mark. */
  waiting: boolean;
  /** Its own verb while working, where it stands otherwise, empty when unknown. */
  word: string;
  /** Which mark goes beside that word. */
  mark: StateMark;
  /** Where the seconds count from, ms since the epoch, or null for no count. */
  since: number | null;
  /** Set only when another program holds it. */
  external: { holder: Holder } | null;
}

/**
 * What each of our own states is, when the driver sent no word of its own.
 *
 * The driver names every state it publishes, so this is a floor rather than the
 * usual answer: a chat whose label came from a log line written by a process
 * that has since died would otherwise draw that dead process's last word.
 */
const OWN_WORD: Record<SessionState, string> = {
  starting: 'Coming back',
  idle: 'Ready',
  thinking: 'Thinking',
  streaming: 'Answering',
  running_tool: 'Working',
  waiting_permission: 'Waiting for you',
  stopped: 'Stopped',
  errored: 'Failed',
  ended: 'Ended',
  dormant: 'Asleep',
};

/** Which mark each of our own states wears, per {@link StateMark}. */
const OWN_MARK: Record<SessionState, StateMark> = {
  starting: 'working',
  idle: 'ready',
  thinking: 'working',
  streaming: 'working',
  running_tool: 'working',
  waiting_permission: 'waiting',
  stopped: 'stopped',
  errored: 'failed',
  ended: 'ended',
  dormant: 'asleep',
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

/** What the reader is told a held chat is doing, per {@link HeldDoing}. */
const HELD_WORD: Record<HeldDoing, string> = {
  working: 'Working',
  idle: 'Idle',
  unknown: '',
};

export interface ChatStateInput {
  /** The state our own driver last published for this chat. */
  state: SessionState;
  /** The word it published with it, if any. */
  label?: string | null;
  /** When that state began, ms since the epoch, for the seconds count. */
  since?: number | null;
  /** What the sidecar says about the program holding it, when one does. */
  held?: HeldChat | null;
}

/**
 * The one reading. Every screen draws this and nothing else.
 *
 * A held chat is read from what the holder says about itself, not from our own
 * last state: our state for such a chat is `dormant` — no agent of ours is
 * attached — and drawing "Asleep" over a terminal in the middle of a turn is
 * the exact lie this replaces. The reverse holds too: a chat of ours that is
 * answering is never held, because {@link heldElsewhere} only calls a chat held
 * while our own side of it is asleep.
 */
export function chatState(input: ChatStateInput): ChatState {
  const held = input.held ?? null;
  if (held) {
    return {
      working: held.doing === 'working',
      waiting: false,
      word: HELD_WORD[held.doing],
      // A held chat that is not working is standing there, which is what "Idle"
      // says; the badge beside it is who is holding it.
      mark: held.doing === 'working' ? 'working' : 'ready',
      since: held.doing === 'working' ? held.since : null,
      external: { holder: held.holder },
    };
  }

  const word = input.label && input.label.length > 0 ? input.label : OWN_WORD[input.state];
  const working = OWN_WORKING.has(input.state);
  return {
    working,
    waiting: input.state === 'waiting_permission',
    word: word ?? '',
    // Off the state and never off the word: the driver names its own states, so
    // the word can be anything it likes while the standing behind it is one of
    // ten we know (bw-ja9l.12).
    mark: OWN_MARK[input.state],
    since: working || input.state === 'waiting_permission' ? (input.since ?? null) : null,
    external: null,
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
 * `burstAt` is when this chat was first seen working in the current burst, kept
 * by the caller across beats, so the seconds counted are the turn's and not the
 * beat's.
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
  burstAt: number | null;
  now: number;
}): { doing: HeldDoing; since: number | null } {
  if (args.status === 'busy') return { doing: 'working', since: args.statusAt };
  if (args.status === 'idle') return { doing: 'idle', since: null };
  // A turn in flight, whether or not anything has been written this minute.
  if (args.owed === true) {
    return { doing: 'working', since: args.burstAt ?? args.recordMovedAt ?? args.now };
  }
  if (args.recordMovedAt === null) return { doing: 'unknown', since: null };
  const moving = args.now - args.recordMovedAt < RECORD_QUIET_MS;
  if (!moving) return { doing: 'idle', since: null };
  return { doing: 'working', since: args.burstAt ?? args.recordMovedAt };
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
