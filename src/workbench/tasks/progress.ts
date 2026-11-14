/**
 * How far a task's plan items have come (docs/tasks.md, "Checking items").
 *
 * While a task is in progress the agent records each plan item's result entry
 * with `atelier task check` as soon as it is met or missed; the server keeps
 * them in `checks`, shaped like the type's result list. Once done, the result
 * holds them. Read loosely, like the rest of the card.
 */
import { itemChecks, itemRuns, tally, type CheckTally } from '@/workbench/tasks/checks';
import { LEGACY_TYPES, targetMet, type OptimizationTarget, type Task } from '@/workbench/tasks/types';

type Loose = Record<string, unknown>;
const rec = (value: unknown): Loose => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Loose : {});
const list = (value: unknown): Loose[] => (Array.isArray(value) ? value.map(rec) : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/** The plan list a type ticks item by item, and the result list that answers it. */
export const ITEM_LISTS: Readonly<Record<string, { plan: string; result: string }>> = {
  feature: { plan: 'criteria', result: 'criteria' },
  general: { plan: 'done_when', result: 'done_when' },
  ui_change: { plan: 'screens', result: 'screens' },
  ui_feature: { plan: 'screens', result: 'screens' },
  ui_bug: { plan: 'screens', result: 'screens' },
  render_bug: { plan: 'scenes', result: 'scenes' },
  render_change: { plan: 'scenes', result: 'scenes' },
  render_feature: { plan: 'scenes', result: 'scenes' },
  optimization: { plan: 'targets', result: 'targets' },
  investigation: { plan: 'questions', result: 'answers' },
  refactor: { plan: 'invariants', result: 'invariants' },
  tests: { plan: 'behaviors', result: 'behaviors' },
  qa: { plan: 'scenarios', result: 'scenarios' },
  docs: { plan: 'pages', result: 'pages' },
  chore: { plan: 'steps', result: 'steps' },
};

/**
 * The type whose plan and result a task follows: its own, or the built-in
 * one a type the install or project made is planned like (`shape`).
 */
export const shapeOf = (task: { type: string; shape?: string | null }): string => task.shape || LEGACY_TYPES[task.type] || task.type;

/** Met, missed (with its reason), or not recorded yet. */
export type ItemState = 'met' | 'missed' | 'open';

export interface ItemOutcome { state: Exclude<ItemState, 'open'>; note: string }

export interface ItemProgress {
  id: string;
  text: string;
  state: ItemState;
  /** Why it was missed; empty otherwise. */
  note: string;
  /** For an item with checks: how many pass. */
  checks?: CheckTally;
  /**
   * For one of the type's default items the agent declined: why it does not
   * apply. Such an item is answered and is not counted.
   */
  declined?: string;
}

type Gated = Pick<Task, 'checked' | 'checkMet' | 'checkRuns'>;

/**
 * Whether a task's items are ticked by its checks rather than by the agent's
 * entries: the server ran them, and `checkMet` says which pass.
 */
export function gated(task: Partial<Gated>): boolean {
  return task.checked === true || (typeof task.checkMet === 'object' && task.checkMet !== null && Object.keys(task.checkMet).length > 0);
}

/** What a plan item is called, by type. */
export function itemText(type: string, item: Loose): string {
  switch (type) {
    case 'ui_change':
    case 'ui_feature':
    case 'ui_bug':
    case 'render_feature':
    case 'optimization':
      return str(item.name);
    case 'render_change':
    case 'render_bug':
      return str(item.scene);
    case 'qa':
      return str(item.expected);
    case 'docs':
      return str(item.path);
    default:
      return str(item.text);
  }
}

/** Whether one recorded entry met its plan item, and if not, why. */
export function entryOutcome(type: string, item: Loose, entry: Loose): ItemOutcome {
  const missed = (note: unknown): ItemOutcome => ({ state: 'missed', note: str(note) });
  switch (type) {
    case 'feature':
    case 'general':
      return entry.met === true ? { state: 'met', note: '' } : missed(entry.reason);
    case 'qa':
      return entry.passed === true ? { state: 'met', note: '' } : missed(entry.notes);
    case 'chore':
      return entry.done === true ? { state: 'met', note: '' } : missed(entry.reason);
    case 'tests':
      return entry.fails_without_code === true ? { state: 'met', note: '' } : missed(entry.reason || 'Passes without the change');
    case 'optimization': {
      const after = typeof entry.after === 'number' ? entry.after : NaN;
      const met = typeof entry.met === 'boolean' ? entry.met : targetMet(item as unknown as OptimizationTarget, after);
      return met ? { state: 'met', note: '' } : missed(entry.failure_reason);
    }
    default:
      // The visual types, investigation, refactor and docs: an entry is the item done.
      return { state: 'met', note: '' };
  }
}

/**
 * The entries recorded for a task's items, by id: the done result's, with
 * the ones checked since laid over them.
 */
export function recordedEntries(task: Pick<Task, 'type' | 'shape' | 'result' | 'checks'>): Map<string, Loose> {
  const lists = ITEM_LISTS[shapeOf(task)];
  const found = new Map<string, Loose>();
  if (!lists) return found;
  for (const entry of [...list(rec(task.result)[lists.result]), ...list(rec(task.checks)[lists.result])]) {
    if (str(entry.id)) found.set(str(entry.id), entry);
  }
  return found;
}

/**
 * Each plan item and where it stands, then the type's default items
 * (`plan.requirements`): those with checks are ticked by them, those declined
 * carry their reason. Empty for a type with no items and no default items.
 */
export function itemProgress(task: Pick<Task, 'type' | 'shape' | 'plan' | 'result' | 'checks'> & Partial<Gated>): ItemProgress[] {
  const type = shapeOf(task);
  const lists = ITEM_LISTS[type];
  const entries = recordedEntries(task);
  const byChecks = gated(task);
  const progress = (item: Loose, text: string): ItemProgress => {
    const id = str(item.id);
    const checks = itemChecks(item);
    if (byChecks && (checks.length || task.checkMet?.[id] !== undefined)) {
      // Ticked only by its checks; one that fails stays open with its tally.
      return {
        id, text, state: task.checkMet?.[id] === true ? 'met' : 'open', note: '',
        ...(checks.length ? { checks: tally(checks, itemRuns(task.checkRuns, id)) } : {}),
      };
    }
    const entry = entries.get(id);
    const outcome = entry ? entryOutcome(type, item, entry) : null;
    return { id, text, state: outcome?.state ?? 'open', note: outcome?.note ?? '' };
  };
  const planned = lists ? list(rec(task.plan)[lists.plan]).map((item) => progress(item, itemText(type, item))) : [];
  const defaults = list(rec(task.plan).requirements).map((item): ItemProgress => {
    const declined = str(item.declined);
    if (declined) return { id: str(item.id), text: str(item.text), state: 'open', note: '', declined };
    return progress(item, str(item.text));
  });
  return [...planned, ...defaults];
}

/** The types whose items are proved with before and after images. */
export const VISUAL_TYPES: ReadonlySet<string> = new Set(['ui_change', 'ui_feature', 'ui_bug', 'render_change', 'render_feature', 'render_bug']);

export interface ItemCounts { met: number; missed: number; total: number }

/** How many plan items are met and missed, out of all of them. */
export function itemCounts(all: readonly ItemProgress[]): ItemCounts {
  const items = all.filter((item) => item.declined === undefined);
  return {
    met: items.filter((item) => item.state === 'met').length,
    missed: items.filter((item) => item.state === 'missed').length,
    total: items.length,
  };
}

/**
 * A checked task's result with an entry for each item its checks met: such a
 * result carries no entries of its own, so the result lists would read as
 * open. The entry says the checks passed, in the type's own words.
 */
export function withCheckedEntries<T extends Pick<Task, 'type' | 'shape' | 'result'> & Partial<Gated>>(task: T): T['result'] {
  const type = shapeOf(task);
  const lists = ITEM_LISTS[type];
  if (!task.result || !lists || !gated(task) || VISUAL_TYPES.has(type) || type === 'optimization') return task.result;
  const given = list(rec(task.result)[lists.result]);
  const have = new Set(given.map((entry) => str(entry.id)));
  const added: Loose[] = [];
  for (const [id, met] of Object.entries(task.checkMet ?? {})) {
    if (!met || have.has(id)) continue;
    const said = 'Its checks pass';
    added.push({
      id, met: true, passed: true, done: true, fails_without_code: true, evidence: said, output: said, how_verified: said,
      what_changed: said, answer: said,
    });
  }
  if (!added.length) return task.result;
  return { ...task.result, [lists.result]: [...given, ...added] };
}
