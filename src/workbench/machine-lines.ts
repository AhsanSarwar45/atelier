/**
 * What the machine says about itself, sorted two ways and drawn as one row.
 *
 * The two ways answer different questions and both are needed. The FAMILY says
 * how bad a line is and decides its colour. The AUDIENCE says who it is for and
 * decides whether the chat draws it before the reader has touched anything.
 * With only the first, everything loud enough to have a colour was shown, and
 * most of what a chat drew by default was the machine keeping its own books —
 * an allowance window opening, the mode a chat started in, an agent being
 * dispatched (bw-6jq5). `FOR` below is the second answer. The one measurement
 * behind all of this is in docs/agent-workbench.md §8.2.4 and is not copied
 * here: two copies of a count drift apart, and did.
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
 * What each family LOOKS like is next door in `machine-look.ts`, and the split
 * is load-bearing rather than tidy: this file names icons and Tailwind classes
 * nowhere, so it imports nothing at run time and a plain node script can read
 * the real sorting instead of keeping a copy of it that goes stale
 * (scripts/chat-shows-what-is-yours.mjs, bw-6jq5.4).
 */
import {
  inWords,
  kitSpoke,
  notHisWords,
  PERMISSION_MODE,
  ruleFinished,
  ruleIsRunning,
  saidOf,
  whenItComesBack,
  whoFor,
} from '@/workbench/machine-words';
import type { Audience, MachineFamily, NoteRank } from '@/workbench/protocol';
import type { TranscriptItem } from '@/workbench/use-session';

export type { Audience, MachineFamily };

/** Both audiences, his first — the order the filter stacks them in. */
export const AUDIENCES: Audience[] = ['you', 'machine'];

/**
 * Whose lines a chat does not draw until the reader asks for them.
 *
 * The filter turns this into the switch it remembers and the check reads it to
 * say what a chat draws by default, so the two can never drift into disagreeing
 * about what he sees (`message-filter.ts`, bw-6jq5).
 */
export const OFF_BY_DEFAULT: Audience[] = ['machine'];

