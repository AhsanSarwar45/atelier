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
    | { type: 'session.ended'; reason: string }
    | { type: 'message.started'; messageId: string; role: 'user' | 'assistant' }
    | { type: 'text.delta'; messageId: string; text: string }
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
    | { type: 'diff'; toolCallId: string; path: string; before: string; after: string }
    | { type: 'todo'; items: TodoItem[] }
    | { type: 'image'; messageId: string; image: ImagePayload }
    | { type: 'ask.permission'; askId: string; toolName: string; input: Record<string, unknown>; title: string; options: AskOption[] }
    | { type: 'ask.resolved'; askId: string; chosen: string }
    | { type: 'cost'; cost: Cost }
    | { type: 'link.bead'; beadId: string; via: 'tool' | 'brief' | 'manual' }
    | { type: 'report.available'; project: string; slug: string }
    | { type: 'error'; message: string; fatal: boolean }
    /** A line the app says about the chat itself, not the agent's own words. */
    | { type: 'notice'; text: string }
  );

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
}

/**
 * What an open chat says about itself beyond what it is saying right now
 * (`GET /api/workbench/session/<id>`): which cards it has worked on, and where
 * it is working. The cards come from the board, which is the record of who
 * touched what, so a chat begun in a terminal carries them too.
 */
export interface SessionFacts {
  sessionId: string;
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
