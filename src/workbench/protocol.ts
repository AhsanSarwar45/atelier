/**
 * WBP — the workbench protocol.
 *
 * The one vocabulary every agent brand is translated into. Drivers emit these
 * events and accept these commands; nothing brand-specific crosses the seam,
 * which is what makes a third brand one new driver file.
 *
 * Design and the full intended vocabulary: docs/agent-workbench.md §2.
 * This file carries the part that is built. Events for diffs, todos,
 * subagents and images arrive with their work items.
 *
 * Imported by the Next.js app as `@/workbench/protocol` and by the sidecar
 * over a relative path, so the two can never drift apart.
 */

/** Brands we can drive. One string per driver. */
import type { HeldChat } from './chat-state';
import type { PlanUsage } from './plan-usage';

export type Brand = 'claude' | 'codex';

/**
 * What a session is doing. The three `waiting_*` values plus `ended` are
 * "blocked on the human" — the waiting-on-you tray is a filter over this and
 * nothing more.
 */
export type SessionState =
  | 'starting'
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'running_tool'
  | 'waiting_permission'
  | 'stopped'
  | 'errored'
  /** Known, not running: nothing wakes it but a click. */
  | 'dormant';

/**
 * Whether no driver of ours is attached to this chat.
 *
 * The one test behind every "somebody else has it" on every screen. Every agent
 * this app drives is itself a Claude Code process and leaves the same trace on
 * the machine a terminal does, so the trace alone cannot tell our own chat from
 * a stranger's — what tells them apart is that a chat we drive is idle between
 * turns and never asleep.
 *
 * The chat's own line has always asked it. The list did not, which is how one
 * chat drew "external" on the list and "Ready" in the bar above it at the same
 * moment (bw-jaoz.2). Here, so neither can ask it differently.
 */
export function asleepHere(state: SessionState): boolean {
  return state === 'dormant';
}

/** A button on a permission card. */
export interface AskOption {
  id: string;
  label: string;
  kind: 'allow_once' | 'allow_always' | 'deny' | 'answer';
}

/**
 * Cost exactly as the brand reports it (design decision 12). Claude reports
 * dollars, Codex reports tokens; the two are never converted into each other
 * and never summed.
 */
export type Cost =
  | { kind: 'usd'; usd: number }
  | { kind: 'tokens'; input: number; output: number; total: number };

