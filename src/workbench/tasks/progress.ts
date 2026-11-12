/**
 * How far a task's plan items have come (docs/tasks.md, "Checking items").
 *
 * While a task is in progress the agent records each plan item's result entry
 * with `atelier task check` as soon as it is met or missed; the server keeps
 * them in `checks`, shaped like the type's result list. Once done, the result
 * holds them. Read loosely, like the rest of the card.
 */
import { targetMet, type OptimizationTarget, type Task } from '@/workbench/tasks/types';

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
  visual_bug: { plan: 'screens', result: 'screens' },
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

/** Met, missed (with its reason), or not recorded yet. */
export type ItemState = 'met' | 'missed' | 'open';

export interface ItemOutcome { state: Exclude<ItemState, 'open'>; note: string }

export interface ItemProgress {
  id: string;
  text: string;
  state: ItemState;
  /** Why it was missed; empty otherwise. */
  note: string;
}

/** What a plan item is called, by type. */
export function itemText(type: string, item: Loose): string {
  switch (type) {
    case 'ui_change':
    case 'ui_feature':
    case 'visual_bug':
    case 'render_feature':
    case 'optimization':
      return str(item.name);
    case 'render_change':
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
export function recordedEntries(task: Pick<Task, 'type' | 'result' | 'checks'>): Map<string, Loose> {
  const lists = ITEM_LISTS[task.type];
  const found = new Map<string, Loose>();
  if (!lists) return found;
  for (const entry of [...list(rec(task.result)[lists.result]), ...list(rec(task.checks)[lists.result])]) {
    if (str(entry.id)) found.set(str(entry.id), entry);
  }
  return found;
}

/** Each plan item and where it stands. Empty for a type with no items. */
export function itemProgress(task: Pick<Task, 'type' | 'plan' | 'result' | 'checks'>): ItemProgress[] {
  const lists = ITEM_LISTS[task.type];
  if (!lists) return [];
  const entries = recordedEntries(task);
  return list(rec(task.plan)[lists.plan]).map((item) => {
    const id = str(item.id);
    const entry = entries.get(id);
    const outcome = entry ? entryOutcome(task.type, item, entry) : null;
    return { id, text: itemText(task.type, item), state: outcome?.state ?? 'open', note: outcome?.note ?? '' };
  });
}

/** The types whose items are proved with before and after images. */
export const VISUAL_TYPES: ReadonlySet<string> = new Set(['ui_change', 'ui_feature', 'visual_bug', 'render_change', 'render_feature']);

export interface ItemCounts { met: number; missed: number; total: number }

/** How many plan items are met and missed, out of all of them. */
export function itemCounts(items: readonly ItemProgress[]): ItemCounts {
  return {
    met: items.filter((item) => item.state === 'met').length,
    missed: items.filter((item) => item.state === 'missed').length,
    total: items.length,
  };
}
