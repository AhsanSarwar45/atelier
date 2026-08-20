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
 *    conversation he thought he was reading whole.
 *  - Turning a group off hides everything under it and forgets what was off
 *    inside it, so turning the group back on gives him all of it back rather
 *    than whatever remained of it the last time he was in there.
 */
import type { TranscriptItem } from '@/workbench/use-session';

/** Where the reader's choice is remembered between visits. */
export const CHAT_FILTER = 'workbench.chat-filter';

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

export const labelOf = (id: KindId): string => (isTool(id) ? toolName(id) : (LABELS[id] ?? id));

/** The kind directly above this one, or null for the two at the top. */
export function above(id: KindId): KindId | null {
  if (isTool(id)) return COMMANDS;
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
    // A notice is the chat talking about itself in one grey line, which is the
    // same thing to a reader as a note however differently the two arrive.
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
  const tally = new Map<KindId, number>();
  for (const item of items) {
    const id = kindOf(item);
    tally.set(id, (tally.get(id) ?? 0) + 1);
  }

  const tools = Array.from(tally.keys())
    .filter(isTool)
    .sort((a, b) => toolName(a).localeCompare(toolName(b)))
    .map((id) => leaf(id, tally));

  const branches = UNDER_AGENT.map((id) =>
    id === COMMANDS ? group(COMMANDS, tools) : leaf(id, tally),
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
 */
export function flip(off: ReadonlySet<KindId>, node: KindNode): Set<KindId> {
  const next = new Set(off);
  const going = switchOf(node, off) !== 'off';
  for (const child of descend(node)) next.delete(child);
  next.delete(node.id);
  if (going) next.add(node.id);
  return next;
}

const descend = (node: KindNode): KindId[] =>
  node.children.flatMap((child) => [child.id, ...descend(child)]);

/** Nothing switched off — what the reader gets before he touches anything. */
export const EVERYTHING: ReadonlySet<KindId> = new Set<KindId>();

/**
 * The rows this conversation draws. A command run inside another command goes
 * with its parent: hiding the subagent's call and leaving the work it spawned
 * standing loose in the transcript would read as the agent doing that work
 * itself.
 */
export function showing(items: TranscriptItem[], off: ReadonlySet<KindId>): TranscriptItem[] {
  if (off.size === 0) return items;
  const gone = new Set<string>();
  const kept: TranscriptItem[] = [];
  for (const item of items) {
    const hidden =
      upward(kindOf(item)).some((id) => off.has(id)) ||
      (item.kind === 'tool' && item.parentId !== null && gone.has(item.parentId));
    if (hidden) gone.add(item.id);
    else kept.push(item);
  }
  return kept;
}

/** What the reader switched off last time, or nothing if he never has. */
export function remembered(): Set<KindId> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const held = JSON.parse(localStorage.getItem(CHAT_FILTER) ?? '[]');
    return new Set(Array.isArray(held) ? held.filter((id) => typeof id === 'string') : []);
  } catch {
    // A choice we cannot read is not worth losing a conversation over.
    return new Set();
  }
}

/** Remember it. Written where it is changed, never mirrored from an effect. */
export function remember(off: ReadonlySet<KindId>): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(CHAT_FILTER, JSON.stringify(Array.from(off)));
}