/** One line of the agent's live checklist. */
export interface TodoItem {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** A picture, inline. `dataUrl` so it survives in the event log with the turn. */
export interface ImagePayload {
  mime: string;
  dataUrl: string;
  alt: string;
}

/**
 * One entry in the writing box's `/` menu: a command the install has, or a skill
 * it can run. Both are typed the same way, so both are listed the same way
 * (docs/agent-workbench.md §7).
 */
export interface CommandInfo {
  /** Without the leading slash. */
  name: string;
  description: string;
  /** What its argument looks like, in the brand's own words. */
  argumentHint?: string;
  kind: 'command' | 'skill';
}

/** One model this session could be switched to, as the brand names it. */
export interface ModelChoice {
  value: string;
  displayName: string;
  description?: string;
}

/** One provider-supported reasoning budget. Values stay in provider spelling. */
export interface EffortChoice {
  value: string;
  displayName: string;
  description?: string;
}

export interface AgentDefinition {
  name: string;
  description: string;
  source: 'project' | 'user';
}

/** Fields every event carries. `seq` is per-session and monotone. */
interface EventBase {
  seq: number;
  sessionId: string;
  at: string;
}

export type WbpEvent = EventBase &
  (
    | { type: 'session.started'; brand: Brand; externalId: string | null; model: string | null; cwd: string; permissionMode: string; effort?: string | null }
    | { type: 'session.state'; state: SessionState; label: string }
    /**
     * Everything this session can offer: the commands and skills the install
     * has, the models it could switch to, the permission modes it accepts, and
     * which of the steering controls its brand has for the work it sends away.
     * Sent when the session announces itself, and again whenever the brand
     * pushes a new list (docs/agent-workbench.md §7).
     */
    | {
        type: 'session.menu';
        commands: CommandInfo[];
        skills: string[];
        models: ModelChoice[];
        permissionModes: string[];
        efforts?: EffortChoice[];
        agentDefinitions?: AgentDefinition[];
        /**
         * Which of the three steering controls this session's brand actually
         * has (docs/agent-workbench.md §8.2.7). A control that is not named
         * here is not drawn: a button that cannot do the thing written on it
         * is worse than no button (decision 13).
         *
         * Per session rather than per install, because it is a brand's answer
         * and a chat is of one brand. A chat nobody is driving names none of
         * them, which is the truth — there is nothing there to steer with.
         */
        agentControls: AgentControl[];
      }
    /**
     * What the session is set to now — after the owner changed one of them from
     * the picker, or after the tool changed one by itself (approving a plan
     * ends plan mode). A field that is `null` is one this message says nothing
     * about, and the reader keeps what it had (bw-1u1.43).
     */
    | { type: 'session.pinned'; permissionMode: string | null; model: string | null; effort?: string | null }
    | { type: 'session.ended'; reason: string }
    /**
     * `parentToolCallId` is set when a SENT-OFF agent said this, and names the
     * call that sent it — the same attribution `tool.started` carries, so a
     * helper's words draw under the call they belong to instead of in the middle
     * of its owner's answer (bw-7ks.22.2).
     *
     * Written only when there is a parent to name, which is why it is optional
     * rather than nullable: almost every message in a log is the main agent's,
     * and a field on every one of them is paid a million times over.
     */
    | { type: 'message.started'; messageId: string; role: 'user' | 'assistant'; parentToolCallId?: string }
    | { type: 'text.delta'; messageId: string; text: string }
    /**
     * The agent's own reasoning, word by word. Drawn dim, and collapsed once it
     * answers. A thinking block has no `message.started` of its own — the first
     * delta creates it — so the attribution rides here, on the same terms.
     */
    | { type: 'thinking.delta'; messageId: string; text: string; parentToolCallId?: string }
    /**
     * How much thinking has been done, when the thinking itself is withheld.
     * The API sends only pings during redacted thinking, and this is the brand's
     * own estimate — approximate, and the only sign of life there is.
     */
    | { type: 'thinking.progress'; tokens: number }
    | { type: 'message.completed'; messageId: string }
    | {
        type: 'tool.started';
        toolCallId: string;
        name: string;
        input: Record<string, unknown>;
        title: string;
        /** Set when the call was made by a subagent; the id of the call that spawned it. */
        parentToolCallId: string | null;
      }
    | { type: 'tool.completed'; toolCallId: string; ok: boolean; output: string }
    /**
     * How long this call has been running, as the brand counts it, and — when the call sent an agent
     * away — what that agent is doing now, in its own words. The brand asks the
     * helper's own conversation for a short present-tense line every half
     * minute; it belongs on the row that sent it, not as another line in the
     * transcript (bw-7ks.22.2).
     */
    | { type: 'tool.progress'; toolCallId: string; seconds: number; summary?: string }
    /**
     * A piece of work the chat handed to something else, from the moment it is
     * sent (docs/agent-workbench.md §8.2.7). One row in the panel, whatever the
     * kind: a helper agent, a command left running, a watch, a scripted run are
     * all work the chat is waiting on, and the kind is a mark on the row rather
     * than a different list.
     *
     * `toolCallId` names the call that sent it where there was one — a helper
     * agent is a Task call and its row opens onto the same conversation the
     * transcript nests under that call. A command left running in the
     * background was never a call of its own, so it carries none.
     *
     * `model` is what the sender knew at the time, which for a helper is
     * usually nothing: the model it actually ran arrives with its first words
     * (their `message.model`) or with its result, and `agent.progress` carries
     * it up when it does.
     */
    | {
        type: 'agent.started';
        agentId: string;
        toolCallId: string | null;
        kind: AgentKind;
        /** The brief, in the sender's own words. One line. */
        what: string;
        /** Which kind of helper the kit was asked for, when it says. */
        agentType: string | null;
        model: string | null;
      }
    /**
     * The numbers on a row, refreshed while it runs. Every field is what the
     * kit last said, not a delta: a reader that missed one is not wrong after
     * the next.
     *
     * `doing` is the helper's own present-tense line, asked of its own
     * conversation about twice a minute (bw-7ks.22.2). Left out rather than
     * sent empty, on the same terms as `tool.progress`: an absent line means
     * "still whatever it last said".
     */
    | {
        type: 'agent.progress';
        agentId: string;
        seconds: number;
        tokens: number;
        /** How many calls it has made of its own. */
        calls: number;
        doing?: string;
        model?: string;
        /** Set when the kit says this row is now running elsewhere, or is now in the background. */
        state?: AgentState;
      }
    /**
     * It answered, gave up, or was stopped. `result` is its last word — kept on
     * the row, because a finished row that throws its answer away is a row the
     * reader has to go and find the answer for.
     */
    | {
        type: 'agent.finished';
        agentId: string;
        state: 'done' | 'failed' | 'stopped';
        seconds: number;
        tokens: number;
        calls: number;
        model: string | null;
        result: string | null;
      }
    /**
     * A word the owner typed for a running agent, and where it actually went.
     *
     * Neither brand offers a private channel into a helper that is already
     * running, so this event says what happened rather than what one would
     * wish had: the message went to the chat that sent the helper, naming which
     * helper it was for (docs/agent-workbench.md §8.2.7). Kept on the row,
     * because a reader who typed it needs to see both that it was said and how
     * it was said — a word drawn as delivered would be a lie about the road it
     * took.
     */
    | { type: 'agent.relayed'; agentId: string; text: string }
    | { type: 'agent.identified'; agentId: string; agentType: string }
    | { type: 'diff'; toolCallId: string; path: string; before: string; after: string }
    | { type: 'todo'; items: TodoItem[] }
    | { type: 'image'; messageId: string; image: ImagePayload }
    /**
     * A tool is asking to run. `parentToolCallId` is set when a SENT-OFF agent
     * raised the question, and names the call that sent that agent — the same
     * attribution every other line carries, so the question draws on the
     * helper's own row and inside its own conversation instead of in the middle
     * of its owner's (docs/agent-workbench.md §8.2.7).
     *
     * Optional on the same terms as `message.started`: almost every question in
     * a chat is the main agent's own, and a field on every one of them is paid
     * a million times over.
     */
    | {
        type: 'ask.permission';
        askId: string;
        toolName: string;
        input: Record<string, unknown>;
        title: string;
        options: AskOption[];
        question?: boolean;
        allowText?: boolean;
        secret?: boolean;
        href?: string;
        parentToolCallId?: string;
      }
    | { type: 'ask.resolved'; askId: string; chosen: string }
    | { type: 'cost'; cost: Cost }
    /**
     * How full the conversation is: the tokens the model was last sent, against
     * the window it has. A reader watching an agent work has no other way to
     * know it is about to be compacted, and being compacted mid-job is the one
     * thing that loses a session's own memory of what it was doing (bw-4wcd.4).
     */
    | { type: 'context'; used: number; window: number }
    | { type: 'link.bead'; beadId: string; via: 'tool' | 'brief' | 'manual' }
    | { type: 'report.available'; project: string; slug: string }
    | { type: 'error'; message: string; fatal: boolean }
    /**
     * A line the app says about the chat itself, not the agent's own words.
     *
     * It carries the family it is drawn as, because the app's own asides are
     * the one kind of machine line whose meaning is not written anywhere else:
     * a note has the driver's name for it to sort on, and an aside has only its
     * sentence. One written before there were families is drawn as the app
     * speaking, which is what it is (bw-jkh2.5).
     */
    | { type: 'notice'; text: string; family?: MachineFamily; audience?: Audience }
    /**
     * Anything the machine says about ITSELF — compaction, a retry, a refusal,
     * a hook that failed, a mode that changed — and everything the driver had no
     * name for. Nothing the brand sends is dropped: a kind with no translation
     * arrives here rather than nowhere, which is what lost the manager's
     * `/compact` answer (docs/agent-workbench.md §8.2.4).
     *
     * `rank` decides the drawing and nothing else: `note` is a grey line always
     * on the page, `detail` is hidden until the reader asks for everything. Both
     * are stored, because the log IS the transcript (§4).
     */
    | {
        type: 'note';
        noteId: string;
        rank: NoteRank;
        kind: string;
        text: string;
        body: string | null;
        /**
         * Who this exact line is for, when the STATE decided it.
         *
         * `rank` cannot carry the answer: it has two values, and an allowance
         * filling up and an allowance that has stopped his work are two states
         * of one kind that must land on different sides. The driver has the
         * state and settles it there; a note without this is one whose whole
         * kind has a single reader, and `machine-lines.ts` says which
         * (bw-iiv6, docs/agent-workbench.md §8.2.4).
         */
        audience?: Audience;
      }
    /**
     * Drop everything drawn so far; what follows replaces it.
     *
     * Sent once, when a chat's past is read again under a newer reading of the
     * record. A browser already showing the old copy would otherwise draw the
     * replacement underneath it and say everything twice (bw-1u1.27). Written to
     * the log like every other event, so a later replay from seq 0 meets it
     * first, with nothing to drop, and folds to the same transcript.
     */
    | { type: 'transcript.reset' }
  );

/**
 * What kind of thing the chat sent away (docs/agent-workbench.md §8.2.7).
 *
 * The kit's own list of background work names four, and all four are work the
 * chat is waiting on: `helper` is an agent given a brief, `command` is a shell
 * command left running, `watch` is something reporting back on a change, `run`
 * is a script that drives agents of its own. Anything the kit invents later is
 * drawn as `helper`, which is what most of them are.
 */
export type AgentKind = 'helper' | 'command' | 'watch' | 'run';

/**
 * Where a piece of sent-off work has got to.
 *
 * `waiting` is waiting on the reader — a helper that raised a permission ask —
 * and is the reason this is not a boolean: a row nobody is going to answer is
 * not a row that is working.
 */
export type AgentState = 'running' | 'waiting' | 'parked' | 'done' | 'failed' | 'stopped';

/**
 * The states a row never leaves: the work is over, however it went.
 *
 * Said once, here beside the states themselves, because three places have to
 * agree about it — the panel, which stops counting and starts keeping; and both
 * ways the conversation is folded, which refuse to let anything arriving
 * afterwards reopen a row that is over (bw-7ks.22.30).
 */
export const OVER: readonly AgentState[] = ['done', 'failed', 'stopped'];

/** Whether this row is over: it says what it ended with, and nothing moves it. */
export function isOver(state: AgentState): boolean {
  return OVER.includes(state);
}

/**
 * A way of steering one running piece of sent-off work
 * (docs/agent-workbench.md §8.2.7).
 *
 * `stop` and `park` are the brand's own controls and are exact: one ends that
 * agent alone, the other sends it to the background and hands the turn back —
 * drawn as Background, since nobody reading the row calls it parking. `say` is
 * a relay and nothing more — the typed words go to the chat that sent the agent,
 * naming which agent they are for, because that is the only road either brand
 * offers into one that is already running.
 */
export type AgentControl = 'stop' | 'park' | 'say';

/** How loudly a `note` is drawn. See the rank table in §8.2.4. */
export type NoteRank = 'note' | 'detail';

/**
 * Which of the six families a machine line is drawn as — its colour and its
 * mark. What lands in each is `src/workbench/machine-lines.ts`; the name is
 * here because the wire carries it (docs/agent-workbench.md §8.2.4).
 */
export type MachineFamily = 'stopped' | 'failed' | 'waiting' | 'memory' | 'background' | 'breathing';

/**
 * Who a machine line is for.
 *
 * The families answer how bad a line is, and that is a different question from
 * whether the reader has anything to do about it: an allowance window opening
 * is news of a sort, and it is the machine's own news. Sorting by loudness
 * alone put most of what a chat drew by default on the reader's screen for no
 * reason he could act on — the count and the run behind it are in
 * docs/agent-workbench.md §8.2.4, written down once (bw-6jq5).
 *
 * `you` is a line he would act on, chase, or has just caused. `machine` is the
 * chat keeping its own books. Which one a kind is, is
 * `src/workbench/machine-lines.ts`; the name is here because the wire carries
 * it on the app's own asides.
 */
export type Audience = 'you' | 'machine';

export type WbpEventType = WbpEvent['type'];

/** Commands the browser POSTs to /api/workbench/command. */
/**
 * A card handed to a chat at birth. The link is recorded before the agent has
 * done anything, because the owner starting a chat *from* a card is itself the
 * statement that the two belong together — it is not waiting to be inferred
 * from a tool call (docs/agent-workbench.md §8.3).
 */
export interface Brief {
  beadId: string;
  /** The opening prompt: the card's title, its body and what "done" means. */
  text: string;
}

export type WbpCommand =
  | {
      type: 'session.start';
      projectId: string;
      projectPath: string;
      brand: Brand;
      model?: string;
      permissionMode?: string;
      effort?: string;
      brief?: Brief;
    }
  | { type: 'prompt.send'; sessionId: string; text: string; images?: ImagePayload[]; takeover?: boolean }
  | { type: 'ask.answer'; sessionId: string; askId: string; optionId: string; value?: string }
  | { type: 'session.stop'; sessionId: string }
  /**
   * End the chat itself: the agent is torn down and the row is marked `ended`.
   *
   * Nothing is deleted. The conversation stays in the list, stays readable, and
   * opens again on a click like any sleeping chat (the manager, 2026-08-25).
   * `session.stop` above is the other thing entirely — it cuts the answer in
   * flight and leaves the agent standing.
   */
  | { type: 'session.close'; sessionId: string }
  /**
   * Steering ONE piece of sent-off work, never the chat it belongs to
   * (docs/agent-workbench.md §8.2.7). `agentId` is the row's own id.
   *
   * `agent.say` is a relay: the sidecar sends the chat a turn naming which
   * agent the words are for, and records on the row that this is what it did.
   */
  | { type: 'agent.stop'; sessionId: string; agentId: string }
  | { type: 'agent.park'; sessionId: string; agentId: string }
  | { type: 'agent.say'; sessionId: string; agentId: string; text: string }
  /** Both act on the session that is open, not on the next one (§8.2.3). */
  | { type: 'session.mode'; sessionId: string; mode: string }
  | { type: 'session.model'; sessionId: string; model: string }
  | { type: 'session.effort'; sessionId: string; effort: string }
  | {
      /**
       * Open a chat for reading: give a conversation begun elsewhere an id, read
       * its past into the log, and start NOTHING. The agent is woken by the
       * first message sent to it (docs/designs/app-shell.md §1.9).
       */
      type: 'session.open';
      /** Ours when the app ran it; otherwise the brand's own id. */
      sessionId?: string;
      externalId?: string;
      brand: Brand;
      projectId: string;
      projectPath: string;
      title?: string | null;
      cwd?: string | null;
      lastActiveAt?: string;
    }
  | {
      type: 'session.resume';
      /** Ours when the app ran it; otherwise the brand's own id. */
      sessionId?: string;
      externalId?: string;
      brand: Brand;
      projectId: string;
      projectPath: string;
    };

/**
 * One offer in the restore list. `sessionId` is null for a chat this app never
 * ran — a session begun elsewhere, listed by the brand's own session index.
 */
export interface RestoreRow {
  sessionId: string | null;
  externalId: string | null;
  brand: Brand;
  /** What the conversation is called, in the brand's own words. */
  title: string | null;
  lastActiveAt: string;
  /**
   * When the PERSON last said something here, which is a different question
   * from when anything last happened.
   *
   * `lastActiveAt` moves for everything an agent does — a reply, a line of
   * thinking, a question about a tool — so rows shuffle under the manager's
   * cursor while three agents write, and the chat he is actually talking in
   * slides away from him (bw-zhs9). This one moves only when he speaks.
   *
   * When nothing can say — a chat he has never typed into, or one whose record
   * holds nothing of his within reach of its end — the sidecar puts
   * `lastActiveAt` here, so a row is always orderable and the ones nothing is
   * known about behave exactly as the list behaves today. Absent altogether on
   * a row the browser built for itself out of the live stream.
   */
  lastSpokeAt?: string | null;
  state: SessionState;
  origin: 'app' | 'terminal';
  projectId: string | null;
  cwdHint: string | null;
  /** The directory it ran in, by its own name — a worktree's is the worktree. */
  folder: string | null;
  branch: string | null;
  /** Cards this chat is known to have worked on. */
  beads: string[];
  /**
   * A live Claude Code process is holding this conversation right now —
   * somebody is working in it, in a terminal or under another host.
   *
   * Separate from `state` on purpose. `state` is what this app's own driver
   * knows and it is what the click on a row acts on (§6.3.3); a chat running
   * in a terminal has no driver of ours attached and is `dormant` in every
   * sense this app can act on, while being the least asleep thing in the list.
   * Overloading `state` with it would arm the wake-on-click path against a
   * process that is already awake.
   *
   * Answered by the sidecar, which reads the tool's own per-process marker
   * files and the process table (workbench/src/running.ts, bw-dmxj.3). Absent
   * on a row the browser built for itself out of the live stream: those are
   * sessions this app is driving, which it already knows everything about.
   */
  runningElsewhere?: boolean;
  /**
   * What that program says it is doing, when one holds it: the row draws the
   * same moving mark as a chat of our own, in the same place, rather than a
   * word that means only "occupied" (bw-96is). Absent for the same reasons
   * `runningElsewhere` is.
   */
  held?: HeldChat | null;
  /**
   * Our own driver's word for what this chat is doing, and when it started —
   * the two halves of the mark the chat's own bar draws.
   *
   * On the row for the same reason the holder's are: the list draws the one
   * reading (chat-state.ts) and it cannot draw it from half the facts. Without
   * these a chat of ours read "Thinking" with no clock on the list and
   * "Pulling the branch apart 2m 14s" in the bar above it, which is two screens
   * disagreeing about a chat the reader is looking at in one glance
   * (bw-96is.31). Absent for the same reasons `runningElsewhere` is — and
   * absent too on a row nothing of ours is attached to, which is what a held
   * chat is.
   */
  activity?: string | null;
  /** When that began, ISO, for the count beside the word. */
  busySince?: string | null;
}

/**
 * What an open chat says about itself beyond what it is saying right now
 * (`GET /api/workbench/session/<id>`): which cards it has worked on, and where
 * it is working. The cards come from the board, which is the record of who
 * touched what, so a chat begun in a terminal carries them too.
 */
export interface SessionFacts {
  sessionId: string;
  /** Where the conversation was originally created; immutable across resumes. */
  origin: 'app' | 'terminal';
  /** The immutable coding-agent implementation that owns this conversation. */
  brand: Brand;
  /**
   * The brand's own id for this conversation, which is what says whether the
   * chat on the screen is one of the ones a live process is holding — the
   * running set is named in the brand's ids, not ours (bw-dmxj.6).
   */
  externalId: string | null;
  /**
   * Whether a live process was holding this conversation when the chat was
   * opened.
   *
   * The same truth arrives on the app-wide stream, but a beat later, and the
   * writing box has to refuse from the first frame it draws: a message sent in
   * that gap wakes a SECOND agent on the conversation, which is the whole thing
   * the box is there to prevent (bw-dmxj.8). The stream then keeps it current —
   * this says only what was true at open.
   */
  runningElsewhere: boolean;
  /**
   * What the program holding it says it is doing, when one is — the same
   * reading the app-wide stream carries, said here so a chat opened by its own
   * address draws a moving mark from its first frame instead of a beat later
   * (bw-96is).
   */
  held: HeldChat | null;
  title: string | null;
  cwd: string | null;
  folder: string | null;
  branch: string | null;
  beads: string[];
}

/**
 * One frame of the app-wide stream (`GET /api/workbench/watch`).
 *
 * A snapshot first, so a browser that connects in the middle of the day knows
 * every session's state without replaying its whole transcript, then the events
 * themselves. One envelope rather than named SSE events, so a reader needs one
 * handler (docs/agent-workbench.md §8.6).
 */
export type WatchFrame =
  | { kind: 'snapshot'; sessions: (SessionSummary & { activity: string; beads: string[] })[] }
  /** A chat that has just come into existence, before it has said anything. */
  | { kind: 'opened'; session: SessionSummary & { activity: string; beads: string[] } }
  /**
   * Every conversation a live process is holding right now, by the tool's own
   * id for it, each with what that process says it is doing — sent once when
   * the stream opens and again whenever the set or what any of them is doing
   * changes. Unlike the other frames this is not about sessions this app
   * drives: a chat being typed at in a terminal has no row in our store to
   * carry an event, and it is exactly the chat the reader is looking for
   * (bw-dmxj.5). The whole set each time, because it is small — one entry per
   * running chat on the machine — and a set is unambiguous where a
   * started/stopped pair after a missed frame is not.
   */
  | { kind: 'running'; holds: HeldChat[] }
  /**
   * The tools' own session folders have changed — a conversation written that
   * this app did not write, or one of them added to. A bare word, said no more
   * than once a second however hard an agent is typing: it means ask for the
   * list again, and it carries no rows, because `restoreList` is the one place
   * that builds them (workbench/src/outside.ts, bw-uivp.1).
   *
   * `folders` names the working directories the writing happened in, so a
   * screen showing one project can tell a word about its own work from one
   * about somebody else's — this machine runs agents in many projects at once
   * and the unscoped word cost every open list a full rebuild four times in
   * twelve idle seconds. Empty, or absent, means the sidecar could not place
   * the writing: then the word is for everyone, because an extra fetch is the
   * cheaper mistake (bw-uivp.4).
   */
  | { kind: 'outside'; folders?: string[] }
  /**
   * What the ACCOUNT has spent of its plan — the five-hour window, the week,
   * and what is behind them.
   *
   * On this stream rather than in a poll of the screen's own, because the
   * figure belongs to nobody's chat: the sidecar reads it on a beat of its own
   * and says it to every page at the same moment, so a chat sitting silent
   * shows the same number as the one being worked in (plan-usage.ts, bw-dmoe).
   */
  | { kind: 'usage'; brand?: Brand; usage: PlanUsage }
  | { kind: 'event'; event: WbpEvent };

/** A chat that touched a card, as the card's own side of the join lists it. */
export interface LinkedChat {
  sessionId: string;
  title: string | null;
  brand: Brand | null;
  lastActiveAt: string | null;
  projectId: string | null;
}

/** A row in the chat sidebar / restore list. */
export interface SessionSummary {
  id: string;
  brand: Brand;
  externalId: string | null;
  projectId: string;
  projectPath: string;
  cwd: string;
  model: string | null;
  permissionMode: string;
  effort?: string | null;
  title: string | null;
  state: SessionState;
  createdAt: string;
  lastActiveAt: string;
  /**
   * When the person last sent a message into this chat, as the sidecar's own
   * store recorded it. Absent for a chat he has never sent into from here —
   * one begun in a terminal, or one only ever read (bw-zhs9).
   */
  lastSpokeAt?: string | null;
}

/**
 * Claude's permission modes, as the SDK spells them.
 *
 * `default` is the mode that asks about every tool — measured, not assumed:
 * a probe run under it saw canUseTool fire for both Read and Edit. Note the
 * CLI's `--permission-mode` flag spells this same mode `manual`; the SDK name
 * is what this code uses.
 */
export const CLAUDE_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'auto',
  'bypassPermissions',
] as const;

