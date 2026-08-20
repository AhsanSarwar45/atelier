/**
 * Which kinds of message a conversation draws, as a tree the reader switches.
 *
 * A busy chat is mostly the agent's own working — files read, commands run,
 * quiet notes about itself — and what it actually SAID is a handful of rows
 * buried in it. The reader wants to turn the working off and read the answers,
 * or turn everything but the commands off and watch what it touched. So the
 * kinds are a tree: you beside the agent at the top, the agent's replies,
 * thinking, commands, status lines, questions and reports beneath it, and under
 * commands one entry for every tool this conversation actually used (bw-qdim).
 *
 * Two rules make the tree behave the way a reader expects rather than the way a
 * set of checkboxes does:
 *
 *  - What is remembered is what he switched OFF. A switch nobody has touched is
 *    on, so a tool used here for the first time — and a kind we add to the chat
 *    next month — arrives visible instead of silently missing from a
 *    conversation he thought he was reading whole. The one exception is the
 *    machine's own side, which starts off: see `QUIET` (bw-6jq5).
 *  - Turning a group off hides everything under it and forgets what was off
 *    inside it, so turning the group back on gives him all of it back rather
 *    than whatever remained of it the last time he was in there.
 */
import {
  AUDIENCES,
  drawnRows,
  FAMILIES,
  machineIn,
  type Audience,
  type MachineFamily,
} from '@/workbench/machine-lines';
import type { TranscriptItem } from '@/workbench/use-session';

/**
 * Where the reader's choice is remembered between visits.
 *
 * The number moved when audience became the top of the status tree: every
 * switch under it is spelled differently now, so a choice written by the old
 * build names nothing and would silently read as "he turned nothing off" —
 * which is exactly the chat full of bookkeeping this job removed. A new name
 * hands him the new default once and keeps the old choice out of the way
 * (bw-6jq5).
 */
export const CHAT_FILTER = 'workbench.chat-filter.2';

/**
 * A kind's name in the tree. The fixed ones are spelled out; a tool is
 * `tool:` and its own name, which is a prefix rather than a dotted path because
 * a tool may be called anything at all — an MCP tool's name is its server's
 * name run together with its own — and a delimiter it might contain would cut
 * the tree in the wrong place.
 */
export type KindId = string;

export const YOU = 'you';
export const AGENT = 'agent';
export const REPLIES = 'replies';
export const THINKING = 'thinking';
export const COMMANDS = 'commands';
export const STATUS = 'status';
export const QUESTIONS = 'questions';
export const REPORTS = 'reports';

/** The tool's own name, as the agent reported it. */
export const toolKind = (name: string): KindId => `tool:${name}`;
export const toolName = (id: KindId): string => id.slice('tool:'.length);
export const isTool = (id: KindId): boolean => id.startsWith('tool:');

/**
 * A machine line's switch: who it is for under status, its family under that,
 * and its own kind under the family.
 *
 * Audience is the top of the three because it is the one the reader reaches
 * for: everything meant for him, or all of it. Family is kept beneath because
 * hook chatter and a chat that ran out of room are both status lines and are
 * not remotely the same news, so one switch over the pair of them is no switch
 * at all (bw-jkh2.14). And inside a family the reader wants one kind gone
 * rather than all of them — the hook that fires on every prompt, but not the
 * hook that refused a turn (bw-jkh2.19).
 *
 * Neither an audience nor a family can contain a slash and a kind may, so the
 * first two separate the three and everything after the second is the kind.
 */
export const audienceKind = (who: Audience): KindId => `status:${who}`;
export const statusKind = (who: Audience, family: MachineFamily): KindId => `status:${who}/${family}`;
export const statusOf = (who: Audience, family: MachineFamily, kind: string): KindId =>
  `status:${who}/${family}/${kind}`;
export const isStatus = (id: KindId): boolean => id.startsWith('status:');
const cut = (id: KindId): [Audience, MachineFamily | null, string | null] => {
  const rest = id.slice('status:'.length);
  const at = rest.indexOf('/');
  if (at === -1) return [rest as Audience, null, null];
  const who = rest.slice(0, at) as Audience;
  const under = rest.slice(at + 1);
  const then = under.indexOf('/');
  return then === -1
    ? [who, under as MachineFamily, null]
    : [who, under.slice(0, then) as MachineFamily, under.slice(then + 1)];
};
export const audienceOfKind = (id: KindId): Audience => cut(id)[0];
export const familyOfKind = (id: KindId): MachineFamily | null => cut(id)[1];
export const kindUnder = (id: KindId): string | null => cut(id)[2];

