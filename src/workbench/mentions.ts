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
 *
 * ## Files are the exception to the fenced block
 *
 * A card id inside a command must stay dead text — chipping it would break the
 * command as something to copy. A file named inside a command is the opposite:
 * `cd /home/ahsan/dev/… && grep …` is exactly where addresses live, and it is
 * the one the reader most wants to open (bw-khe.13). So code and fenced blocks
 * suppress cards and reports, and let files through; what the chip draws is
 * still the reader's own words, so the command still copies as it was written.
 */
import { pathsIn, type OnDisk, type PathPiece, type Rooted } from '@/workbench/paths';

/** One stretch of a message: plain words, or something that opens. */
export type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'card'; id: string }
  | { kind: 'report'; slug: string }
  | PathPiece;

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

/**
 * Everything in a run of text a reader can open: the cards and reports it
 * names, and the files it names.
 *
 * Cards go first and files fill the gaps, so a token that is both an id on the
 * board and a name on disk opens the card — the board is the thing this app is
 * for, and a card is the rarer coincidence.
 */
export function openableIn(text: string, existing: Existing, where: Rooted, disk: OnDisk): Piece[] {
  const out: Piece[] = [];
  for (const piece of mentionsIn(text, existing)) {
    if (piece.kind !== 'text') {
      out.push(piece);
      continue;
    }
    for (const part of pathsIn(piece.text, where, disk)) {
      if (part.kind === 'text' && part.text === '') continue;
      out.push(part);
    }
  }
  return out.length > 0 ? out : [{ kind: 'text', text }];
}

/* ------------------------------------------------------------------ *
 * A name written out as a whole address.
 * ------------------------------------------------------------------ */

/** What an address of this app's own names. */
export type Addressed = { kind: 'card'; id: string } | { kind: 'report'; slug: string };

/** The spelling `card` used to have in an address, still written by older links. */
const OLD_CARD = 'bead';

/**
 * The card or report an address names, or nothing.
 *
 * An agent that has just written a report hands it over the way it would hand it
 * to somebody outside the app: the whole address, port and all. In prose that
 * becomes a link before anything here sees it, and a link is the one place a
 * mention is never looked for — so the thing in a message the reader most wants
 * to open was the one thing drawn as raw blue text (bw-8fh2.2).
 *
 * Only the shape of this app's own screen counts: `/project` carrying a `report`
 * or a `card`. Whether the thing it names exists is the caller's question, the
 * same as it is for a bare name, and that is what keeps somebody else's
 * `/project?card=…` from being drawn as one of ours.
 */
export function addressedBy(href: string): Addressed | null {
  let url: URL;
  try {
    // A base, because the address may be written relative — a link made inside
    // the app is `/project?…` and carries no host at all.
    url = new URL(href, 'http://beads.invalid');
  } catch {
    return null;
  }
  if (!/(^|\/)project\/?$/.test(url.pathname)) return null;
  // A card wins a tie: its panel is drawn OVER whichever tab the address asks
  // for, so it is what the reader would land on.
  const card = url.searchParams.get('card') ?? url.searchParams.get(OLD_CARD);
  if (card) return { kind: 'card', id: card };
  const report = url.searchParams.get('report');
  return report ? { kind: 'report', slug: report } : null;
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
 * Where nothing at all is a mention: inside a link that already goes somewhere.
 */
const NOT_PROSE = new Set(['a']);

/**
 * Where a card id is not a mention but a file still is: inside a fenced block
 * and inside inline code. Chipping a card id inside a command would break the
 * command as something to copy; the files named in that same command are the
 * reason the reader is looking at it.
 */
const ONLY_FILES = new Set(['code', 'pre']);

/**
 * The rendering step: every run of words in a message is looked at, and the
 * names in it become spans the page then draws as chips.
 *
 * A step rather than a component because there is no other way in — a message
 * is markdown, and its words are text nodes buried under whatever shape the
 * writer gave them: a paragraph, a bullet, a table cell, a heading.
 */
export function rehypeMentions(split: (text: string) => Piece[]) {
  return (tree: HastNode): void => rewrite(tree, split, false);
}

function rewrite(node: HastNode, split: (text: string) => Piece[], filesOnly: boolean): void {
  const kids = node.children;
  if (!Array.isArray(kids)) return;
  const out: HastNode[] = [];
  let changed = false;

  for (const kid of kids) {
    if (kid.type === 'element') {
      const tag = kid.tagName ?? '';
      if (!NOT_PROSE.has(tag)) rewrite(kid, split, filesOnly || ONLY_FILES.has(tag));
      out.push(kid);
      continue;
    }
    if (kid.type !== 'text' || typeof kid.value !== 'string') {
      out.push(kid);
      continue;
    }
    const pieces = filesOnly ? filesFrom(split(kid.value)) : split(kid.value);
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
      out.push(marker(piece));
    }
  }

  if (changed) node.children = out;
}

/** One piece, as the span the page then draws as a chip. */
function marker(piece: Exclude<Piece, { kind: 'text' }>): HastNode {
  if (piece.kind === 'path') {
    return {
      type: 'element',
      tagName: 'span',
      properties: {
        'data-path-mention': piece.absolute,
        ...(piece.line === null ? {} : { 'data-path-line': String(piece.line) }),
      },
      children: [{ type: 'text', value: piece.raw }],
    };
  }
  const name = piece.kind === 'card' ? piece.id : piece.slug;
  return {
    type: 'element',
    tagName: 'span',
    properties: piece.kind === 'card' ? { 'data-card-mention': name } : { 'data-report-mention': name },
    children: [{ type: 'text', value: name }],
  };
}

/**
 * The same split with the cards and reports put back into the words they came
 * from, for the inside of a command, where only a file opens.
 */
function filesFrom(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    if (piece.kind === 'path') {
      out.push(piece);
      continue;
    }
    const text = piece.kind === 'text' ? piece.text : piece.kind === 'card' ? piece.id : piece.slug;
    const last = out[out.length - 1];
    if (last && last.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + text };
    else out.push({ kind: 'text', text });
  }
  return out;
}
