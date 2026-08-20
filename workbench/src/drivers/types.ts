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
  /** Continue this brand-side session instead of opening a new one. */
  resume?: string;
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
  /** Change what the RUNNING session is pinned to (docs/agent-workbench.md §8.2.3). */
  setMode(mode: string): Promise<void>;
  setModel(model: string): Promise<void>;
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
   * What the brand says about the ACCOUNT'S allowance — not this session's.
   *
   * Optional, because it is a plan's question and not an agent's: a brand
   * billed per token has no such thing to report, and the app draws nothing
   * rather than inventing a window for it (bw-malh). The answer is the brand's
   * own shape; `plan-usage.ts` reads it.
   */
  usage?(): Promise<unknown | null>;
}
