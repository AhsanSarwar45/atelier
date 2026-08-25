/**
 * The reader switches kinds of message off, and the conversation obeys.
 *
 * The rules worth guarding are the two that make a tree behave like a tree:
 * what is remembered is what he switched OFF, so anything new arrives visible;
 * and a group carries everything under it, so turning it back on returns the
 * whole of it (bw-qdim.4).
 */
import { describe, expect, it, beforeEach } from 'vitest';

import {
  above,
  AGENT,
  CHAT_FILTER,
  COMMANDS,
  EVERYTHING,
  REPLIES,
  STATUS,
  THINKING,
  flip,
  hisDoing,
  kindOf,
  remember,
  remembered,
  showing,
  switchOf,
  QUIET,
  audienceKind,
  statusKind,
  statusOf,
  toolKind,
  treeOf,
} from '@/workbench/message-filter';
import type { KindNode } from '@/workbench/message-filter';
import type { TranscriptItem } from '@/workbench/use-session';

let next = 0;
const id = () => `i${++next}`;

const said = (role: 'user' | 'assistant', text: string): TranscriptItem => ({
  kind: 'message',
  id: id(),
  role,
  text,
  images: [],
  done: true,
  parentId: null,
});

const ran = (name: string, parentId: string | null = null): TranscriptItem => ({
  kind: 'tool',
  id: id(),
  name,
  title: name,
  status: 'ok',
  seconds: 0,
  summary: null,
  parentId,
  diff: null,
  input: {},
  output: null,
});

const thought = (): TranscriptItem => ({ kind: 'thinking', id: id(), text: 'hmm', done: true, parentId: null });

const noted = (): TranscriptItem => ({
  kind: 'note',
  id: id(),
  rank: 'note',
  noteKind: 'hook',
  text: 'a hook ran',
  body: null,
});

const filed = (): TranscriptItem => ({
  kind: 'note',
  id: id(),
  rank: 'detail',
  noteKind: 'hook',
  text: 'a quiet line only Show everything ever draws',
  body: null,
});

/** An interrupt, which is the machine talking and is meant for him. */
const stopped = (): TranscriptItem => ({
  kind: 'note',
  id: id(),
  rank: 'note',
  noteKind: 'user/synthetic',
  text: '[Request interrupted by user]',
  body: null,
});

/** A conversation with something of every kind in it. */
const conversation = (): TranscriptItem[] => [
  said('user', 'do the thing'),
  thought(),
  ran('Read'),
  ran('Bash'),
  ran('Read'),
  noted(),
  said('assistant', 'done'),
];

const findOrNull = (nodes: KindNode[], want: string): KindNode | null => {
  for (const node of nodes) {
    if (node.id === want) return node;
    const deeper = findOrNull(node.children, want);
    if (deeper) return deeper;
  }
  return null;
};

const find = (nodes: KindNode[], want: string): KindNode => {
  const found = findOrNull(nodes, want);
  if (!found) throw new Error(`no ${want} in the tree`);
  return found;
};

/**
 * Flip one switch of this conversation's tree. The whole tree goes in with it,
 * because turning a tool back on has to say what becomes of its neighbours.
 */
const flipped = (off: ReadonlySet<string>, items: TranscriptItem[], want: string): Set<string> => {
  const tree = treeOf(items);
  return flip(off, find(tree, want), tree);
};

beforeEach(() => {
  next = 0;
  localStorage.clear();
});

describe('which switch a row answers to', () => {
  it('puts what he typed under him and what it said under the agent', () => {
    expect(kindOf(said('user', 'hi'))).toBe('you');
    expect(kindOf(said('assistant', 'hello'))).toBe(REPLIES);
  });

  it('gives every command its own tool’s switch', () => {
    expect(kindOf(ran('Edit'))).toBe(toolKind('Edit'));
  });

  it('reads a notice and a note as status lines, each under its own kind', () => {
    expect(kindOf(noted())).toBe(statusOf('machine', 'background', 'hook'));
    expect(kindOf({ kind: 'notice', id: 'n', text: 'reconnected' })).toBe(
      statusOf('machine', 'background', 'app/notice'),
    );
    // Its kind sits under its family, the family under who it is for, and that
    // under status lines.
    expect(above(kindOf(noted()))).toBe(statusKind('machine', 'background'));
    expect(above(statusKind('machine', 'background'))).toBe(audienceKind('machine'));
    expect(above(audienceKind('machine'))).toBe(STATUS);
  });

  it('reads a line the kit wrote in his name as the machine talking, not as him', () => {
    // The complaint this job began with: stopping a turn put
    // "[Request interrupted by user]" on the page wearing his own colour.
    expect(kindOf(said('user', '[Request interrupted by user]'))).toBe(
      statusOf('you', 'stopped', 'user/synthetic'),
    );
    expect(kindOf(said('user', 'do the thing'))).toBe('you');
  });
});

