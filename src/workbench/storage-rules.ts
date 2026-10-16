/**
 * The words and the checks behind the storage screen's cleanup rules.
 *
 * Kept apart from the screen so the conflict rules can be tested without
 * drawing anything. The server follows the same order (cleanup.rs `plan`):
 * rules that delete or archive chats go first, so a pictures rule on a chat a
 * chat rule already removes never does anything. A delete rule also deletes
 * archives of its age, so an archive rule never makes one do nothing.
 */
import type { StorageAgeId, StoragePartId, StorageRule } from '@/lib/api';
import { newId } from '@/workbench/protocol';

export const UNIT_DAYS: Record<StorageRule['unit'], number> = { days: 1, weeks: 7, months: 30 };

export const TARGETS: { id: StorageRule['delete']; label: string; hint: string }[] = [
  { id: 'chats', label: 'Delete chat', hint: 'Deletes the chat and its images and files.' },
  { id: 'archive', label: 'Archive chat', hint: 'Moves the chat to a compressed archive. You can restore it later.' },
  { id: 'images', label: 'Delete images', hint: 'Keeps the chat and deletes its images.' },
  { id: 'files', label: 'Delete files', hint: 'Keeps the chat and deletes its attached files.' },
  { id: 'output', label: 'Trim tool output', hint: 'Keeps the start and end of long tool output and removes the middle.' },
];

export const UNITS: { id: StorageRule['unit']; label: string; one: string }[] = [
  { id: 'days', label: 'Days', one: 'day' },
  { id: 'weeks', label: 'Weeks', one: 'week' },
  { id: 'months', label: 'Months', one: 'month' },
];

export const PART_LABELS: Record<StoragePartId, string> = {
  chats: 'Chats',
  archive: 'Archived chats',
  media: 'Images and files',
  claude: 'Claude Code',
  codex: 'Codex',
  search: 'Search index',
  skills: 'Skills',
  browser: 'Browser',
  backups: 'Backups',
  other: 'Other',
};

export const AGE_LABELS: Record<StorageAgeId, string> = {
  week: 'Last 7 days',
  month: '7–30 days',
  quarter: '1–3 months',
  half: '3–6 months',
  year: '6–12 months',
  older: 'Over a year',
};

export function days(rule: StorageRule): number {
  return rule.amount * UNIT_DAYS[rule.unit];
}

/** "30 days", "1 week". */
export function ageWords(rule: Pick<StorageRule, 'amount' | 'unit'>): string {
  const unit = UNITS.find((u) => u.id === rule.unit)!;
  return `${rule.amount} ${rule.amount === 1 ? unit.one : `${unit.one}s`}`;
}

const TITLES: Record<StorageRule['delete'], string> = {
  chats: 'Delete chats',
  archive: 'Archive chats',
  images: 'Delete images in chats',
  files: 'Delete files in chats',
  output: 'Trim tool output in chats',
};

/** The rule as one line: "Delete chats older than 30 days". */
export function ruleTitle(rule: StorageRule): string {
  return `${TITLES[rule.delete]} older than ${ageWords(rule)}`;
}

export interface Conflict {
  /** The rule that makes this one do nothing. */
  by: string;
  kind: 'duplicate' | 'covered';
  message: string;
}

/**
 * Whether rule `a`, when on, already takes everything rule `b` would. A chat
 * rule takes the whole chat, archived or not; an archive rule takes the chat
 * out of reach of every rule but a delete.
 */
function covers(a: StorageRule, b: StorageRule): boolean {
  const scope = !a.projectId || a.projectId === (b.projectId ?? null);
  const target =
    a.delete === 'chats' || (a.delete === 'archive' && b.delete !== 'chats') || a.delete === b.delete;
  return scope && target && days(a) <= days(b);
}

/** What rule `a` already does to what rule `b` would take. */
function already(a: StorageRule, b: StorageRule): string {
  if (a.delete === 'chats') return 'deletes these chats';
  if (a.delete === 'archive') return 'archives these chats';
  if (b.delete === 'output') return 'trims this output';
  return `deletes these ${b.delete}`;
}

function same(a: StorageRule, b: StorageRule): boolean {
  return a.delete === b.delete && days(a) === days(b) && (a.projectId ?? null) === (b.projectId ?? null);
}

/**
 * Rules that can never do anything because another rule that is on removes
 * the same things first. Of two identical rules, the later one is flagged.
 * Turned-off rules are neither checked nor counted.
 */
export function conflicts(rules: StorageRule[]): Map<string, Conflict> {
  const found = new Map<string, Conflict>();
  rules.forEach((b, bi) => {
    if (!b.enabled) return;
    for (let ai = 0; ai < rules.length; ai++) {
      const a = rules[ai];
      if (ai === bi || !a.enabled || !covers(a, b)) continue;
      const name = `rule ${ai + 1}`;
      // Of two rules that take each other's chats, the earlier one does.
      if (ai > bi && covers(b, a)) continue;
      if (same(a, b)) {
        found.set(b.id, { by: a.id, kind: 'duplicate', message: `Same as ${name}.` });
      } else {
        found.set(b.id, { by: a.id, kind: 'covered', message: `No effect. ${name[0].toUpperCase()}${name.slice(1)} already ${already(a, b)}.` });
      }
      return;
    }
  });
  return found;
}

export function newRuleId(): string {
  return newId();
}

/** 1536 → "1.5 KB". */
export function bytesWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
