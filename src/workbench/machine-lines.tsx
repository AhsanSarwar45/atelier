/**
 * What the machine says about itself, sorted two ways and drawn as one row.
 *
 * The two ways answer different questions and both are needed. The FAMILY says
 * how bad a line is and decides its colour. The AUDIENCE says who it is for and
 * decides whether the chat draws it before the reader has touched anything.
 * With only the first, everything loud enough to have a colour was shown, and
 * 78 of the 104 lines a chat drew by default were the machine keeping its own
 * books — an allowance window opening, the mode a chat started in, an agent
 * being dispatched (bw-6jq5). `FOR` below is the second answer.
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

import type { Audience, MachineFamily, NoteRank } from '@/workbench/protocol';
import type { TranscriptItem } from '@/workbench/use-session';

export type { Audience, MachineFamily };

/** Both audiences, his first — the order the filter stacks them in. */
export const AUDIENCES: Audience[] = ['you', 'machine'];

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
  /** The row itself: its tint, its edge and the colour of its words. */
  row: string;
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
    row: 'border-warning/35 bg-warning/10 text-warning',
    count: 'bg-warning/20 text-warning',
  },
  failed: {
    row: 'border-danger/35 bg-danger/10 text-danger',
    count: 'bg-danger/20 text-danger',
  },
  waiting: {
    row: 'border-status-review/35 bg-status-review/10 text-status-review',
    count: 'bg-status-review/20 text-status-review',
  },
  memory: {
    row: 'border-epic/35 bg-epic/10 text-epic',
    count: 'bg-epic/20 text-epic',
  },
  background: {
    row: 'border-info/35 bg-info/10 text-info',
    count: 'bg-info/20 text-info',
  },
  breathing: {
    row: 'border-t-faint/30 bg-transparent text-t-faint',
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

  // What the reader's allowance is doing. Not the machine's own breathing: it
  // is about HIM, and it starts on (bw-jkh2.19).
  rate_limit_event: 'background',

  // The chat's own memory: folding itself up, and what it carries.
  'system/compact_boundary': 'memory',
  'system/memory_recall': 'memory',
  // `system/status` is a ping on every request and the answer to /compact both;
  // the driver ranks the answer `note` and the ping `detail`.
  'system/status': { note: 'memory', detail: 'breathing' },

  // News: an agent sent off, an agent home, the run changing under the reader,
  // and anything the machine wanted him to know rather than to act on.
  //
  // Sending one off is ranked `detail` on purpose — the driver skips a repeated
  // `note` and three helpers sent off on one brief would lose two of their
  // lines — so both ranks are spelled out here. Left to the default, a `detail`
  // this map did not name would fall to breathing and start switched off, which
  // is a chat that delegated its whole turn reading as a chat that fell silent
  // (bw-7ks.22.6).
  'system/task_started': { note: 'background', detail: 'background' },
  // A helper that came home having failed is a failure, and the driver ranks it
  // `note` for exactly that reason; one that came home fine is news of the
  // quietest sort (bw-6jq5).
  'system/task_notification': { note: 'failed', detail: 'background' },
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
 * Who each kind is for. The other half of the answer, and the one that decides
 * what a chat draws before the reader has touched anything (bw-6jq5).
 *
 * The rule for reading this table is one question: is there anything he would
 * DO about the line? He stopped a turn, a command was refused, the chat folded
 * itself up, the model would not answer, his allowance ran out — all of those
 * change what he does next. An allowance window merely being open, a memory
 * being recalled, a rule of his running, a plugin installing, an agent being
 * dispatched and coming home again do not: they are the chat keeping its books,
 * and it keeps them whether he is watching or not.
 *
 * Where the answer turns on WHAT happened rather than on which kind it is, it
 * is written as a pair and the driver carries the split in the rank — a helper
 * that failed, an allowance that ran out, a compaction that was asked for
 * rather than a status ping. That is the same idiom the families use above, and
 * it is why the driver ranks by outcome rather than by kind.
 */
const FOR: Record<string, Audience | Record<NoteRank, Audience>> = {
  // He stopped it, or it stopped.
  'user/synthetic': 'you',
  'system/worker_shutting_down': 'you',
  conversation_reset: 'you',

  // The turn did not do what he asked.
  result: 'you',
  'system/permission_denied': 'you',
  'system/model_refusal_no_fallback': 'you',
  'system/model_refusal_fallback': 'you',
  // Signing in is his to fix; checking a sign-in that is fine is not.
  auth_status: { note: 'you', detail: 'machine' },

  // Why the chat is sitting there.
  'system/api_retry': 'you',

  // The allowance: nothing to do while the window is open, and the reason the
  // work stopped once it is not. The driver ranks the closed one `note`.
  rate_limit_event: { note: 'you', detail: 'machine' },

  // The chat's own memory. Folding up changes what the agent knows and is his;
  // the recall behind it, and the ping on every request, are not.
  'system/compact_boundary': 'you',
  'system/status': { note: 'you', detail: 'machine' },
  'system/memory_recall': 'machine',

  // What he set. A chat that has quietly stopped asking before it runs things
  // is a trap, so a real change speaks; the state a chat opened in is not a
  // change and the driver no longer reports one (bw-6jq5.2).
  mode: 'you',
  model: 'you',

  // Sent-off work is a panel of its own, and a line per dispatch on top of it
  // says the same thing twice — the manager's ruling of 2026-08-20. One that
  // came home having FAILED still speaks, which is the rank split.
  'system/task_started': 'machine',
  'system/task_notification': { note: 'you', detail: 'machine' },

  // The machine's own housekeeping, whatever colour it happens to wear.
  'system/mirror_error': 'machine',
  'system/hook_started': 'machine',
  'system/hook_progress': 'machine',
  'system/hook_response': 'machine',
  'system/plugin_install': 'machine',
  'system/informational': 'machine',
  'system/notification': 'machine',
  tool_use_summary: 'machine',
};

/**
 * Every kind somebody has decided an audience for, for the test that walks the
 * driver. A kind the driver can emit and this list does not name is a kind
 * nobody has ruled on, and it falls to the machine's side unread — so the test
 * fails rather than the reader quietly losing it.
 */
export const KINDS_WITH_AN_AUDIENCE: string[] = Object.keys(FOR);

/**
 * Who one kind of machine line is for.
 *
 * A kind this build has never met is the machine's, whatever it says. That is
 * the opposite of the families' guess, and on purpose: a kind nobody has taught
 * the app is by definition one nobody has decided he needs, and the alternative
 * — every new thing the kit invents landing in the middle of his conversation —
 * is the complaint this job began with. It is not lost, because the machine's
 * own group in the filter carries a count of what is in it (bw-6jq5).
 */
export function forWhom(kind: string, rank: NoteRank): Audience {
  const found = FOR[kind];
  if (found === undefined) return 'machine';
  return typeof found === 'string' ? found : found[rank];
}

/**
 * Who one of the app's OWN asides is for, when it did not say.
 *
 * An aside carries its audience from the sidecar, and one recorded before there
 * were audiences carries only a family. A family that means something stopped,
 * failed, is being waited on or has changed what the chat remembers is his; the
 * app talking about itself is not.
 */
const ASIDE_FOR: Record<MachineFamily, Audience> = {
  stopped: 'you',
  failed: 'you',
  waiting: 'you',
  memory: 'you',
  background: 'machine',
  breathing: 'machine',
};

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
  audience: Audience;
  kind: string;
  rank: NoteRank;
  lines: { text: string; body: string | null }[];
}

