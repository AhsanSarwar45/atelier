/**
 * What a message names, turned into something you can click: files, and
 * Atelier's own references (`@chat:…`, `@skill:…`, `@task:…`, `@diff:…`).
 *
 * ## Files inside code
 *
 * A file named inside a command is where addresses live — `cd /home/dev/… &&
 * grep …` — and it is the one the reader most wants to open (bw-khe.13). So
 * code and fenced blocks let files through and suppress references; what the
 * chip draws is still the reader's own words, so the command still copies as
 * it was written.
 */
import { askableIn, pathsIn, resolveEach, resolveReal, type OnDisk, type PathPiece, type Rooted } from '@/workbench/paths';
import { findAtelierReferences, findReferences, formatAtelierReference, formatReference, referenceLabel, type AtelierKind } from '@/workbench/references';

/** One stretch of a message: plain words, or something that opens. */
export type Piece =
  | { kind: 'text'; text: string }
  | { kind: 'reference'; ref: AtelierKind; id: string }
  | { kind: 'attachment'; index: number }
  | PathPiece;

/**
 * Where an attachment sat in the sentence it was attached to.
 *
 * The writing box shows an attachment as a chip standing in the words; this is
 * how that chip survives sending. The sender writes one of these markers into
 * the message text at the offset the attachment was dropped at, and the same
 * rewriting step that turns a reference into a chip turns this into the same
 * chip — so it flows with the words instead of breaking the line, and every
 * provider gets it from the one path (bw-oamr.4).
 */
const ATTACHMENT = /\[\[atelier-attachment:(\d+)\]\]/g;

/** The marker for the nth attachment on a message, to write into its text. */
export function attachmentMarker(index: number): string {
  return `[[atelier-attachment:${index}]]`;
}

/** One split with the attachment markers in it pulled out as their own pieces. */
export function attachmentsIn(text: string, split: (text: string) => Piece[]): Piece[] {
  const out: Piece[] = [];
  let from = 0;
  const marks = new RegExp(ATTACHMENT.source, ATTACHMENT.flags);
  let match: RegExpExecArray | null;
  while ((match = marks.exec(text)) !== null) {
    if (match.index > from) out.push(...split(text.slice(from, match.index)));
    out.push({ kind: 'attachment', index: Number(match[1]) });
    from = marks.lastIndex;
  }
  if (out.length === 0) return split(text);
  if (from < text.length) out.push(...split(text.slice(from)));
  return out;
}

/**
 * Everything in a run of text a reader can open: the Atelier references it
 * writes, and the files it names.
 */
export function openableIn(text: string, where: Rooted, disk: OnDisk): Piece[] {
  // An Atelier reference is named on purpose — `@chat:…`, `@skill:…` — so it
  // is a badge, and the rest of the words are read around it (bw-mi3s.1).
  const atelier = findAtelierReferences(text);
  if (atelier.length === 0) return files(text, where, disk);
  const out: Piece[] = [];
  let from = 0;
  for (const ref of atelier) {
    if (ref.start > from) out.push(...files(text.slice(from, ref.start), where, disk));
    out.push({ kind: 'reference', ref: ref.kind, id: ref.id });
    from = ref.end;
  }
  if (from < text.length) out.push(...files(text.slice(from), where, disk));
  return out;
}

function files(text: string, where: Rooted, disk: OnDisk): Piece[] {
  const out: Piece[] = [];
  let from = 0;

  // A reference goes first and takes its whole span with it. The writer put the
  // `@` there to say "this file, these lines"; nothing else in the text gets a
  // say about those characters, and the badge it becomes carries a range no
  // bare path can (`references.ts`).
  for (const found of findReferences(text)) {
    const absolute = resolveReal(found.path, where, disk);
    if (!absolute) continue;
    if (found.start > from) pushAll(out, text.slice(from, found.start), where, disk);
    out.push({
      kind: 'path',
      // Drawn in our own form, without the `@`: whatever shape it was written
      // in, the reader is shown the one shape.
      raw: referenceLabel(found),
      absolute,
      line: found.line,
      endLine: found.endLine,
      copy: formatReference(found),
    });
    from = found.end;
  }
  if (from < text.length) pushAll(out, text.slice(from), where, disk);

  return out.length > 0 ? out : [{ kind: 'text', text }];
}

/** The bare paths of one run of words, added to what is there. */
function pushAll(out: Piece[], text: string, where: Rooted, disk: OnDisk): void {
  for (const part of pathsIn(text, where, disk)) {
    if (part.kind === 'text' && part.text === '') continue;
    out.push(part);
  }
}

/**
 * Every address a run of text might be naming — the bare ones and the ones
 * written as references — resolved, whether or not they are real. What to go
 * and ask disk about, so the answers are back before the reader looks.
 */