/** Every family, in the order they are written about — for tests and for the doc. */
export const FAMILIES: MachineFamily[] = [
  'stopped',
  'failed',
  'waiting',
  'memory',
  'background',
  'breathing',
];

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
  // The rest of what the kit writes in his own name (machine-words.ts,
  // IN_HIS_NAME). None of it is a thing he did: a picture's measurements, a
  // slash command's output, the briefing handed to a worker, and any wrapper a
  // later kit invents. It is the chat's own paperwork, and it reads as that.
  'user/pasted_image': 'breathing',
  'user/command_output': 'breathing',
  'user/fork_brief': 'background',
  'user/note': 'breathing',
  conversation_reset: 'stopped',
  // The kit speaking in the chat's own voice, and both of these mean the same
  // thing: nothing further happens here. An allowance can be waited out and a
  // rule of his organisation cannot, which is why they are two kinds and not
  // one (bw-iiv6.12).
  'kit/limit_reached': 'stopped',
  'kit/org_blocked': 'stopped',

  // Something did not happen that was meant to.
  result: 'failed',
  'system/permission_denied': 'failed',
  'system/model_refusal_no_fallback': 'failed',
  'system/model_refusal_fallback': 'failed',
  'system/mirror_error': 'failed',
  // A turn that died on the service, written into the conversation as if the
  // chat had said it.
  'kit/service_failed': 'failed',
  'system/hook_response': { note: 'failed', detail: 'breathing' },
  auth_status: { note: 'failed', detail: 'breathing' },
  'system/plugin_install': { note: 'failed', detail: 'breathing' },

  // Riding out a service that is busy.
  'system/api_retry': 'waiting',

  // What the reader's allowance is doing. Not the machine's own breathing: it
  // is about HIM, and it starts on (bw-jkh2.19).
  rate_limit_event: 'background',
  // The same news in the chat's own voice: the allowance is spent and the work
  // is being paid for by the token from here on.
  'kit/paying_differently': 'background',

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
  // The panel's own running commentary: a state changing, what one is doing
  // now, the level list of what is running loose. All of it is drawn on the
  // rows themselves, so in the conversation it is the machine breathing
  // (bw-6jq5.3).
  'system/task_updated': 'breathing',
  'system/task_progress': 'breathing',
  'system/background_tasks_changed': 'breathing',
  'system/informational': { note: 'background', detail: 'breathing' },
  'system/notification': { note: 'background', detail: 'breathing' },
  mode: 'background',
  model: 'background',

  // The machine breathing.
  'system/hook_started': 'breathing',
  'system/hook_progress': 'breathing',
  tool_use_summary: 'breathing',
  'system/control_request_progress': 'breathing',
  'system/elicitation_complete': 'breathing',
  // A window filling up, and a turn nobody wanted an answer to.
  'kit/limit_near': 'breathing',
  'kit/no_answer_wanted': 'breathing',
  // A chat waiting on him is the one state here he can act on; the others are
  // it going quiet and picking up again (bw-iiv6).
  'system/session_state_changed': { note: 'waiting', detail: 'breathing' },
  // Files he attached, put away. A file that did not arrive is one the agent
  // will never see, and he is the one who can send it again.
  'system/files_persisted': { note: 'failed', detail: 'breathing' },

  // Four the kit's own iterator is not typed to carry and its program hands on
  // all the same — three of them written down nowhere, `active_goal` declared
  // but only in the transport's union (bw-cx70, bw-cx70.7). A goal of his going
  // away ends a loop nobody but him started; a turn stopped waiting on him is
  // why nothing is moving. The
  // history setting is the chat's memory, and the commentary on what it is
  // doing now is drawn on the chip and the panel already.
  active_goal: { note: 'stopped', detail: 'breathing' },
  autocompact_state: 'memory',
  'system/post_turn_summary': { note: 'waiting', detail: 'breathing' },
  'system/task_summary': 'breathing',

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
  'user/pasted_image': 'machine',
  'user/command_output': 'machine',
  'user/fork_brief': 'machine',
  'user/note': 'machine',
  conversation_reset: 'you',
  // The two that mean the work has stopped dead. Nothing else on the screen
  // says so, and one of them carries the time it comes back.
  'kit/limit_reached': 'you',
  'kit/org_blocked': 'you',

  // The turn did not do what he asked.
  result: 'you',
  'system/permission_denied': 'you',
  'system/model_refusal_no_fallback': 'you',
  'system/model_refusal_fallback': 'you',
  // Signing in is his to fix; checking a sign-in that is fine is not.
  auth_status: { note: 'you', detail: 'machine' },

  // Why the chat is sitting there.
  'system/api_retry': 'you',
  'kit/service_failed': 'you',
  // Money: the allowance is gone and the work is being paid for by the token.
  // Nothing has stopped, so this is not a stop — but what it costs him has
  // changed, and stopping or switching models is his to do (bw-iiv6.12).
  'kit/paying_differently': 'you',

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
  'system/task_updated': 'machine',
  'system/task_progress': 'machine',
  'system/background_tasks_changed': 'machine',

  // The machine's own housekeeping, whatever colour it happens to wear.
  'system/mirror_error': 'machine',
  'system/hook_started': 'machine',
  'system/hook_progress': 'machine',
  'system/hook_response': 'machine',
  'system/plugin_install': 'machine',
  'system/informational': 'machine',
  'system/notification': 'machine',
  tool_use_summary: 'machine',
  'system/control_request_progress': 'machine',
  // A window with room left in it changes nothing he would do — the same
  // ruling the allowance messages already carry — and a turn nobody wanted an
  // answer to is the app's own plumbing talking to itself.
  'kit/limit_near': 'machine',
  'kit/no_answer_wanted': 'machine',
  'system/elicitation_complete': 'machine',

  // A chat that has stopped and is waiting on him is his; a chat going quiet or
  // picking up again is not. An attachment that failed to store is his, because
  // only he can send the file again (bw-iiv6).
  'system/session_state_changed': { note: 'you', detail: 'machine' },
  'system/files_persisted': { note: 'you', detail: 'machine' },

  // The four the kit sends without declaring (bw-cx70), by the same question.
  // A goal of his that has ended and a turn that is stopped waiting on him are
  // both his; the goal still being chased, the history setting and the running
  // commentary are the chat keeping its books.
  active_goal: { note: 'you', detail: 'machine' },
  autocompact_state: 'machine',
  'system/post_turn_summary': { note: 'you', detail: 'machine' },
  'system/task_summary': 'machine',
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
 * Who a line written before the driver carried an audience is for, read off the
 * wording it was frozen with.
 *
 * One kind needs this and one only. An allowance line's whole meaning is its
 * state, and the state used to reach the page as the kit's own word inside the
 * sentence — "the seven-day window is allowed_warning" — while the only thing
 * this file was given to sort on was how loud the line was. Loud meant "not
 * simply open", so a window merely filling up and a window that had actually
 * stopped his work were one thing to it, and both landed in front of him. That
 * is the manager's complaint of 2026-08-21, and thirty-four of these are
 * already in his record with their wording frozen (bw-x6hb).
 *
 * So the old sentence is READ rather than rewritten: only one that says the
 * work was turned away is his. Nothing else is inspected this way — every other
 * kind either has one reader whatever its state, or already told the two apart
 * by loudness. New lines never come here at all: the driver settles them at the
 * state and says so on the note (bw-iiv6).
 */