export type DrawnRow = MachineRow | { row: 'other'; item: TranscriptItem };

/**
 * The family and the kind one row of a conversation draws as, or nothing if it
 * is not the machine talking. The filter asks this so that its switches stand
 * for what is on the page rather than for the shape the event arrived in.
 */
export const machineIn = (
  item: TranscriptItem,
): { family: MachineFamily; audience: Audience; kind: string } | null => {
  const line = machineLine(item);
  return line === null ? null : { family: line.family, audience: line.audience, kind: line.kind };
};

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
 * The family and the audience have to agree as well, because the app's own
 * asides all arrive under the one kind and carry both beside it: two of them in
 * a row meant differently would otherwise fold, and the chip would wear the
 * first one's colour — or the first one's reader — over the last one's words.
 *
 * Nothing is dropped here on grounds of loudness. A quiet line used to be held
 * back unless a second control was on, so the filter counted status lines the
 * reader could not reach and reported none where there were thirty-three
 * (bw-jkh2.13). What he does not want to see, he switches off by name.
 */
export function drawnRows(items: TranscriptItem[]): DrawnRow[] {
  const rows: DrawnRow[] = [];
  for (const item of items) {
    const line = machineLine(item);
    if (!line) {
      rows.push({ row: 'other', item });
      continue;
    }
    const last = rows[rows.length - 1];
    if (
      last?.row === 'machine' &&
      last.kind === line.kind &&
      last.rank === line.rank &&
      last.family === line.family &&
      last.audience === line.audience
    ) {
      last.lines.push({ text: line.text, body: line.body });
      continue;
    }
    rows.push({
      row: 'machine',
      id: line.id,
      family: line.family,
      audience: line.audience,
      kind: line.kind,
      rank: line.rank,
      lines: [{ text: line.text, body: line.body }],
    });
  }
  return rows;
}

