/**
 * The seam a brand plugs into.
 *
 * A driver translates one vendor's channel into WBP and back. It never sees
 * HTTP, never sees SQLite, and never knows about beads — which is why adding
 * a brand is one file (docs/agent-workbench.md §2.4).
 */
import type { AgentControl, ImagePayload, WbpEvent } from '../../../src/workbench/protocol.ts';

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
  effort?: string;
  /** Continue this brand-side session instead of opening a new one. */
  resume?: string;
  /** Called for every event the driver produces. */
  emit: (e: DriverEvent) => void;
}

/** What the driver hands back when the human answers a permission card. */
export type PermissionAnswer = 'allow_once' | 'allow_always' | 'deny' | string;

export interface Driver {
  /** OS process owned by this driver, when the provider exposes one. */
  processId?(): number | null;
  /** Begin the session. Resolves once the channel is open, not when the turn ends. */
  start(opts: StartOptions): Promise<void>;
  /** Reject a turn before the runtime persists it, when discovery proves it cannot run. */
  validate?(input: PromptInput): Promise<void>;
  /** Queue a user turn. */
  send(input: PromptInput): Promise<void>;
  /** Answer an outstanding permission card. */
  answer(askId: string, choice: PermissionAnswer, value?: string): void;
  /** Change what the RUNNING session is pinned to (docs/agent-workbench.md §8.2.3). */
  setMode(mode: string): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort(effort: string): Promise<void>;
  /** Stop the turn in flight, leaving the session usable. */
  interrupt(): Promise<void>;
  /**
   * Which of the three steering controls this brand actually has for the work
   * a chat sends away (docs/agent-workbench.md §8.2.7).
   *
   * Optional, and answering with fewer than three is a real answer: a control
   * a brand cannot perform is hidden rather than drawn and faked (decision 13).
   * A driver that says nothing offers no steering at all.
   */
  agentControls?(): AgentControl[];
  /**
   * End ONE piece of sent-off work. The chat goes on, and so does everything
   * else it sent away. `agentId` is the row's own id.
   */
  stopAgent?(agentId: string): Promise<void>;
  /**
   * Let one piece of sent-off work run on in the background and hand the turn
   * back to the chat. False when the brand knew of no such work in flight.
   */
  parkAgent?(agentId: string): Promise<boolean>;
  /** Tear the session down. */
  close(): Promise<void>;
  /**
   * What is filling THIS session's window right now, piece by piece.
   *
   * Optional, and the only place the answer exists: the record on disk holds
   * what turns cost, never what the next prompt is made of. A brand that
   * cannot say leaves the panel saying so, rather than the app working a
   * breakdown out for itself (window-now.ts, bw-3ug7). The answer is the
   * brand's own shape; `readWindow` reads it.
   */
  windowNow?(): Promise<unknown | null>;
}
