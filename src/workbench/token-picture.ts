/**
 * What a whole task has spent, read off its own record.
 *
 * The gauge on the chat's line answers "how much room is left NOW", and that
 * number drops back to almost nothing every time the kit compacts the
 * conversation — the chat forgets itself and carries on, and the reader
 * watching the gauge sees a long day's work reset to 20k with no sign of what
 * it cost to get there. This is the other number: everything the task has spent
 * from its first word, across every forgetting, with the work it sent away
 * counted in (bw-3ug7).
 *
 * Read off the record rather than asked of the kit, because the kit's own
 * running total is per-run: a chat resumed this morning reports what this
 * morning cost. The file holds the whole task.
 *
 * Shared with the sidecar, which runs it through Node's strip-only TypeScript,
 * so it imports types and nothing else.
 */
import type { Recorded, Usage } from './context-window';

/** One reading of spending, split the four ways the kit reports a call. */
export interface Split {
  /** Words sent fresh this turn — the smallest part of a long conversation. */
  input: number;
  /** Words written into the kept-ready copy, so the next turn need not resend them. */
  cacheWrite: number;
  /** Words read back out of that copy: most of what a long conversation costs. */
  cacheRead: number;
  /** Words the model wrote back. */
  output: number;
  /** How much of the writing was thinking. Part of `output`, not added to it. */
  thinking: number;
  /** The four of them: the same reading of a turn the gauge makes. */
  total: number;
}

/** Nothing spent — the shape a caller adds into. */
export const NOTHING: Split = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, thinking: 0, total: 0 };

/** What one model was asked for, and what it cost. */
export interface ModelShare {
  model: string;
  spend: Split;
  /** Turns this model answered. */
  turns: number;
}

/** A whole task's spending, as its record has it. */
export interface TaskSpend {
  /** What the conversation itself spent. */
  own: Split;
  /** What the agents it sent off spent, all told. */
  helpers: Split;
  /** The two added: what the task cost. */
  total: Split;
  /** Turns the models answered — the chat's own, not its helpers'. */
  turns: number;
  /** Tool calls the chat made, its helpers' excluded. */
  toolCalls: number;
  /** How many times the kit compacted this conversation and it carried on. */
  forgettings: number;
  /** How many agents it sent off. */
  helperCount: number;
  /** One row per model, biggest first, the chat's own turns and its helpers'. */
  models: ModelShare[];
}