export function openableAsks(text: string, where: Rooted): string[] {
  const out = new Set<string>(askableIn(text, where));
  for (const found of findReferences(text)) {
    for (const absolute of resolveEach(found.path, where)) out.add(absolute);
  }
  return Array.from(out);
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
 * Where a reference is not a mention but a file still is: inside code, fenced
 * or inline. Chipping a reference inside a command would break the command as
 * something to copy, and a badge of any kind inside code breaks the code as
 * something to read across — the owner's rule is that nothing inside code is
 * turned into a badge, anywhere (bw-lolf.1).
 */
const ONLY_FILES = new Set(['pre', 'code']);

/**
 * The rendering step: every run of words in a message is looked at, and the
 * names in it become spans the page then draws as chips.
 *
 * A step rather than a component because there is no other way in — a message
 * is markdown, and its words are text nodes buried under whatever shape the
 * writer gave them: a paragraph, a bullet, a table cell, a heading.
 *
 * A file is a file wherever a message writes one — including inside a fenced
 * block and inside inline code, which is where an agent writes MOST of them, so
 * it opens from there too (bw-1e2e.1). Inline code that is nothing but a file is
 * the badge (`soleFile`). Anywhere else inside code it is marked as being there,
 * and drawn as the plain underlined link rather than a badge: a capsule through
 * the middle of a command is a command nobody can read or copy (bw-lolf.1). That is the same link the collapsed line of an activity row and
 * the file line of an edit card already draw (`paths-in-html.ts`).
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
      const sole = filesOnly ? null : soleFile(kid, split);
      if (sole) {
        out.push(marker(sole, false));
        changed = true;
        continue;
      }
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
      out.push(marker(piece, filesOnly));
    }
  }

  if (changed) node.children = out;
}

/**
 * The file an inline `code` in the words is, when that is all it is.
 *
 * Quoting a file name in backticks is how an agent writes most of them in a
 * sentence, and there it is a name, not a command: nothing around it to read
 * across or copy. So it is drawn as the badge a file in the words is, in place
 * of the code. A file inside a longer quote or a fenced block stays the link
 * (bw-lolf.1).
 */
function soleFile(node: HastNode, split: (text: string) => Piece[]): Extract<Piece, { kind: 'path' }> | null {
  if (node.tagName !== 'code') return null;
  const kids = node.children ?? [];
  if (kids.length !== 1 || kids[0]!.type !== 'text' || typeof kids[0]!.value !== 'string') return null;
  const pieces = filesFrom(split(kids[0]!.value));
  const only = pieces.length === 1 ? pieces[0]! : null;
  return only && only.kind === 'path' ? only : null;
}

/**
 * One piece, as the span the page then draws as a chip. Each carries the text
 * it stands for in `data-copy`, so copying a message gives back what was
 * written, `@src/a.ts:3-9` and not the chip's label (`copyWritten`).
 */
function marker(piece: Exclude<Piece, { kind: 'text' }>, inCode: boolean): HastNode {
  if (piece.kind === 'attachment') {
    return {
      type: 'element',
      tagName: 'span',
      properties: { 'data-attachment-mention': String(piece.index) },
      children: [],
    };
  }
  if (piece.kind === 'path') {
    return {
      type: 'element',
      tagName: 'span',
      properties: {
        'data-path-mention': piece.absolute,
        ...(piece.line === null ? {} : { 'data-path-line': String(piece.line) }),
        ...(piece.line === null || piece.endLine === null
          ? {}
          : { 'data-path-range': `${piece.line}-${piece.endLine}` }),
        ...(inCode ? { 'data-path-in-code': '' } : {}),
        'data-copy': piece.copy ?? piece.raw,
      },
      children: [{ type: 'text', value: piece.raw }],
    };
  }
  return {
    type: 'element',
    tagName: 'span',
    properties: { 'data-reference-mention': piece.ref, 'data-reference-id': piece.id, 'data-copy': formatAtelierReference(piece.ref, piece.id) },
    // A bare `@task` has no id to stand in for it.
    children: [{ type: 'text', value: piece.id || formatAtelierReference(piece.ref, piece.id) }],
  };
}

/**
 * The same split with the references put back into the words they came
 * from, for the inside of a command, where only a file opens.
 */
function filesFrom(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const piece of pieces) {
    if (piece.kind === 'path' || piece.kind === 'attachment') {
      out.push(piece);
      continue;
    }
    const text = piece.kind === 'text' ? piece.text : formatAtelierReference(piece.ref, piece.id);
    const last = out[out.length - 1];
    if (last && last.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + text };
    else out.push({ kind: 'text', text });
  }
  return out;
}
