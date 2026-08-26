/**
 * A card named in a message is something you can click — and
 * nothing else is.
 *
 * The trap this guards is English: `follow-up`, `read-only`, `fast-forward` and
 * `claude-opus` all have the exact shape of a card id, and a build that chipped
 * on shape alone would scatter dead links through every paragraph (bw-4wcd.3).
 */
import { describe, expect, it } from 'vitest';

import { addressedBy, mentionsIn, rehypeMentions, type Existing } from '@/workbench/mentions';

const BOARD: Existing = {
  card: (id) => ['bw-4wcd', 'bw-4wcd.3', 'bw-1u1'].includes(id),
};

const NOTHING: Existing = { card: () => false };

describe('what a message names', () => {
  it('makes a chip of a card that is on the board', () => {
    expect(mentionsIn('landed bw-4wcd.3 today', BOARD)).toEqual([
      { kind: 'text', text: 'landed ' },
      { kind: 'card', id: 'bw-4wcd.3' },
      { kind: 'text', text: ' today' },
    ]);
  });

  it('leaves ordinary hyphenated English alone', () => {
    const prose = 'a read-only follow-up on claude-opus, fast-forward only';
    expect(mentionsIn(prose, BOARD)).toEqual([{ kind: 'text', text: prose }]);
  });

  it('does not chip a longer word that merely contains an id', () => {
    expect(mentionsIn('notes-about-bw-1u1 is a file', BOARD)).toEqual([
      { kind: 'text', text: 'notes-about-bw-1u1 is a file' },
    ]);
  });

  it('chips nothing at all while the board is still unknown', () => {
    expect(mentionsIn('landed bw-4wcd.3 today', NOTHING)).toEqual([
      { kind: 'text', text: 'landed bw-4wcd.3 today' },
    ]);
  });

  it('finds every name in one run of words', () => {
    expect(mentionsIn('bw-1u1 and bw-4wcd', BOARD).filter((p) => p.kind !== 'text')).toHaveLength(2);
  });
});

describe('the rewriting step', () => {
  const split = (text: string) => mentionsIn(text, BOARD);

  it('turns a name in a paragraph into a span the page can draw', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'fixed bw-1u1' }] },
      ],
    };
    rehypeMentions(split)(tree);
    const para = tree.children[0] as { children: { type: string; properties?: Record<string, unknown> }[] };
    expect(para.children).toHaveLength(2);
    expect(para.children[1]!.properties).toEqual({ 'data-card-mention': 'bw-1u1' });
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
            { type: 'element', tagName: 'code', properties: {}, children: [{ type: 'text', value: 'bd show bw-1u1' }] },
          ],
        },
      ],
    };
    rehypeMentions(split)(tree);
    const pre = tree.children[0] as { children: { children: { type: string }[] }[] };
    expect(pre.children[0]!.children).toHaveLength(1);
    expect(pre.children[0]!.children[0]!.type).toBe('text');
  });

  // The words inside a link stay words here; what the link ITSELF names is a
  // separate question, answered by `addressedBy` when the page draws it.
  it('leaves a link alone, because it already goes somewhere', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'a', properties: { href: '#' }, children: [{ type: 'text', value: 'bw-1u1' }] },
      ],
    };
    rehypeMentions(split)(tree);
    const link = tree.children[0] as { children: { type: string }[] };
    expect(link.children).toHaveLength(1);
    expect(link.children[0]!.type).toBe('text');
  });
});

describe('an address written out in full', () => {
  /** What an address that names no project at all comes back as. */
  const HERE_CARD = { kind: 'card', id: 'bw-1u1', project: null };

  it('names the card it carries, however the address spells it', () => {
    expect(addressedBy('http://localhost:3008/project?id=p&card=bw-1u1')).toEqual({
      kind: 'card',
      id: 'bw-1u1',
      project: 'p',
    });
    expect(addressedBy('/project?id=p&bead=bw-1u1')).toEqual({ kind: 'card', id: 'bw-1u1', project: 'p' });
  });

  it('gives the card even when an address carries retired parameters', () => {
    expect(addressedBy('/project?tab=reports&report=a-report&card=bw-1u1')).toEqual({
      kind: 'card',
      id: 'bw-1u1',
      project: null,
    });
  });

  it('names nothing in an address that is not one of ours', () => {
    expect(addressedBy('https://github.com/gastownhall/beads/issues/1')).toBeNull();
    expect(addressedBy('http://127.0.0.1:3008/project?id=p&tab=board')).toBeNull();
    expect(addressedBy('not an address at all')).toBeNull();
  });

  // This app is served from the reader's own computer and nowhere else, so a
  // link leaving for another machine is somebody else's however much its shape
  // matches — and swallowing it would navigate inside this window to a card
  // that merely shares an id (bw-8fh2.4).
  it('names nothing on another machine, whatever the shape of it', () => {
    expect(addressedBy('https://example.com/project?id=p&card=bw-1u1')).toBeNull();
    expect(addressedBy('https://beads-web.example.org/project?tab=reports&report=a-report')).toBeNull();
    expect(addressedBy('ftp://localhost/project?card=bw-1u1')).toBeNull();
  });

  // Card ids repeat across boards, so which board an address asks for is the
  // difference between the right card and a silent wrong one (bw-8fh2.8).
  it('carries the project it asks for, so a chat can refuse another one', () => {
    expect(addressedBy('http://127.0.0.1:3008/project?id=other-board&card=bw-3')).toEqual({
      kind: 'card',
      id: 'bw-3',
      project: 'other-board',
    });
  });

  it('reads the reader’s own machine by any of its names, on any port', () => {
    expect(addressedBy('http://localhost:3008/project?card=bw-1u1')).toEqual(HERE_CARD);
    expect(addressedBy('http://127.0.0.1:3027/project?card=bw-1u1')).toEqual(HERE_CARD);
    expect(addressedBy('http://[::1]:3008/project?card=bw-1u1')).toEqual(HERE_CARD);
  });
});