/** Nothing to say: a record with no turn in it that states a cost. */
export const SPENT_NOTHING: TaskSpend = {
  own: NOTHING,
  helpers: NOTHING,
  total: NOTHING,
  turns: 0,
  toolCalls: 0,
  forgettings: 0,
  helperCount: 0,
  models: [],
};

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/** What one call cost, split. Everything missing reads as nothing. */
export function splitOf(usage: Usage | null | undefined): Split {
  if (!usage) return NOTHING;
  const detail = (usage as { output_tokens_details?: { thinking_tokens?: unknown } }).output_tokens_details;
  const input = num(usage.input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const output = num(usage.output_tokens);
  return {
    input,
    cacheWrite,
    cacheRead,
    output,
    thinking: num(detail?.thinking_tokens),
    total: input + cacheWrite + cacheRead + output,
  };
}

/** Two readings added. */
export function plus(a: Split, b: Split): Split {
  return {
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    thinking: a.thinking + b.thinking,
    total: a.total + b.total,
  };
}

/** As much of a recorded line as this arithmetic reads. */
interface Line extends Recorded {
  type?: unknown;
  isCompactSummary?: unknown;
  isSidechain?: unknown;
}

interface Turn {
  id?: unknown;
  model?: unknown;
  usage?: Usage | null;
  content?: unknown;
}

function turnOf(message: unknown): Turn | null {
  return message !== null && typeof message === 'object' ? (message as Turn) : null;
}

/**
 * Every turn in a record, each counted once.
 *
 * The trap this exists for: ONE answer from the model is written into the
 * record as SEVERAL lines — its thinking, its words and each of its calls can
 * each land as their own line — and every one of them carries a copy of that
 * answer's usage under the same message id. Adding the lines up therefore bills
 * a turn once per block it happened to be made of, which on the manager's own
 * record came to 722,555,101 tokens against a true 531,313,155 — 36 percent
 * high, and higher the more the agent thinks and calls (measured 2026-08-20 on
 * record bde56edd). The id is what tells a repeat from a new turn; a line
 * carrying no id is counted, because two turns are never known to be one.
 */
export function turnsIn(lines: readonly Recorded[]): { message: Turn; usage: Usage }[] {
  const seen = new Set<string>();
  const turns: { message: Turn; usage: Usage }[] = [];
  for (const line of lines) {
    const message = turnOf(line.message);
    const usage = message?.usage;
    if (!message || !usage) continue;
    const id = typeof message.id === 'string' ? message.id : '';
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    turns.push({ message, usage });
  }
  return turns;
}

/** What a record spent, counting each turn once. */
export function spendIn(lines: readonly Recorded[]): Split {
  return turnsIn(lines).reduce((sum, turn) => plus(sum, splitOf(turn.usage)), NOTHING);
}

/**
 * The calls one recorded LINE made.
 *
 * Asked of every line and not only of the turns counted above, because the
 * several lines one answer is written as do not repeat its blocks the way they
 * repeat its usage — they divide them: the thinking lands on one line and each
 * call on its own. So a turn's cost is counted once and its calls are counted
 * everywhere, and deduplicating both lost two calls in five on the manager's
 * own record (1,331 counted against 2,329 made, 2026-08-20).
 */
function callsIn(message: Turn | null): number {
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((b) => b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_use')
    .length;
}

/** What a helper's own file says it cost, as this arithmetic reads one. */
export interface HelperSpend {
  model: string | null;
  spend: Split;
}

/**
 * The whole picture, from the chat's record and its helpers' files.
 *
 * `forgettings` counts the summaries the kit writes when it compacts: the
 * moments the conversation started again from a paragraph about itself. It is
 * the one thing that makes the gauge and this number disagree, so it is said
 * rather than left for the reader to infer from a small gauge and a large bill.
 */
export function taskSpend(lines: readonly Recorded[], helpers: readonly HelperSpend[] = []): TaskSpend {
  const byModel = new Map<string, ModelShare>();
  const add = (model: string | null, spend: Split, turn: boolean): void => {
    const name = model ?? 'unnamed';
    const row = byModel.get(name) ?? { model: name, spend: NOTHING, turns: 0 };
    byModel.set(name, { model: name, spend: plus(row.spend, spend), turns: row.turns + (turn ? 1 : 0) });
  };

  let own = NOTHING;
  let turns = 0;
  for (const turn of turnsIn(lines)) {
    const spend = splitOf(turn.usage);
    own = plus(own, spend);
    turns += 1;
    add(typeof turn.message.model === 'string' ? turn.message.model : null, spend, true);
  }

  let toolCalls = 0;
  for (const line of lines) toolCalls += callsIn(turnOf(line.message));

  let sentAway = NOTHING;
  for (const helper of helpers) {
    sentAway = plus(sentAway, helper.spend);
    add(helper.model, helper.spend, false);
  }

  let forgettings = 0;
  for (const line of lines as readonly Line[]) if (line.isCompactSummary === true) forgettings += 1;

  return {
    own,
    helpers: sentAway,
    total: plus(own, sentAway),
    turns,
    toolCalls,
    forgettings,
    helperCount: helpers.length,
    // A model that spent nothing is not a row: the kit files its own synthetic
    // turns under a model name and they cost nothing, and a zero in this list
    // reads as a model that was asked for and came back free.
    models: [...byModel.values()].filter((m) => m.spend.total > 0).sort((a, b) => b.spend.total - a.spend.total),
  };
}
