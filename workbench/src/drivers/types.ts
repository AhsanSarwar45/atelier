/**
 * The seam a brand plugs into.
 *
 * A driver translates one vendor's channel into WBP and back. It never sees
 * HTTP, never sees SQLite, and never knows about beads — which is why adding
 * a brand is one file (docs/agent-workbench.md §2.4).
 */
import type { ImagePayload, WbpEvent } from '../../../src/workbench/protocol.ts';

/** One user turn: what was typed, and any pictures attached to it. */
export interface PromptInput {
  text: string;
  images: ImagePayload[];
}

/**
 * Everything but `seq`, `sessionId` and `at` — the runtime stamps those.
 *
 * Distributes over the union: a bare `Omit` collapses WbpEvent's variants into
 * one shapeless object and every per-variant field stops being checked.
 */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type DriverEvent = OmitEach<WbpEvent, 'seq' | 'sessionId' | 'at'>;

export interface StartOptions {
  cwd: string;
  model?: string;
  permissionMode: string;
  /** Called for every event the driver produces. */
  emit: (e: DriverEvent) => void;
}

/** What the driver hands back when the human answers a permission card. */
export type PermissionAnswer = 'allow_once' | 'allow_always' | 'deny';

export interface Driver {
  /** Begin the session. Resolves once the channel is open, not when the turn ends. */
  start(opts: StartOptions): Promise<void>;
  /** Queue a user turn. */
  send(input: PromptInput): Promise<void>;
  /** Answer an outstanding permission card. */
  answer(askId: string, choice: PermissionAnswer): void;
  /** Stop the turn in flight, leaving the session usable. */
  interrupt(): Promise<void>;
  /** Tear the session down. */
  close(): Promise<void>;
}