describe('the tree of one conversation', () => {
  it('holds one entry per tool it actually used, by name', () => {
    const tools = find(treeOf(conversation()), COMMANDS).children.map((c) => c.label);
    expect(tools).toEqual(['Bash', 'Read']);
  });

  it('counts a group as the sum of its children', () => {
    const commands = find(treeOf(conversation()), COMMANDS);
    expect(commands.children.map((c) => c.count)).toEqual([1, 2]);
    expect(commands.count).toBe(3);
  });

  it('counts the agent’s whole side of the conversation', () => {
    // Everything but the one line he typed: thinking, three commands, a note
    // and the reply.
    expect(find(treeOf(conversation()), 'agent').count).toBe(6);
  });
});

describe('switching kinds off', () => {
  it('hides only its own rows when one kind goes', () => {
    const items = conversation();
    const off = flipped(EVERYTHING, items, THINKING);
    expect(showing(items, off).map(kindOf)).not.toContain(THINKING);
    expect(showing(items, off)).toHaveLength(items.length - 1);
  });

  it('hides only that tool’s rows when one tool goes', () => {
    const items = conversation();
    const off = flipped(EVERYTHING, items, toolKind('Read'));
    const left = showing(items, off).filter((i) => i.kind === 'tool');
    expect(left.map((i) => (i.kind === 'tool' ? i.name : ''))).toEqual(['Bash']);
  });

  it('hides everything under a group when the group goes', () => {
    const items = conversation();
    const off = flipped(EVERYTHING, items, COMMANDS);
    expect(showing(items, off).some((i) => i.kind === 'tool')).toBe(false);
    expect(showing(items, off)).toHaveLength(4);
  });

  it('gives the whole group back when it comes on again', () => {
    const items = conversation();
    let off = flipped(EVERYTHING, items, toolKind('Bash'));
    off = flipped(off, items, COMMANDS);
    off = flipped(off, items, COMMANDS);
    expect(showing(items, off)).toHaveLength(items.length);
  });

  it('leaves nothing showing when both sides go', () => {
    const items = conversation();
    let off = flipped(EVERYTHING, items, 'you');
    off = flipped(off, items, 'agent');
    expect(showing(items, off)).toHaveLength(0);
  });
});

describe('a command run inside another command', () => {
  it('goes when the command that spawned it goes', () => {
    const parent = ran('Task');
    const items = [parent, ran('Read', parent.id), said('assistant', 'done')];
    const off = flipped(EVERYTHING, items, toolKind('Task'));
    expect(showing(items, off).map((i) => i.kind)).toEqual(['message']);
  });

  it('stays when its own tool is the one switched off', () => {
    const parent = ran('Task');
    const items = [parent, ran('Read', parent.id)];
    const off = flipped(EVERYTHING, items, toolKind('Read'));
    expect(showing(items, off)).toHaveLength(1);
  });

  // The count beside Commands is the reader's price for turning it off, so it
  // has to count the same rows the conversation draws. An indented row is
  // drawn like any other and the tree counts it like any other; a check that
  // reads only the rows at the top compares two different sets (bw-qdim.12).
  it('is counted like any other command, because it is drawn like one', () => {
    const parent = ran('Task');
    const items = [parent, ran('Read', parent.id), ran('Read')];
    const tree = treeOf(items);
    expect(find(tree, COMMANDS).count).toBe(3);
    expect(find(tree, toolKind('Read')).count).toBe(2);
    expect(showing(items, EVERYTHING)).toHaveLength(3);
  });
});

describe('how a switch reads', () => {
  it('reads half when its children disagree', () => {
    const items = conversation();
    const off = flipped(EVERYTHING, items, toolKind('Read'));
    expect(switchOf(find(treeOf(items), COMMANDS), off)).toBe('half');
    expect(switchOf(find(treeOf(items), 'agent'), off)).toBe('half');
  });

  it('reads off for a child of a group that is off', () => {
    const items = conversation();
    const off = flipped(EVERYTHING, items, COMMANDS);
    expect(switchOf(find(treeOf(items), toolKind('Bash')), off)).toBe('off');
  });

  it('reads on when nothing has been touched', () => {
    const items = conversation();
    expect(switchOf(find(treeOf(items), 'agent'), EVERYTHING)).toBe('on');
  });
});