/** What each fixed kind is called on screen, in the reader's words. */
const LABELS: Record<string, string> = {
  [YOU]: 'You',
  [AGENT]: 'The agent',
  [REPLIES]: 'Replies',
  [THINKING]: 'Thinking',
  [COMMANDS]: 'Commands',
  [STATUS]: 'Status lines',
  [QUESTIONS]: 'Questions',
  [REPORTS]: 'Reports',
};

/** What each audience is called on screen. The switch the reader reaches for. */
const AUDIENCE_LABELS: Record<Audience, string> = {
  you: 'For you',
  machine: 'The machine’s own',
};

/** What each family is called on screen — severity and cause, in his words. */
const FAMILY_LABELS: Record<MachineFamily, string> = {
  stopped: 'Stopped',
  failed: 'Failed',
  waiting: 'Waiting on a service',
  memory: 'Memory',
  background: 'News',
  breathing: 'Routine',
};

/**
 * What each kind of machine line is called on screen.
 *
 * The driver's own names are for the wire — `system/hook_started` is not a
 * thing to offer a reader. A kind with no entry here is drawn from its own
 * name, so a kind the chat grows next month arrives with a readable switch
 * rather than none at all.
 */
const KIND_LABELS: Record<string, string> = {
  'user/synthetic': 'Interrupts',
  'system/worker_shutting_down': 'An agent shutting down',
  conversation_reset: 'A chat started over',
  result: 'How a turn ended',
  'system/permission_denied': 'Commands you refused',
  'system/model_refusal_no_fallback': 'The model refusing',
  'system/model_refusal_fallback': 'The model refusing',
  'system/mirror_error': 'Mirror trouble',
  'system/hook_response': 'Hooks answering',
  auth_status: 'Signing in',
  'system/plugin_install': 'Plugins',
  'system/api_retry': 'Retries',
  rate_limit_event: 'Your allowance',
  'system/compact_boundary': 'Compactions',
  'system/memory_recall': 'Memory recalled',
  'system/status': 'Status pings',
  'system/task_started': 'Agents sent off',
  'system/task_notification': 'Agents reporting back',
  'system/informational': 'Notices',
  'system/notification': 'Notices',
  mode: 'Mode changes',
  model: 'Model changes',
  'system/hook_started': 'Hooks starting',
  'system/hook_progress': 'Hooks working',
  tool_use_summary: 'Command summaries',
  'app/notice': 'The app’s own notes',
};

