/**
 * What the machine says about itself, sorted into six families and drawn as one.
 *
 * The driver already tells these apart — a compaction, a retry, a hook that
 * refused the turn, a subagent reporting back all arrive under their own name
 * (workbench/src/drivers/claude.ts). Every one of them then reached the screen
 * as the same grey line of code type, so a chat that stalled because the owner
 * stopped it and a chat that stalled because it ran out of room looked
 * identical (bw-jkh2, docs/agent-workbench.md §8.2.4).
 *
 * So each kind lands in one of six families, and the family decides the colour
 * and the mark. The families are severity and cause, not decoration: red always
 * means something failed, whichever of the eleven skins is on. Every colour
 * comes from a token the app already owns, so nothing new was invented for this
 * and a red here is the red on the board.
 *
 * The classes are written out one family at a time and never built from the
 * family's name: Tailwind ships a class only when it read the literal string in
 * the source, which is exactly how the board's own state colours went grey
 * (src/lib/state-styles.ts, bw-ufso.2). `__tests__/machine-lines.test.tsx` runs
 * the real Tailwind over the real tree and fails if one stops coming out.
 */
import {
  Bot,
  Circle,
  CircleStop,
  FoldVertical,
  RefreshCw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

import type { MachineFamily, NoteRank } from '@/workbench/protocol';
import type { TranscriptItem } from '@/workbench/use-session';

export type { MachineFamily };

/** Every family, in the order they are written about — for tests and for the doc. */
export const FAMILIES: MachineFamily[] = [
  'stopped',
  'failed',
  'waiting',
  'memory',
  'background',
  'breathing',
];

export interface FamilyLook {
  /** The hairline either side of the chip. */
  rule: string;
  /** The chip itself: its tint, its edge and the colour of its mark. */
  chip: string;
  /** How many times in a row this kind happened. */
  count: string;
}

/**
 * The look of each family. Spelled out, never interpolated — see the note above.
 *
 * `breathing` is the machine's own breathing and is the one family with no
 * tint: it is grey on purpose, because it is what the reader scrolls past
 * rather than what stopped the work.
 */
const LOOKS: Record<MachineFamily, FamilyLook> = {
  stopped: {
    rule: 'bg-warning/30',
    chip: 'border-warning/35 bg-warning/10 text-warning',
    count: 'bg-warning/20 text-warning',
  },
  failed: {
    rule: 'bg-danger/30',
    chip: 'border-danger/35 bg-danger/10 text-danger',
    count: 'bg-danger/20 text-danger',
  },
  waiting: {
    rule: 'bg-status-review/30',
    chip: 'border-status-review/35 bg-status-review/10 text-status-review',
    count: 'bg-status-review/20 text-status-review',
  },
  memory: {
    rule: 'bg-epic/30',
    chip: 'border-epic/35 bg-epic/10 text-epic',
    count: 'bg-epic/20 text-epic',
  },
  background: {
    rule: 'bg-info/30',
    chip: 'border-info/35 bg-info/10 text-info',
    count: 'bg-info/20 text-info',
  },
  breathing: {
    rule: 'bg-t-faint/25',
    chip: 'border-t-faint/30 bg-transparent text-t-faint',
    count: 'bg-t-faint/20 text-t-faint',
  },
};

export const lookOf = (family: MachineFamily): FamilyLook => LOOKS[family];

/** The mark on the chip. One per family, so the colour is never the only signal. */
const MARKS: Record<MachineFamily, LucideIcon> = {
  stopped: CircleStop,
  failed: TriangleAlert,
  waiting: RefreshCw,
  memory: FoldVertical,
  background: Bot,
  breathing: Circle,
};

export const markOf = (family: MachineFamily): LucideIcon => MARKS[family];

/**
 * Where each of the driver's kinds lands.
 *
 * A kind whose loudness already decides its meaning is written as a pair: the
 * driver ranks a hook that failed `note` and one that worked `detail`, and the
 * same split tells a sign-in that went wrong from one merely being checked.
 * Reading the rank rather than the sentence is what keeps this working whatever
 * the messages are ever worded like.
 */
const BY_KIND: Record<string, MachineFamily | Record<NoteRank, MachineFamily>> = {
  // The owner reached for Stop, the agent is going down, the chat begins again.
  'user/synthetic': 'stopped',
  'system/worker_shutting_down': 'stopped',
  conversation_reset: 'stopped',

  // Something did not happen that was meant to.
  result: 'failed',
  'system/permission_denied': 'failed',
  'system/model_refusal_no_fallback': 'failed',
  'system/model_refusal_fallback': 'failed',
  'system/mirror_error': 'failed',
  'system/hook_response': { note: 'failed', detail: 'breathing' },
  auth_status: { note: 'failed', detail: 'breathing' },
  'system/plugin_install': { note: 'failed', detail: 'breathing' },

  // Riding out a service that is busy.
  'system/api_retry': 'waiting',

  // The chat's own memory: folding itself up, and what it carries.
  'system/compact_boundary': 'memory',
  'system/memory_recall': 'memory',
  // `system/status` is a ping on every request and the answer to /compact both;
  // the driver ranks the answer `note` and the ping `detail`.
  'system/status': { note: 'memory', detail: 'breathing' },

  // News: an agent sent off, an agent home, the run changing under the reader,
  // and anything the machine wanted him to know rather than to act on.
  'system/task_started': { note: 'background', detail: 'background' },
  'system/task_notification': 'background',
  'system/informational': { note: 'background', detail: 'breathing' },
  'system/notification': { note: 'background', detail: 'breathing' },
  mode: 'background',
  model: 'background',

  // The machine breathing.
  'system/hook_started': 'breathing',
  'system/hook_progress': 'breathing',
  tool_use_summary: 'breathing',

  // The app's own asides to the reader, when the record predates families.
  'app/notice': 'background',
};

/** Every kind that has a family of its own, for the test that walks the driver. */
export const KNOWN_KINDS: string[] = Object.keys(BY_KIND);

/**
 * The family one machine line belongs to.
 *
 * A kind this build has never met is `background` when it had something to say
 * and `breathing` when it did not — the same split the driver makes when it
 * ranks one it does not know, so an unfamiliar message keeps its loudness
 * instead of being quietly demoted to grey.
 */
export function familyOf(kind: string, rank: NoteRank): MachineFamily {
  const found = BY_KIND[kind];
  if (found === undefined) return rank === 'note' ? 'background' : 'breathing';
  return typeof found === 'string' ? found : found[rank];
}

/**
 * One machine line on the page, and every line folded into it, oldest first.
 *
 * A bad ten minutes on a busy service is eight retries, which is one thing that
 * happened eight times rather than eight things — read as eight it buries the
 * sentence either side of it (bw-jkh2.4). The chip says the newest of them,
 * because that is where the run had got to; opening it gives all eight in
 * order, so nothing a folded line said is lost.
 */
export interface MachineRow {
  row: 'machine';
  id: string;
  family: MachineFamily;
  kind: string;
  rank: NoteRank;
  lines: { text: string; body: string | null }[];
}

export type DrawnRow = MachineRow | { row: 'other'; item: TranscriptItem };

/** What the chip says: where the run had got to. */
export const saidBy = (row: MachineRow): string => row.lines[row.lines.length - 1]?.text ?? '';

/** Whether anything folded here has more behind it than its one line. */
export const opensOn = (row: MachineRow): boolean =>
  row.lines.length > 1 || row.lines.some((l) => Boolean(l.body));

/**
 * The conversation as it is drawn: every machine line carrying its family, and
 * a run of one kind folded into a single row carrying all of them.
 *
 * Kind and loudness are what fold, never the wording: a retry counts up as it
 * goes — "1 of 5", then "2 of 5" — so folding on the sentence would fold
 * nothing at all and leave the run exactly as long as it was.
 *
 * The family has to agree as well, because the app's own asides all arrive
 * under the one kind and carry their family beside it: two of them in a row
 * meant for different families would otherwise fold, and the chip would wear
 * the first one's colour over the last one's words.
 *
 * The quiet lines go before the folding rather than after it, because a status
 * ping landing in the middle of a run of retries would otherwise cut the run in
 * two and draw the same thing twice with nothing between them.
 */
export function drawnRows(items: TranscriptItem[], everything: boolean): DrawnRow[] {
  const rows: DrawnRow[] = [];
  for (const item of items) {
    const line = machineLine(item);
    if (!line) {
      rows.push({ row: 'other', item });
      continue;
    }
    if (line.rank === 'detail' && !everything) continue;
    const last = rows[rows.length - 1];
    if (
      last?.row === 'machine' &&
      last.kind === line.kind &&
      last.rank === line.rank &&
      last.family === line.family
    ) {
      last.lines.push({ text: line.text, body: line.body });
      continue;
    }
    rows.push({
      row: 'machine',
      id: line.id,
      family: line.family,
      kind: line.kind,
      rank: line.rank,
      lines: [{ text: line.text, body: line.body }],
    });
  }
  return rows;
}

/**
 * A note, or one of the app's own asides, as the same kind of row.
 *
 * An aside is the app talking about the chat rather than the machine talking
 * about itself, and it used to be a second, plainer line of its own — centred,
 * grey, and unlike everything around it (bw-jkh2.5). It carries the family the
 * sidecar gave it; one recorded before there were families is the app speaking,
 * which is what an aside is.
 */
function machineLine(
  item: TranscriptItem,
): { id: string; family: MachineFamily; kind: string; rank: NoteRank; text: string; body: string | null } | null {
  if (item.kind === 'note') {
    return {
      id: item.id,
      family: familyOf(item.noteKind, item.rank),
      kind: item.noteKind,
      rank: item.rank,
      text: item.text,
      body: item.body,
    };
  }
  if (item.kind === 'notice') {
    return {
      id: item.id,
      family: item.family ?? familyOf('app/notice', 'note'),
      kind: 'app/notice',
      rank: 'note',
      text: item.text,
      body: null,
    };
  }
  return null;
}
