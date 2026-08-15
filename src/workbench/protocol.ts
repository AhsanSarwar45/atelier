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
  | 'ended';

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
    | { type: 'tool.started'; toolCallId: string; name: string; input: Record<string, unknown>; title: string }
    | { type: 'tool.completed'; toolCallId: string; ok: boolean; output: string }
    | { type: 'ask.permission'; askId: string; toolName: string; input: Record<string, unknown>; title: string; options: AskOption[] }
    | { type: 'ask.resolved'; askId: string; chosen: string }
    | { type: 'cost'; cost: Cost }
    | { type: 'error'; message: string; fatal: boolean }
  );

export type WbpEventType = WbpEvent['type'];

/** Commands the browser POSTs to /api/workbench/command. */
export type WbpCommand =
  | { type: 'session.start'; projectId: string; projectPath: string; brand: Brand; model?: string; permissionMode?: string }
  | { type: 'prompt.send'; sessionId: string; text: string }
  | { type: 'ask.answer'; sessionId: string; askId: string; optionId: string }
  | { type: 'session.stop'; sessionId: string };

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