describe('what is remembered', () => {
  it('shows a tool nobody has ever seen before', () => {
    const items = conversation();
    const off = flipped(EVERYTHING, items, toolKind('Read'));
    const withNew = [...items, ran('WebFetch')];
    expect(showing(withNew, off).some((i) => i.kind === 'tool' && i.name === 'WebFetch')).toBe(true);
  });

  it('hides a tool that first appears while commands is off', () => {
    const items = conversation();
    const off = flipped(EVERYTHING, items, COMMANDS);
    const withNew = [...items, ran('WebFetch')];
    expect(showing(withNew, off).some((i) => i.kind === 'tool')).toBe(false);
  });

  it('comes back unchanged after the browser is closed and reopened', () => {
    const items = conversation();
    const off = flipped(EVERYTHING, items, COMMANDS);
    remember(off);
    expect(Array.from(remembered())).toEqual(Array.from(off));
  });

  it('starts with the machine’s own side off and nothing else', () => {
    expect(remembered()).toEqual(new Set(QUIET));
    expect(remembered().has(audienceKind('machine'))).toBe(true);
    expect(remembered().has(audienceKind('you'))).toBe(false);
  });

  it('starts the same way when what was stored cannot be read', () => {
    localStorage.setItem(CHAT_FILTER, 'not json');
    expect(remembered()).toEqual(new Set(QUIET));
  });

  it('keeps an empty answer once he has switched the machine’s side back on', () => {
    // Stored and empty is not the same as never stored: he asked for all of it.
    localStorage.setItem(CHAT_FILTER, '[]');
    expect(remembered().size).toBe(0);
  });
});

describe('a switch inside a group that is off', () => {
  it('turns its own rows back on and leaves the rest of the group off', () => {
    const items = conversation();
    const off = flipped(flipped(EVERYTHING, items, COMMANDS), items, toolKind('Bash'));
    const drawn = showing(items, off);
    expect(drawn.filter((i) => i.kind === 'tool').map((i) => (i.kind === 'tool' ? i.name : ''))).toEqual(['Bash']);
  });

  it('changes something — a click on it is never a no-op', () => {
    const items = conversation();
    const group = flipped(EVERYTHING, items, COMMANDS);
    const after = flipped(group, items, toolKind('Bash'));
    expect(Array.from(after).sort()).not.toEqual(Array.from(group).sort());
  });

  it('leaves the group reading half-on', () => {
    const items = conversation();
    const off = flipped(flipped(EVERYTHING, items, COMMANDS), items, toolKind('Bash'));
    expect(switchOf(find(treeOf(items), COMMANDS), off)).toBe('half');
  });

  it('opens every group above it, not only the nearest', () => {
    const items = conversation();
    const off = flipped(flipped(EVERYTHING, items, AGENT), items, toolKind('Bash'));
    const drawn = showing(items, off);
    expect(drawn.filter((i) => i.kind === 'tool').map((i) => (i.kind === 'tool' ? i.name : ''))).toEqual(['Bash']);
    expect(drawn.some((i) => i.kind === 'thinking')).toBe(false);
    expect(drawn.some((i) => i.kind === 'message' && i.role === 'assistant')).toBe(false);
  });
});