/**
 * The mode a chat opens in when NOTHING says otherwise.
 *
 * Last, not first: what a chat opens in is what the owner's own settings say
 * (workbench/src/owner-settings.ts, bw-7ks.23), and this is the answer only
 * where they say nothing at all. It used to be handed to the kit on every
 * start, which is why a machine set to skip every permission check still opened
 * every chat asking about every tool (bw-b1o1).
 */
export const DEFAULT_PERMISSION_MODE = 'default';

/**
 * The model picker's own top row: not a model, but "whatever the brand would
 * have picked". The kit's model list carries it, the header shows it for a chat
 * nobody has pinned a model to, and choosing it takes the model key out of the
 * owner's settings rather than writing this word into them.
 */
export const BRAND_DEFAULT_MODEL = 'default';

/**
 * The folder a chat ran in, as a chip: the directory's own name, which for a
 * separate copy of a project is that copy's name and otherwise the project's.
 * Both sides read it — the sidecar when it builds a row, the screen when it
 * builds one for a chat that has only just started.
 */
export function folderOf(cwd: string | null): string | null {
  if (!cwd) return null;
  const name = cwd.replace(/\/+$/, '').split('/').pop();
  return name ? name : null;
}

/**
 * The later of two times a chat was last active, as an ISO string.
 *
 * A chat this app has driven carries two dates: the one our own log wrote, and
 * the one the tool's session index carries for the same conversation. They part
 * company the moment somebody works in that chat somewhere else — the index
 * moves and our log does not — and taking ours alone froze such a chat at the
 * last time the app happened to look at it, which sank it to the bottom of a
 * list ordered by date (bw-dmxj). Both are the same clock, so the later one is
 * simply the truer one.
 */