/**
 * A line the kit wrote in the reader's name rather than one he typed.
 *
 * Stopping a turn puts "[Request interrupted by user]" into the conversation as
 * a message FROM him, and every such marker the kit writes has the same shape:
 * one line, wrapped in square brackets, standing alone. Drawn as a message it
 * wore his own colour and his own side of the page, so the thing that stopped
 * the work read as the thing he said — which is the complaint this whole job
 * began with (bw-jkh2.12).
 *
 * Recognised by shape rather than by wording, because the wordings are the
 * kit's and change without us. The live driver already flags these as they
 * arrive; this is what catches the ones read back from a chat's own record,
 * where the flag was never written down. A message he really did type that is
 * nothing but one bracketed line costs him a grey chip, which is the whole
 * price of it.
 */
export const writtenInHisName = (text: string): boolean => /^\[[^\n\]]+\]$/.test(text.trim());

/**
 * A note, or one of the app's own asides, as the same kind of row.
 *
 * An aside is the app talking about the chat rather than the machine talking
 * about itself, and it used to be a second, plainer line of its own — centred,
 * grey, and unlike everything around it (bw-jkh2.5). It carries the family the
 * sidecar gave it; one recorded before there were families is the app speaking,
 * which is what an aside is.
 */
function machineLine(item: TranscriptItem): {
  id: string;
  family: MachineFamily;
  audience: Audience;
  kind: string;
  rank: NoteRank;
  text: string;
  body: string | null;
} | null {
  if (item.kind === 'message' && item.role === 'user' && writtenInHisName(item.text)) {
    return {
      id: item.id,
      family: familyOf('user/synthetic', 'note'),
      audience: forWhom('user/synthetic', 'note'),
      kind: 'user/synthetic',
      rank: 'note',
      text: item.text.trim(),
      body: null,
    };
  }
  if (item.kind === 'note') {
    return {
      id: item.id,
      family: familyOf(item.noteKind, item.rank),
      audience: forWhom(item.noteKind, item.rank),
      kind: item.noteKind,
      rank: item.rank,
      text: item.text,
      body: item.body,
    };
  }
  if (item.kind === 'notice') {
    const family = item.family ?? familyOf('app/notice', 'note');
    return {
      id: item.id,
      family,
      audience: item.audience ?? ASIDE_FOR[family],
      kind: 'app/notice',
      rank: 'note',
      text: item.text,
      body: null,
    };
  }
  return null;
}
