/**
 * An Atelier reference named in a message is something you can click, and a
 * card of the retired board is words.
 */
import { describe, expect, it } from 'vitest';

import { openableIn, rehypeMentions } from '@/workbench/mentions';

const WHERE = { cwd: '/p', home: '/h' };
const DISK = { real: () => false };
const split = (text: string) => openableIn(text, WHERE, DISK);

describe('what a message names', () => {
  it('makes a badge of a chat reference', () => {
    expect(split('see @chat:abc123 today')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'reference', ref: 'chat', id: 'abc123' },
      { kind: 'text', text: ' today' },
    ]);
  });

  it('leaves a card of the retired board as words', () => {
    expect(split('landed @bead:bw-4wcd.3 today').filter((p) => p.kind !== 'text')).toEqual([]);
    expect(split('landed bw-4wcd.3 today')).toEqual([{ kind: 'text', text: 'landed bw-4wcd.3 today' }]);
  });
});

describe('the rewriting step', () => {
  it('turns a reference in a paragraph into a span the page can draw', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'read @skill:standup' }] },
      ],
    };
    rehypeMentions(split)(tree);
    const para = tree.children[0] as { children: { type: string; properties?: Record<string, unknown> }[] };
    expect(para.children).toHaveLength(2);
    expect(para.children[1]!.properties).toEqual({
      'data-reference-mention': 'skill',
      'data-reference-id': 'standup',
      'data-copy': '@skill:standup',
    });
  });

  it('leaves a command alone, so it is still something to copy', () => {
    const tree = {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'pre',
          properties: {},
          children: [
            { type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: 'open @chat:abc123' }] },
          ],
        },
      ],
    };
    rehypeMentions(split)(tree);
    const pre = tree.children[0] as { children: { children: { type: string }[] }[] };
    expect(pre.children[0]!.children).toHaveLength(1);
    expect(pre.children[0]!.children[0]!.type).toBe('text');
  });

  it('leaves a link alone, because it already goes somewhere', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'a', properties: { href: '#' }, children: [{ type: 'text', value: '@chat:abc123' }] },
      ],
    };
    rehypeMentions(split)(tree);
    const link = tree.children[0] as { children: { type: string }[] };
    expect(link.children).toHaveLength(1);
    expect(link.children[0]!.type).toBe('text');
  });
});
