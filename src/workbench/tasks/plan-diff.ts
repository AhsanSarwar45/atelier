/**
 * What a proposed plan change changes (docs/tasks.md, "Amending"): the plan
 * items added, removed and changed, matched by id, and the other top-level
 * fields that differ. The card shows this rather than both whole plans.
 *
 * Worked out the same way for every type, from its plan list (progress.ts
 * `ITEM_LISTS`). A type with no plan list has only fields.
 */
import { ITEM_LISTS, itemText } from '@/workbench/tasks/progress';

type Loose = Record<string, unknown>;
const rec = (value: unknown): Loose => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Loose : {});
const list = (value: unknown): Loose[] => (Array.isArray(value) ? value.map(rec) : []);
const str = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
/** JSON with object keys sorted, so two copies of one value compare equal whatever order their keys came in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const row = value as Loose;
    return `{${Object.keys(row).filter((k) => row[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(row[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Whether two values are the same, whatever order their keys are in. */
export const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

export interface ItemChange {
  id: string;
  /** What the item is called before the change; empty for an added item. */
  before: string;
  /** What it is called after; empty for a removed item. */
  after: string;
  /** For a changed item, the fields that changed (besides its name, when that changed). */
  fields: string[];
}

export interface FieldChange { key: string; before: unknown; after: unknown }

export interface PlanDiff {
  /** The plan list's name, e.g. `criteria`; empty for a type without one. */
  list: string;
  added: ItemChange[];
  removed: ItemChange[];
  changed: ItemChange[];
  fields: FieldChange[];
}

/** One and many of a plan list's items, for "+1 criterion", "+2 criteria". */
const NOUNS: Record<string, [string, string]> = {
  criteria: ['criterion', 'criteria'],
  done_when: ['item', 'items'],
  screens: ['screen', 'screens'],
  scenes: ['scene', 'scenes'],
  targets: ['target', 'targets'],
  questions: ['question', 'questions'],
  invariants: ['invariant', 'invariants'],
  behaviors: ['behavior', 'behaviors'],
  scenarios: ['scenario', 'scenarios'],
  pages: ['page', 'pages'],
  steps: ['step', 'steps'],
};

export function itemNoun(listKey: string, count: number): string {
  const [one, many] = NOUNS[listKey] ?? ['item', 'items'];
  return count === 1 ? one : many;
}

/** What a field is called on the card: `repro_steps` reads "repro steps". */
export const fieldName = (key: string): string => key.replace(/_/g, ' ');

export function planDiff(type: string, plan: unknown, amend: unknown): PlanDiff {
  const from = rec(plan);
  const to = rec(amend);
  const key = ITEM_LISTS[type]?.plan ?? '';
  const diff: PlanDiff = { list: key, added: [], removed: [], changed: [], fields: [] };
  if (key) {
    const old = new Map(list(from[key]).map((item) => [str(item.id), item]));
    const now = new Map(list(to[key]).map((item) => [str(item.id), item]));
    for (const [id, item] of now) {
      const was = old.get(id);
      if (!was) {
        diff.added.push({ id, before: '', after: itemText(type, item), fields: [] });
      } else if (!same(was, item)) {
        const before = itemText(type, was);
        const after = itemText(type, item);
        const keys = [...new Set([...Object.keys(was), ...Object.keys(item)])];
        const fields = keys.filter((k) => k !== 'id' && !same(was[k], item[k]) && !(before !== after && was[k] === before && item[k] === after));
        diff.changed.push({ id, before, after, fields });
      }
    }
    for (const [id, item] of old) {
      if (!now.has(id)) diff.removed.push({ id, before: itemText(type, item), after: '', fields: [] });
    }
  }
  for (const k of [...new Set([...Object.keys(from), ...Object.keys(to)])]) {
    if (k === key || same(from[k], to[k])) continue;
    diff.fields.push({ key: k, before: from[k], after: to[k] });
  }
  return diff;
}

export const diffIsEmpty = (diff: PlanDiff): boolean =>
  !diff.added.length && !diff.removed.length && !diff.changed.length && !diff.fields.length;

const clip = (text: string, length = 48): string => (text.length > length ? `${text.slice(0, length - 1)}…` : text);

/**
 * The change in one line: `+1 criterion “Search box” · 1 changed · 1 removed`.
 * A single added, removed or changed item is named; more are counted.
 */
export function diffLine(diff: PlanDiff): string {
  const parts: string[] = [];
  const named = (sign: string, items: ItemChange[], text: (item: ItemChange) => string) => {
    if (!items.length) return;
    const head = `${sign}${items.length} ${itemNoun(diff.list, items.length)}`;
    parts.push(items.length === 1 && text(items[0]!) ? `${head} “${clip(text(items[0]!))}”` : head);
  };
  named('+', diff.added, (item) => item.after);
  named('−', diff.removed, (item) => item.before);
  if (diff.changed.length) {
    const one = diff.changed.length === 1 ? diff.changed[0]! : null;
    parts.push(one && one.after ? `${diff.changed.length} changed “${clip(one.after)}”` : `${diff.changed.length} changed`);
  }
  if (diff.fields.length) parts.push(diff.fields.map((field) => `${fieldName(field.key)} changed`).join(', '));
  return parts.join(' · ') || 'no change';
}