/** A kind nobody has named, said as well as its own name allows. */
const saidPlainly = (kind: string): string => {
  const tail = kind.includes('/') ? kind.slice(kind.indexOf('/') + 1) : kind;
  const words = tail.replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const labelOf = (id: KindId): string => {
  if (isTool(id)) return toolName(id);
  if (!isStatus(id)) return LABELS[id] ?? id;
  const kind = kindUnder(id);
  if (kind !== null) return KIND_LABELS[kind] ?? saidPlainly(kind);
  const family = familyOfKind(id);
  return family === null ? AUDIENCE_LABELS[audienceOfKind(id)] : FAMILY_LABELS[family];
};

/** The kind directly above this one, or null for the two at the top. */
export function above(id: KindId): KindId | null {
  if (isTool(id)) return COMMANDS;
  if (isStatus(id)) {
    const family = familyOfKind(id);
    if (family === null) return STATUS;
    if (kindUnder(id) === null) return audienceKind(audienceOfKind(id));
    return statusKind(audienceOfKind(id), family);
  }
  if (id === YOU || id === AGENT) return null;
  return AGENT;
}

/** This kind and every kind above it, nearest first. */
export function upward(id: KindId): KindId[] {
  const chain: KindId[] = [id];
  for (let up = above(id); up !== null; up = above(up)) chain.push(up);
  return chain;
}

/** Which switch one row of the conversation answers to. */
export function kindOf(item: TranscriptItem): KindId {
  // Asked of the drawing first: an interrupt arrives shaped like something he
  // typed and is drawn as a machine line, and the switch has to follow the
  // page rather than the wire (bw-jkh2.12).
  const machine = machineIn(item);
  if (machine !== null) return statusOf(machine.audience, machine.family, machine.kind);
  switch (item.kind) {
    case 'message':
      return item.role === 'user' ? YOU : REPLIES;
    case 'thinking':
      return THINKING;
    case 'tool':
      return toolKind(item.name);
    case 'ask':
      return QUESTIONS;
    case 'report':
      return REPORTS;
    // Never reached: a note and a notice both draw as machine lines and were
    // answered above. Kept so the switch stays exhaustive over the kinds.
    case 'note':
    case 'notice':
      return STATUS;
  }
}

/** One line of the tree on screen. */
export interface KindNode {
  id: KindId;
  label: string;
  /** How many rows of THIS conversation it matches, its children included. */
  count: number;
  children: KindNode[];
}

/** How the switch reads: fully on, fully off, or on in part. */
export type SwitchState = 'on' | 'off' | 'half';

const UNDER_AGENT = [REPLIES, THINKING, COMMANDS, STATUS, QUESTIONS, REPORTS];

/**
 * The tree for one conversation: the fixed kinds always, and under commands
 * exactly the tools it used, in the order a reader scans a list — by name.
 */
export function treeOf(items: TranscriptItem[]): KindNode[] {
  // Counted as the page draws it, not as the record holds it: a run of eight
  // retries is one row with an 8 on it, and a count of 8 beside a switch that
  // removes one row would be a lie about what turning it off costs.
  const tally = new Map<KindId, number>();
  for (const row of drawnRows(items)) {
    const id = row.row === 'machine' ? statusOf(row.audience, row.family, row.kind) : kindOf(row.item);
    tally.set(id, (tally.get(id) ?? 0) + 1);
  }

  const tools = Array.from(tally.keys())
    .filter(isTool)
    .sort((a, b) => toolName(a).localeCompare(toolName(b)))
    .map((id) => leaf(id, tally));

  // His side first, then the machine's. Inside each, the families' own order,
  // which runs from what stopped the work down to what the machine says while
  // it breathes — not alphabetically, which would put the noise first. Inside a
  // family, by the name the reader reads.
  //
  // An audience with nothing in it is still drawn: a chat where the machine
  // said nothing at all must not look like a chat whose machine side has gone
  // missing, and the group is where the reader goes to check (bw-6jq5).
  const audiences = AUDIENCES.map((who) => {
    const families = FAMILIES.map((family) => {
      const kinds = Array.from(tally.keys())
        .filter(
          (id) =>
            isStatus(id) &&
            kindUnder(id) !== null &&
            audienceOfKind(id) === who &&
            familyOfKind(id) === family,
        )
        .sort((a, b) => labelOf(a).localeCompare(labelOf(b)))
        .map((id) => leaf(id, tally));
      return kinds.length === 0 ? null : group(statusKind(who, family), kinds);
    }).filter((node): node is KindNode => node !== null);
    return group(audienceKind(who), families);
  });

  const branches = UNDER_AGENT.map((id) =>
    id === COMMANDS ? group(COMMANDS, tools) : id === STATUS ? group(STATUS, audiences) : leaf(id, tally),
  );

  return [leaf(YOU, tally), group(AGENT, branches)];
}

const leaf = (id: KindId, tally: Map<KindId, number>): KindNode => ({
  id,
  label: labelOf(id),
  count: tally.get(id) ?? 0,
  children: [],
});

const group = (id: KindId, children: KindNode[]): KindNode => ({
  id,
  label: labelOf(id),
  count: children.reduce((sum, child) => sum + child.count, 0),
  children,
});

/**
 * How a switch reads. A group is off when it is switched off itself or sits
 * under one that is; otherwise it is whatever its children agree on, and half
 * when they disagree — which is what tells the reader commands is filtered
 * without his having to open it.
 */
export function switchOf(node: KindNode, off: ReadonlySet<KindId>): SwitchState {
  if (upward(node.id).some((id) => off.has(id))) return 'off';
  if (node.children.length === 0) return 'on';
  const states = node.children.map((child) => switchOf(child, off));
  if (states.every((s) => s === 'on')) return 'on';
  if (states.every((s) => s === 'off')) return 'off';
  return 'half';
}

/**
 * Flip one switch. A group going off is recorded as one entry and its children
 * forgotten, so switching it back on hands the reader the whole of it — and so
 * a tool that first appears while commands is off stays off with the rest of
 * them rather than arriving alone in an empty group.
 *
 * The whole tree is needed, not just the switch that was clicked: turning one
 * tool back on while commands is off has to say what happens to the OTHER
 * tools, and the answer — they stay off — cannot be written down without
 * knowing which tools this conversation has (bw-qdim.9).
 */
export function flip(off: ReadonlySet<KindId>, node: KindNode, tree: KindNode[]): Set<KindId> {
  const next = new Set(off);
  const going = switchOf(node, off) !== 'off';
  if (!going) letThrough(next, node.id, tree);
  for (const child of descend(node)) next.delete(child);
  next.delete(node.id);
  if (going) next.add(node.id);
  return next;
}

/**
 * Open a path down to one switch through the groups above it.
 *
 * A group is switched off as a single entry, which is what makes turning it
 * back on give the reader all of it. The cost is that a switch inside it is
 * then off by inheritance and has nothing of its own to remove — clicking it
 * did nothing at all, which reads as a broken control. So each group on the way
 * down is opened and its own children switched off individually, leaving
 * exactly the one the reader asked for standing and the group reading half-on.
 */
function letThrough(off: Set<KindId>, id: KindId, tree: KindNode[]): void {
  const path = upward(id).reverse();
  let inherited = false;
  for (let i = 0; i < path.length - 1; i += 1) {
    const parent = path[i]!;
    const onward = path[i + 1]!;
    const wasOff = inherited || off.has(parent);
    off.delete(parent);
    if (!wasOff) continue;
    for (const child of find(tree, parent)?.children ?? []) {
      if (child.id !== onward) off.add(child.id);
    }
    inherited = true;
  }
}

/** One switch in the tree, by name. */
function find(tree: KindNode[], id: KindId): KindNode | null {
  for (const node of tree) {
    if (node.id === id) return node;
    const under = find(node.children, id);
    if (under) return under;
  }
  return null;
}

const descend = (node: KindNode): KindId[] =>
  node.children.flatMap((child) => [child.id, ...descend(child)]);

/** Nothing switched off at all — every kind the conversation holds. */
export const EVERYTHING: ReadonlySet<KindId> = new Set<KindId>();

/**
 * What is off before he touches anything: the machine's own side, whole.
 *
 * The rest of the tree arrives on, so a kind the chat grows next month is never
 * silently missing from a conversation he thought he was reading whole. The
 * machine's own side is the one exception, and it is not a close call. Over
 * three days of this manager's real chats, 859 machine lines were written and
 * 104 of them were drawn by default — of which 78 were the machine talking to
 * itself: which mode it is in, which model it pinned, an allowance window that
 * is open, an agent sent off and an agent home again. He cannot act on any of
 * it, and it buried the four lines he could (bw-6jq5).
 *
 * Off by audience rather than by family, because loudness was never the
 * question. A hook that refused HIS turn and a hook that fired on every prompt
 * are both routine by cause and are not remotely the same news; an agent that
 * FAILED is on this side of the line while the same agent finishing quietly is
 * not. One switch — the group at the top — hands him the whole machine side
 * back when he wants to know what it is doing.
 */
export const QUIET: ReadonlySet<KindId> = new Set<KindId>([audienceKind('machine')]);

/**
 * The rows this conversation draws. Everything a sent-off agent produced goes
 * with the call that sent it — its commands, its sentences and its thinking:
 * hiding the call and leaving the work it spawned standing loose in the
 * transcript would read as the agent doing that work itself (bw-7ks.22.2).
 */
export function showing(items: TranscriptItem[], off: ReadonlySet<KindId>): TranscriptItem[] {
  if (off.size === 0) return items;
  const gone = new Set<string>();
  const kept: TranscriptItem[] = [];
  for (const item of items) {
    const sentBy =
      item.kind === 'tool' || item.kind === 'message' || item.kind === 'thinking' ? item.parentId : null;
    const hidden = upward(kindOf(item)).some((id) => off.has(id)) || (sentBy !== null && gone.has(sentBy));
    if (hidden) gone.add(item.id);
    else kept.push(item);
  }
  return kept;
}

/** What the reader switched off last time, or the quiet start if he never has. */
export function remembered(): Set<KindId> {
  if (typeof localStorage === 'undefined') return new Set(QUIET);
  const held = localStorage.getItem(CHAT_FILTER);
  // Never been here: the machine's own side starts off, everything else on.
  if (held === null) return new Set(QUIET);
  try {
    const parsed = JSON.parse(held);
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    // A choice we cannot read is not worth losing a conversation over.
    return new Set(QUIET);
  }
}

/** Remember it. Written where it is changed, never mirrored from an effect. */
export function remember(off: ReadonlySet<KindId>): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(CHAT_FILTER, JSON.stringify(Array.from(off)));
}
