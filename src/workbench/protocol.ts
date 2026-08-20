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
  | 'ended'
  /** Known, not running: nothing wakes it but a click. */
  | 'dormant';

/** A button on a permission card. */
export interface AskOption {
  id: string;
  label: string;
  kind: 'allow_once' | 'allow_always' | 'deny';
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

/** Fields every event carries. `seq` is per-session and monotone. */
interface EventBase {
  seq: number;
  sessionId: string;
  at: string;
}

export type WbpEvent = EventBase &
  (
    | { type: 'session.started'; brand: Brand; externalId: string | null; model: string | null; cwd: string; permissionMode: string }
    | { type: 'session.state'; state: SessionState; label: string }
    /**
     * Everything the writing box can offer for THIS session: the commands and
     * skills the install has, the models it could switch to, and the permission
     * modes it accepts. Sent when the session announces itself, and again
     * whenever the brand pushes a new list (docs/agent-workbench.md §7).
     */
    | {
        type: 'session.menu';
        commands: CommandInfo[];
        skills: string[];
        models: ModelChoice[];
        permissionModes: string[];
      }
    /**
     * What the session is set to now — after the owner changed one of them from
     * the picker, or after the tool changed one by itself (approving a plan
     * ends plan mode). A field that is `null` is one this message says nothing
     * about, and the reader keeps what it had (bw-1u1.43).
     */
    | { type: 'session.pinned'; permissionMode: string | null; model: string | null }
    | { type: 'session.ended'; reason: string }
    | { type: 'message.started'; messageId: string; role: 'user' | 'assistant' }
    | { type: 'text.delta'; messageId: string; text: string }
    /** The agent's own reasoning, word by word. Drawn dim, and collapsed once it answers. */
    | { type: 'thinking.delta'; messageId: string; text: string }
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
    /** How long this call has been running, as the brand counts it. */
    | { type: 'tool.progress'; toolCallId: string; seconds: number }
    | { type: 'diff'; toolCallId: string; path: string; before: string; after: string }
    | { type: 'todo'; items: TodoItem[] }
    | { type: 'image'; messageId: string; image: ImagePayload }
    | { type: 'ask.permission'; askId: string; toolName: string; input: Record<string, unknown>; title: string; options: AskOption[] }
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
    /** A line the app says about the chat itself, not the agent's own words. */
    | { type: 'notice'; text: string }
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
    | { type: 'note'; noteId: string; rank: NoteRank; kind: string; text: string; body: string | null }
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

/** How loudly a `note` is drawn. See the rank table in §8.2.4. */
export type NoteRank = 'note' | 'detail';

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
      brief?: Brief;
    }
  | { type: 'prompt.send'; sessionId: string; text: string; images?: ImagePayload[] }
  | { type: 'ask.answer'; sessionId: string; askId: string; optionId: string }
  | { type: 'session.stop'; sessionId: string }
  /** Both act on the session that is open, not on the next one (§8.2.3). */
  | { type: 'session.mode'; sessionId: string; mode: string }
  | { type: 'session.model'; sessionId: string; model: string }
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
}

/**
 * What an open chat says about itself beyond what it is saying right now
 * (`GET /api/workbench/session/<id>`): which cards it has worked on, and where
 * it is working. The cards come from the board, which is the record of who
 * touched what, so a chat begun in a terminal carries them too.
 */
export interface SessionFacts {
  sessionId: string;
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
   * id for it — sent once when the stream opens and again whenever the set
   * changes. Unlike the other frames this is not about sessions this app
   * drives: a chat being typed at in a terminal has no row in our store to
   * carry an event, and it is exactly the chat the reader is looking for
   * (bw-dmxj.5). The whole set each time, because it is small — one entry per
   * running chat on the machine — and a set is unambiguous where a
   * started/stopped pair after a missed frame is not.
   */
  | { kind: 'running'; conversations: string[] }
  /**
   * The tools' own session folders have changed — a conversation written that
   * this app did not write, or one of them added to. A bare word, said no more
   * than once a second however hard an agent is typing: it means ask for the
   * list again, and it carries no rows, because `restoreList` is the one place
   * that builds them (workbench/src/outside.ts, bw-uivp.1).
   */
  | { kind: 'outside' }
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
  title: string | null;
  state: SessionState;
  createdAt: string;
  lastActiveAt: string;
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

/** The mode a workbench session is pinned to unless the owner picks another. */
export const DEFAULT_PERMISSION_MODE = 'default';

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
 * The order of the restore list: chats somebody is working in right now, then
 * everything else, each half newest first.
 *
 * Date alone is the wrong order for this list. It answers "what happened most
 * recently", and the reader's question is "where is the work" — a chat that has
 * been running for an hour writes no more often than one that was read a minute
 * ago, and the list draws only a screenful, so the running one was not merely
 * lower down, it was not drawn at all.
 *
 * Both sides sort: the sidecar when it builds the list, the screen again after
 * the live stream has added to it.
 */
export function byWhatIsWorking(a: RestoreRow, b: RestoreRow): number {
  if (!!a.runningElsewhere !== !!b.runningElsewhere) return a.runningElsewhere ? -1 : 1;
  return b.lastActiveAt.localeCompare(a.lastActiveAt);
}