function heldOver(kind: string, text: string): Audience | null {
  if (kind !== 'rate_limit_event') return null;
  return /\brejected\b/.test(text) ? 'you' : 'machine';
}

/**
 * A frozen sentence said again in English, for the one line that must be read.
 *
 * The same freezing (bw-x6hb) left thirty-seven "Permission mode is now
 * bypassPermissions." lines in the record, and this is not a line he can skip:
 * it is the announcement that a chat has stopped asking before it runs things.
 * The driver writes the English one now; these are the ones already written, and
 * they are restated on the way to the screen rather than left in the setting's
 * own spelling. Only the mode word is looked at, so a sentence that has been
 * reworded since simply passes through untouched.
 */
const SAID_INSTEAD: Record<string, string> = {
  rate_limit_event: 'Your usage allowance changed.',
  'system/background_tasks_changed': 'The list of background jobs changed.',
  'system/task_updated': 'Something changed about an agent you sent off.',
};

/** What the old allowance sentence called each window, in today's words. */
const WINDOW_WAS: Record<string, string> = { 'seven-day': 'weekly', 'five-hour': 'five-hour' };

function saidAgain(kind: string, text: string): string {
  // A line with no sentence at all: the driver used to fall back to printing
  // the kind, so thirty-seven rows in the record read `rate_limit_event`.
  if (text === kind) return SAID_INSTEAD[kind] ?? text;

  if (kind === 'mode') {
    const was = /^Permission mode is now (\w+)\.$/.exec(text);
    return was
      ? `This chat will now ${PERMISSION_MODE[was[1]]?.said ?? inWords(was[1]).toLowerCase()}.`
      : text;
  }

  if (kind === 'rate_limit_event') {
    // "Allowance: the seven-day window is allowed_warning until 12:00 PM" — the
    // line from the manager's screenshot of 2026-08-21, and the reason all this
    // exists. `open` was our own word for a window with room left in it.
    const was = /^Allowance: the ([\w-]+) window is (\w+)(?: until (.+))?$/.exec(text);
    if (!was) return text;
    const window = WINDOW_WAS[was[1]] ?? was[1];
    const state = was[2] === 'open' ? 'allowed' : was[2]!;
    const said = saidOf(kind, state);
    if (!said) return text;
    // The tone is the point of the sentence: a window that turned work away
    // says when the work starts again, and one merely keeping its books says
    // when the counter turns over. Restating them all in the softer half was
    // the look-alike coming back for old records (bw-iiv6.11).
    return `Your ${window} allowance ${said}${whenItComesBack(whoFor(kind, state) ?? 'machine', was[3] ?? null)}`;
  }

  if (kind === 'system/hook_started' || kind === 'system/hook_progress') {
    // "Hook SessionStart:startup (SessionStart)" — six hundred of these in the
    // record, and every word of them the wire's: the kit's name for the hook,
    // the kit's name for the moment, and the kit's own bracket telling him
    // which is which.
    const was = /^Hook (\S+) \((\w+)\)$/.exec(text);
    return was ? ruleIsRunning(was[1]!, was[2]!) : text;
  }

  if (kind === 'system/hook_response') {
    // "Hook SessionStart:startup ran", and the one that did not.
    const ran = /^Hook (\S+) ran$/.exec(text);
    if (ran) return ruleFinished(ran[1]!, saidOf(kind, 'success') ?? 'ran', '');
    const broke = /^Hook (\S+) error: ([\s\S]+)$/.exec(text);
    if (broke) return ruleFinished(broke[1]!, saidOf(kind, 'error') ?? 'could not run', broke[2]!);
    return text;
  }

  return text;
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
      rows.push({ row: 'other', item: hisOwnWords(item) });
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
 * A message standing in the reader's name that he did not type, drawn as what
 * it really is — or, where the kit only wrapped his own words, unwrapped.
 *
 * Stopping a turn puts "[Request interrupted by user]" into the conversation as
 * a message FROM him, and that one shape was the whole of what this recognised.
 * It is not the whole of what the kit writes there: an automated background
 * event, a worker fork's briefing, a slash command, that command's output and
 * the note about a picture he pasted all arrive the same way, and all of them
 * were drawn in his colour, on his side of the page, as things he had said
 * (bw-iiv6.18). The shapes and what each one means are settled once, beside
 * every other sentence the app writes (`machine-words.ts`).
 *
 * The live driver already flags the markers as they arrive; this is what
 * catches every one of them read back from a chat's own record, where nothing
 * was written down beyond the text itself.
 */
export function hisOwnWords(item: TranscriptItem): TranscriptItem {
  if (item.kind !== 'message' || item.role !== 'user') return item;
  const read = notHisWords(item.text);
  return read === null || read.kind !== null ? item : { ...item, text: read.text };
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
function machineLine(item: TranscriptItem): {
  id: string;
  family: MachineFamily;
  audience: Audience;
  kind: string;
  rank: NoteRank;
  text: string;
  body: string | null;
} | null {
  // The kit talking in the chat's own voice: an answer-shaped message whose
  // whole content is one of the sentences the kit writes itself. Filed by what
  // it means and quoted as it stands, because it is already written for a
  // person and carries a time or a number this app cannot regenerate
  // (`machine-words.ts`, bw-iiv6.12).
  if (item.kind === 'message' && item.role === 'assistant') {
    const spoken = kitSpoke(item.text);
    if (spoken !== null) {
      return {
        id: item.id,
        family: familyOf(spoken, 'note'),
        audience: forWhom(spoken, 'note'),
        kind: spoken,
        rank: 'note',
        text: item.text.trim(),
        body: null,
      };
    }
  }
  // The kit writing in HIS name. A shape with no kind is one where it only
  // wrapped words he really typed, and that is his message, not a line about
  // the machine — `hisOwnWords` takes the wrapper off on the way past.
  if (item.kind === 'message' && item.role === 'user') {
    const read = notHisWords(item.text);
    if (read !== null && read.kind !== null) {
      return {
        id: item.id,
        family: familyOf(read.kind, read.rank),
        audience: read.audience ?? forWhom(read.kind, read.rank),
        kind: read.kind,
        rank: read.rank,
        text: read.text,
        body: read.body,
      };
    }
  }
  if (item.kind === 'note') {
    return {
      id: item.id,
      family: familyOf(item.noteKind, item.rank),
      // What the driver settled from the message's own state wins: it read the
      // state, and this file only has the kind and how loud the line is. A note
      // without one — a kind with a single reader, or a line written before
      // there were audiences — falls back to the wording it was frozen with,
      // and then to the ruling for the kind (bw-iiv6).
      audience: item.audience ?? heldOver(item.noteKind, item.text) ?? forWhom(item.noteKind, item.rank),
      kind: item.noteKind,
      rank: item.rank,
      text: saidAgain(item.noteKind, item.text),
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
