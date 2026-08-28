/**
 * The one child-work state machine every provider adapter writes through.
 *
 * Providers keep their native wire types. Their adapter translates a native
 * signal into these facts; this ledger alone decides which WBP edges exist.
 * That leaves no second map in a driver which can reopen a finished child,
 * announce one twice, or turn a late usage answer into another ending.
 */
import type { AgentKind, AgentState } from '../../../src/workbench/protocol.ts';
import type { DriverEvent } from './types.ts';

type FinishedState = Extract<AgentState, 'done' | 'failed' | 'stopped'>;

export interface NativeAgentStart {
  agentId: string;
  toolCallId: string | null;
  kind: AgentKind;
  what: string;
  agentType: string | null;
  model: string | null;
}

export interface NativeAgentProgress {
  seconds?: number;
  tokens?: number;
  calls?: number;
  doing?: string;
  model?: string | null;
  state?: Extract<AgentState, 'running' | 'parked' | 'waiting'>;
}

export interface NativeAgentFinish extends Omit<NativeAgentProgress, 'state'> {
  state: FinishedState;
  result: string | null;
}

export interface AgentLifecycleRow extends NativeAgentStart {
  since: number;
  seconds: number;
  tokens: number;
  calls: number;
  doing: string | null;
  state: AgentState;
  result: string | null;
  finished: boolean;
}

interface PendingRow {
  start: NativeAgentStart | null;
  row: AgentLifecycleRow | null;
  finish: NativeAgentFinish | null;
  finishEmitted: boolean;
  identified: string | null;
}

/** A native provider boundary translates its own union and owns no lifecycle state. */
export interface ProviderAgentAdapter<NativeSignal> {
  accept(signal: NativeSignal): boolean;
}

const number = (value: number | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

export class AgentLifecycle {
  private readonly rows = new Map<string, PendingRow>();
  private live = new Set<string>();

  constructor(
    private readonly emit: (event: DriverEvent) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Active rows only. Terminal tombstones remain private so late starts cannot reopen them. */
  get size(): number {
    return [...this.rows.values()].filter((entry) => entry.row && !entry.row.finished).length;
  }

  has(agentId: string): boolean {
    const row = this.rows.get(agentId)?.row;
    return Boolean(row && !row.finished);
  }

  get(agentId: string): AgentLifecycleRow | undefined {
    return this.rows.get(agentId)?.row ?? undefined;
  }

  active(): AgentLifecycleRow[] {
    return [...this.rows.values()].flatMap((entry) => entry.row && !entry.row.finished ? [entry.row] : []);
  }

  /** The provider's native level signal, kept as a replace-set and never paired with edges. */
  replaceLiveSet(agentIds: Iterable<string>): void {
    this.live = new Set(agentIds);
  }

  isNativelyLive(agentId: string): boolean {
    return this.live.has(agentId);
  }

  start(start: NativeAgentStart): AgentLifecycleRow {
    const entry = this.entry(start.agentId);
    // A richer duplicate may teach the private record something, but the wire
    // still gets one opening. Adapters should send their provider's canonical
    // start shape first whenever it exists.
    entry.start ??= start;
    if (!entry.row) {
      entry.row = {
        ...entry.start,
        since: this.now(),
        seconds: 0,
        tokens: 0,
        calls: 0,
        doing: null,
        state: 'running',
        result: null,
        finished: false,
      };
      this.emit({ type: 'agent.started', ...entry.start });
      if (entry.identified && entry.identified !== entry.row.agentType) {
        entry.row.agentType = entry.identified;
        this.emit({ type: 'agent.identified', agentId: start.agentId, agentType: entry.identified });
      }
    }
    this.emitPendingFinish(entry);
    return entry.row;
  }

  identify(agentId: string, agentType: string): void {
    if (!agentType) return;
    const entry = this.entry(agentId);
    entry.identified = agentType;
    const row = entry.row;
    if (!row || row.agentType === agentType) return;
    row.agentType = agentType;
    this.emit({ type: 'agent.identified', agentId, agentType });
  }

  progress(agentId: string, patch: NativeAgentProgress): void {
    this.update(agentId, patch, false);
  }

  /** Enrich a terminal row with a provider's explicitly final accounting. */
  finalUsage(agentId: string, patch: NativeAgentProgress): void {
    this.update(agentId, patch, true);
  }

  private update(agentId: string, patch: NativeAgentProgress, finalUsage: boolean): void {
    const entry = this.entry(agentId);
    const row = entry.row;
    if (!row) return;
    const before = { seconds: row.seconds, tokens: row.tokens, calls: row.calls, model: row.model };
    if (row.finished) {
      // Usage and model identity legitimately arrive after completion. They
      // may enrich a terminal row, but stale progress can neither lower its
      // totals nor change its terminal state.
      if (finalUsage) {
        row.seconds = Math.max(row.seconds, number(patch.seconds, row.seconds));
        row.tokens = Math.max(row.tokens, number(patch.tokens, row.tokens));
        row.calls = Math.max(row.calls, number(patch.calls, row.calls));
      }
      row.model ||= patch.model || null;
    } else {
      // Provider totals are cumulative snapshots and may race. An older
      // native message must not make time, spend, or calls run backwards.
      row.seconds = Math.max(row.seconds, number(patch.seconds, row.seconds));
      row.tokens = Math.max(row.tokens, number(patch.tokens, row.tokens));
      row.calls = Math.max(row.calls, number(patch.calls, row.calls));
      row.doing = patch.doing || row.doing;
      row.model = patch.model || row.model;
      row.state = patch.state ?? row.state;
    }
    const changed = before.seconds !== row.seconds || before.tokens !== row.tokens
      || before.calls !== row.calls || before.model !== row.model
      || (!row.finished && (Boolean(patch.doing) || patch.state !== undefined));
    if (!changed) return;
    this.emit({
      type: 'agent.progress',
      agentId,
      seconds: row.seconds,
      tokens: row.tokens,
      calls: row.calls,
      ...(row.finished && finalUsage ? { finalUsage: true } : {}),
      ...(row.doing && !row.finished ? { doing: row.doing } : {}),
      ...(row.model ? { model: row.model } : {}),
      ...(!row.finished && patch.state ? { state: row.state } : {}),
    });
  }

  finish(agentId: string, finish: NativeAgentFinish): void {
    const entry = this.entry(agentId);
    entry.finish ??= finish;
    this.emitPendingFinish(entry);
  }

  private entry(agentId: string): PendingRow {
    let entry = this.rows.get(agentId);
    if (!entry) {
      entry = { start: null, row: null, finish: null, finishEmitted: false, identified: null };
      this.rows.set(agentId, entry);
    }
    return entry;
  }

  private emitPendingFinish(entry: PendingRow): void {
    const row = entry.row;
    const finish = entry.finish;
    if (!row || !finish || entry.finishEmitted) return;
    row.seconds = Math.max(row.seconds, number(finish.seconds, row.seconds));
    row.tokens = Math.max(row.tokens, number(finish.tokens, row.tokens));
    row.calls = Math.max(row.calls, number(finish.calls, row.calls));
    row.model = finish.model || row.model;
    row.state = finish.state;
    row.result = finish.result;
    row.finished = true;
    entry.finishEmitted = true;
    this.emit({
      type: 'agent.finished',
      agentId: row.agentId,
      state: finish.state,
      seconds: row.seconds,
      tokens: row.tokens,
      calls: row.calls,
      model: row.model,
      result: finish.result,
    });
  }
}