describe('what a count is counting', () => {
  it('counts the lines as the page draws them, a folded run once', () => {
    // Two quiet lines in a row are one chip with a 2 on it, and a count of 2
    // beside a switch that removes one row would misprice what it costs him.
    const items = [...conversation(), filed(), filed()];
    const tree = treeOf(items);
    expect(find(tree, STATUS).count).toBe(2);
    expect(find(tree, AGENT).count).toBe(find(tree, AGENT).children.reduce((n, c) => n + c.count, 0));
  });

  it('splits status lines by who they are for, then by family, then by kind', () => {
    const items = [...conversation(), filed(), filed(), stopped()];
    const under = find(treeOf(items), STATUS).children;
    expect(under.map((c) => c.id)).toEqual([audienceKind('you'), audienceKind('machine')]);
    expect(under.flatMap((c) => c.children.map((f) => f.id))).toEqual([
      statusKind('you', 'stopped'),
      statusKind('machine', 'background'),
      statusKind('machine', 'breathing'),
    ]);
    expect(under.flatMap((c) => c.children.flatMap((f) => f.children.map((k) => k.id)))).toEqual([
      statusOf('you', 'stopped', 'user/synthetic'),
      statusOf('machine', 'background', 'hook'),
      statusOf('machine', 'breathing', 'hook'),
    ]);
    // His one line against the machine's three, folded to two rows.
    expect(under.map((c) => c.count)).toEqual([1, 2]);
  });

  it('draws an audience with nothing in it rather than leaving a hole', () => {
    // A chat whose machine said nothing must not look like a chat whose machine
    // side has gone missing: the group is where he goes to check (bw-6jq5).
    const under = find(treeOf(conversation().filter((i) => i.kind !== 'note')), STATUS).children;
    expect(under.map((c) => c.id)).toEqual([audienceKind('you'), audienceKind('machine')]);
    expect(under.map((c) => c.count)).toEqual([0, 0]);
  });

  it('switches one family off and leaves the other standing', () => {
    const items = [...conversation(), filed(), filed()];
    const off = flipped(EVERYTHING, items, statusKind('machine', 'breathing'));
    const drawn = showing(items, off);
    expect(drawn.some((i) => i.kind === 'note' && i.rank === 'detail')).toBe(false);
    expect(drawn.some((i) => i.kind === 'note' && i.rank === 'note')).toBe(true);
  });

  it('switches one kind off and leaves the rest of its family standing', () => {
    const items = [...conversation(), filed(), stopped()];
    const off = flipped(EVERYTHING, items, statusOf('you', 'stopped', 'user/synthetic'));
    const drawn = showing(items, off);
    expect(drawn.some((i) => i.kind === 'note' && i.noteKind === 'user/synthetic')).toBe(false);
    expect(drawn.some((i) => i.kind === 'note' && i.noteKind === 'hook')).toBe(true);
  });

  it('draws nothing of the machine’s own before he has touched anything, and everything of his', () => {
    // The whole job in one line: the loud hook note is the machine's business
    // and goes, the interrupt is his and stays. Loudness decided this before
    // (bw-6jq5).
    const items = [...conversation(), filed(), stopped()];
    const drawn = showing(items, remembered());
    expect(drawn.some((i) => i.kind === 'note' && i.noteKind === 'hook')).toBe(false);
    expect(drawn.some((i) => i.kind === 'note' && i.noteKind === 'user/synthetic')).toBe(true);
  });

  it('gives the machine’s whole side back in one switch', () => {
    const items = [...conversation(), filed(), stopped()];
    const off = flipped(remembered(), items, audienceKind('machine'));
    expect(showing(items, off)).toHaveLength(items.length);
  });

  it('keeps every other kind exactly as it was', () => {
    const items = [...conversation(), filed()];
    const tree = treeOf(items);
    expect(find(tree, COMMANDS).count).toBe(3);
    expect(find(tree, 'you').count).toBe(1);
  });
});

describe('when nothing is left standing', () => {
  it('says nothing to a reader who has switched nothing off', () => {
    // A chat that has only just opened holds the machine's own start-up lines
    // and nothing else, and the quiet start hides those for him. Told he had
    // switched every row off, he was being accused of filtering a conversation
    // he had not read a word of (bw-aqpc).
    const items = [filed(), filed()];
    expect(showing(items, remembered())).toHaveLength(0);
    expect(hisDoing(items, remembered())).toBe(false);
  });

  it('speaks the moment he switches his last kind off himself', () => {
    const items = conversation();
    let off = flipped(EVERYTHING, items, 'you');
    off = flipped(off, items, AGENT);
    expect(showing(items, off)).toHaveLength(0);
    expect(hisDoing(items, off)).toBe(true);
  });

  it('speaks for a kind he switched off on top of the quiet start', () => {
    // His own line and a machine line: the machine's went by default, his went
    // because he said so, and what is left is an empty window he made.
    const items = [said('user', 'go'), filed()];
    const off = flipped(remembered(), items, 'you');
    expect(showing(items, off)).toHaveLength(0);
    expect(hisDoing(items, off)).toBe(true);
  });

  it('stays quiet for a row hidden by the group the quiet start switched off', () => {
    // Switched off by his own hand this time, which is the same entry the app
    // writes for him: there is nothing to tell apart, and nothing to say.
    const items = [filed(), stopped()];
    const off = flipped(EVERYTHING, items, audienceKind('machine'));
    expect(hisDoing(items, off)).toBe(false);
  });
});