export function laterOf(mine: string, theirs: string | null | undefined): string {
  if (!theirs) return mine;
  return theirs.localeCompare(mine) > 0 ? theirs : mine;
}

/**
 * The clock the list runs on: when the person himself last spoke in a chat, or
 * failing that when anything last happened in it.
 *
 * Every row has one. A chat he has never typed into, one whose record holds
 * nothing of his within reach, and a row an older sidecar built before the
 * second clock existed all fall back to `lastActiveAt` and behave exactly as
 * the whole list behaved before (bw-zhs9).
 *
 * Read it in all three places the list uses a time — the order, the day over a
 * row, and the time on the row itself — because they must be one clock. Order
 * by one and head by another and a row lands in a day it is not dated for.
 */
export function whenHeSpoke(row: RestoreRow): string {
  return row.lastSpokeAt ?? row.lastActiveAt;
}

/**
 * The later of two answers to "when did he last speak", either of which may be
 * silence.
 *
 * Silence is not a time and must not become one. A row whose clock is unknown
 * falls back to when anything last happened in it, and that fallback moves; if
 * silence were written down here as the moment we happened to ask, the row
 * would freeze at that moment while the chat carried on (bw-zhs9).
 */
export function laterSpoke(ours: string | null | undefined, theirs: string | null | undefined): string | null {
  if (!ours) return theirs ?? null;
  return laterOf(ours, theirs);
}

/**
 * The order of the restore list: chats somebody is working in right now, then
 * everything else, each half by the last time he spoke in it.
 *
 * Date alone is the wrong order for this list. It answers "what happened most
 * recently", and the reader's question is "where is the work" — a chat that has
 * been running for an hour writes no more often than one that was read a minute
 * ago, and the list draws only a screenful, so the running one was not merely
 * lower down, it was not drawn at all.
 *
 * "What happened last" is the wrong clock for the half below, too. Every reply,
 * every line of thinking, every question about a tool moved a row, so three
 * agents at work shuffled the list under the manager's cursor and the chat he
 * was talking in slid away from him mid-sentence. The rows go by when HE last
 * spoke instead: a chat whose agent has been writing for ten minutes sits
 * exactly where it sat before the agent started, and only a message he sends
 * carries a chat to the top (bw-zhs9).
 *
 * Both sides sort: the sidecar when it builds the list, the screen again after
 * the live stream has added to it.
 */
export function byWhatIsWorking(a: RestoreRow, b: RestoreRow): number {
  if (!!a.runningElsewhere !== !!b.runningElsewhere) return a.runningElsewhere ? -1 : 1;
  return whenHeSpoke(b).localeCompare(whenHeSpoke(a));
}
