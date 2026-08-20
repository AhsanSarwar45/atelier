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
  CHAT_FILTER,
  COMMANDS,
  EVERYTHING,
  REPLIES,
  STATUS,
  THINKING,
  flip,
  kindOf,
  remember,
  remembered,
  showing,
  switchOf,
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
});

const ran = (name: string, parentId: string | null = null): TranscriptItem => ({
  kind: 'tool',
  id: id(),
  name,
  title: name,
  status: 'ok',
  seconds: 0,
  parentId,
  diff: null,
  input: {},
  output: null,
});

const thought = (): TranscriptItem => ({ kind: 'thinking', id: id(), text: 'hmm', done: true });

const noted = (): TranscriptItem => ({
  kind: 'note',
  id: id(),
  rank: 'note',
  noteKind: 'hook',
  text: 'a hook ran',
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

  it('reads a notice and a note as the same kind of line', () => {
    expect(kindOf(noted())).toBe(STATUS);
    expect(kindOf({ kind: 'notice', id: 'n', text: 'reconnected' })).toBe(STATUS);
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
    const off = flip(EVERYTHING, find(treeOf(items), THINKING));
    expect(showing(items, off).map(kindOf)).not.toContain(THINKING);
    expect(showing(items, off)).toHaveLength(items.length - 1);
  });

  it('hides only that tool’s rows when one tool goes', () => {
    const items = conversation();
    const off = flip(EVERYTHING, find(treeOf(items), toolKind('Read')));
    const left = showing(items, off).filter((i) => i.kind === 'tool');
    expect(left.map((i) => (i.kind === 'tool' ? i.name : ''))).toEqual(['Bash']);
  });

  it('hides everything under a group when the group goes', () => {
    const items = conversation();
    const off = flip(EVERYTHING, find(treeOf(items), COMMANDS));
    expect(showing(items, off).some((i) => i.kind === 'tool')).toBe(false);
    expect(showing(items, off)).toHaveLength(4);
  });

  it('gives the whole group back when it comes on again', () => {
    const items = conversation();
    let off = flip(EVERYTHING, find(treeOf(items), toolKind('Bash')));
    off = flip(off, find(treeOf(items), COMMANDS));
    off = flip(off, find(treeOf(items), COMMANDS));
    expect(showing(items, off)).toHaveLength(items.length);
  });

  it('leaves nothing showing when both sides go', () => {
    const items = conversation();
    let off = flip(EVERYTHING, find(treeOf(items), 'you'));
    off = flip(off, find(treeOf(items), 'agent'));
    expect(showing(items, off)).toHaveLength(0);
  });
});

describe('a command run inside another command', () => {
  it('goes when the command that spawned it goes', () => {
    const parent = ran('Task');
    const items = [parent, ran('Read', parent.id), said('assistant', 'done')];
    const off = flip(EVERYTHING, find(treeOf(items), toolKind('Task')));
    expect(showing(items, off).map((i) => i.kind)).toEqual(['message']);
  });

  it('stays when its own tool is the one switched off', () => {
    const parent = ran('Task');
    const items = [parent, ran('Read', parent.id)];
    const off = flip(EVERYTHING, find(treeOf(items), toolKind('Read')));
    expect(showing(items, off)).toHaveLength(1);
  });
});

describe('how a switch reads', () => {
  it('reads half when its children disagree', () => {
    const items = conversation();
    const off = flip(EVERYTHING, find(treeOf(items), toolKind('Read')));
    expect(switchOf(find(treeOf(items), COMMANDS), off)).toBe('half');
    expect(switchOf(find(treeOf(items), 'agent'), off)).toBe('half');
  });

  it('reads off for a child of a group that is off', () => {
    const items = conversation();
    const off = flip(EVERYTHING, find(treeOf(items), COMMANDS));
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
    const off = flip(EVERYTHING, find(treeOf(items), toolKind('Read')));
    const withNew = [...items, ran('WebFetch')];
    expect(showing(withNew, off).some((i) => i.kind === 'tool' && i.name === 'WebFetch')).toBe(true);
  });

  it('hides a tool that first appears while commands is off', () => {
    const items = conversation();
    const off = flip(EVERYTHING, find(treeOf(items), COMMANDS));
    const withNew = [...items, ran('WebFetch')];
    expect(showing(withNew, off).some((i) => i.kind === 'tool')).toBe(false);
  });

  it('comes back unchanged after the browser is closed and reopened', () => {
    const items = conversation();
    const off = flip(EVERYTHING, find(treeOf(items), COMMANDS));
    remember(off);
    expect(Array.from(remembered())).toEqual(Array.from(off));
  });

  it('starts with nothing off when he has never touched it', () => {
    expect(remembered().size).toBe(0);
  });

  it('starts with nothing off when what was stored cannot be read', () => {
    localStorage.setItem(CHAT_FILTER, 'not json');
    expect(remembered().size).toBe(0);
  });
});
