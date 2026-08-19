/**
 * A card or a report NAMED in a message, turned into something you can click.
 *
 * An agent writes ids and report names into its prose all day — "landed
 * bw-4wcd.2", "the page is chat-interface-work" — and every one of them was
 * dead text: the reader had to copy it, leave the chat, and find it by hand
 * (bw-4wcd.3).
 *
 * ## Only things that exist
 *
 * English is full of hyphenated words that have the shape of a card id —
 * `follow-up`, `fast-forward`, `read-only`, `claude-opus` all match it — so
 * shape alone cannot decide. Nothing here becomes a chip unless the caller says
 * that exact id is on the board, or that exact name is a report this project
 * has. A lookup that knows nothing yields no chips and the text is left alone,
 * which is the right thing to draw while the board is still loading.
 *
 * This is a different question from the one `link-rules.ts` answers. That one
 * asks which cards a chat WORKED ON, and deliberately ignores mentions; this
 * one asks what a reader should be able to click, and mentions are the whole of
 * it. A chip here never puts a card on the chat's line.
 */

/** One stretch of a message: plain words, or something that opens. */
export type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'card'; id: string }
  | { kind: 'report'; slug: string };

/**
 * A word made of parts joined by dashes or dots — the shape both a card id and
 * a report's name have. Greedy on purpose: `notes-about-bw-7ks` is one token
 * and not a card, which is what stops a longer word being chipped in the middle.
 */
const TOKEN = /[a-z0-9]+(?:[-.][a-z0-9]+)+/g;

/** What the caller knows to exist. Either may say no to everything. */
export interface Existing {
  card(id: string): boolean;
  report(slug: string): boolean;
}

/**
 * One run of text, split into what it names.
 *
 * Always at least one piece, and a text with nothing in it comes back as
 * itself, so a caller can tell "nothing to do" by the length.
 */
export function mentionsIn(text: string, existing: Existing): Piece[] {
  const pieces: Piece[] = [];
  const scan = new RegExp(TOKEN.source, TOKEN.flags);
  let from = 0;
  let m: RegExpExecArray | null;

  while ((m = scan.exec(text)) !== null) {
    const token = m[0];
    const kind = existing.card(token) ? 'card' : existing.report(token) ? 'report' : null;
    if (!kind) continue;
    if (m.index > from) pieces.push({ kind: 'text', text: text.slice(from, m.index) });
    pieces.push(kind === 'card' ? { kind: 'card', id: token } : { kind: 'report', slug: token });
    from = m.index + token.length;
  }

  if (from < text.length || pieces.length === 0) pieces.push({ kind: 'text', text: text.slice(from) });
  return pieces;
}

/* ------------------------------------------------------------------ *
 * The same rule, as the step that rewrites a rendered message.
 * ------------------------------------------------------------------ */

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Where a name is not a mention: inside a fenced block, inside inline code, or
 * inside a link that already goes somewhere. Chipping a card id inside a
 * command would break the command as something to copy.
 */
const NOT_PROSE = new Set(['code', 'pre', 'a']);

/**
 * The rendering step: every run of words in a message is looked at, and the
 * names in it become spans the page then draws as chips.
 *
 * A step rather than a component because there is no other way in — a message
 * is markdown, and its words are text nodes buried under whatever shape the
 * writer gave them: a paragraph, a bullet, a table cell, a heading.
 */
export function rehypeMentions(split: (text: string) => Piece[]) {
  return (tree: HastNode): void => rewrite(tree, split);
}

function rewrite(node: HastNode, split: (text: string) => Piece[]): void {
  const kids = node.children;
  if (!Array.isArray(kids)) return;
  const out: HastNode[] = [];
  let changed = false;

  for (const kid of kids) {
    if (kid.type === 'element') {
      if (!NOT_PROSE.has(kid.tagName ?? '')) rewrite(kid, split);
      out.push(kid);
      continue;
    }
    if (kid.type !== 'text' || typeof kid.value !== 'string') {
      out.push(kid);
      continue;
    }
    const pieces = split(kid.value);
    if (pieces.length === 1 && pieces[0]!.kind === 'text') {
      out.push(kid);
      continue;
    }
    changed = true;
    for (const piece of pieces) {
      if (piece.kind === 'text') {
        if (piece.text) out.push({ type: 'text', value: piece.text });
        continue;
      }
      const name = piece.kind === 'card' ? piece.id : piece.slug;
      out.push({
        type: 'element',
        tagName: 'span',
        properties: piece.kind === 'card' ? { 'data-card-mention': name } : { 'data-report-mention': name },
        children: [{ type: 'text', value: name }],
      });
    }
  }

  if (changed) node.children = out;
}
