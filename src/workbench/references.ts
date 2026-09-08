/**
 * A file reference — `@path:12-40` — written down once.
 *
 * A reference is the one thing this app says "that file, those lines" with. It
 * is what copying from a diff puts on the clipboard, what typing `@` in the
 * composer inserts, what the composer draws as a badge, and what the transcript
 * draws as a badge that opens the file (bw-gr8y). All four have to agree about
 * what a reference IS, so the grammar lives here and nowhere else, as plain
 * functions with no React and no disk in them.
 *
 * ## What we write, and what we read
 *
 * We write `@path:12-40`. That is the form the manager chose: it is what an
 * agent already writes in prose (`src/paths.ts:42`), so a reference reads as a
 * sentence rather than as markup.
 *
 * We READ more than we write, because the reader's other tools write other
 * things. Claude Code's IDE plugins insert `@file#L12-L40` (JetBrains) and
 * `@file#5-10` (VS Code); Codex inserts the bare path. Pasting any of those in
 * must give the same badge as our own form, so all of them parse and only ours
 * is ever produced (`formatReference`).
 *
 * ## What is deliberately NOT a reference
 *
 * `@` is the busiest character in a chat. An email address, a handle, a lone
 * `@` in `email me @ home`, a scoped package: none of them are files. Two rules
 * do most of that work — a reference starts a word, so an `@` with a letter
 * before it is inside something else, which is what an email address is; and a
 * path may not contain whitespace unless it was quoted. Whether the thing it
 * names is really on disk is somebody else's question, answered the same way it
 * is for a bare path (`paths.ts`, `paths-on-disk.ts`).
 */
import { resolvePath, type Rooted } from '@/workbench/paths';

/** What a reference names: a place on disk, and the lines of it that matter. */
export interface Reference {
  /** The path as written, without the `@` and without the line numbers. */
  path: string;
  /** The first line named, or null when no lines were named. */
  line: number | null;
  /** The last line of a range. Null for a single line, and for no line. */
  endLine: number | null;
  /** A trailing slash means a folder, which has no lines and opens as one. */
  kind: 'file' | 'folder';
}

/** A reference found inside a larger text, and where in it it sits. */
export interface FoundReference extends Reference {
  /** The index of the `@`. */
  start: number;
  /** One past the last character of the reference. */
  end: number;
  /** Exactly the characters between those two, as they were written. */
  raw: string;
}

/**
 * What a sentence puts after a reference and never means as part of it. The
 * same list `paths.ts` uses, so `(@src/a.ts:3-9).` ends where a reader would say
 * it ends. A `:` is on the list, which is why the lines are peeled off AFTER
 * this runs and not before: `@a.ts:` names no line, `@a.ts:12` names line 12.
 */
const TRAILING = /[.,;:!?)\]}'"`>]+$/;

/**
 * What may sit immediately before the `@`. Nothing, or something that ends a
 * word: whitespace, or the punctuation a sentence opens a parenthesis with. A
 * letter, a digit, a dot or a slash before it means the `@` is INSIDE something
 * — `user@host`, `node_modules/@types` — and not a reference at all.
 */
const BEFORE = /[\s([{<'"`,;:!?~=]/;

/** The first character of a path. Excludes the punctuation a sentence uses. */
const PATH_STARTS = /[A-Za-z0-9_.~/\\@$%+-]/;

/** `#L12-L40` and `#L12`, as Claude Code's JetBrains plugin writes them. */
const HASH_LINES = /#L(\d+)(?:-L?(\d+))?$/;
/** `#12-40` and `#12`, as its VS Code plugin writes them. */
const HASH_NUMBERS = /#(\d+)(?:-(\d+))?$/;
/** `:12-40`, `:12`, and `:12:7` — the column nobody opens on. */
const COLON_LINES = /:(\d+)(?:-(\d+)|:\d+)?$/;

/** The lines peeled off the end of a token, and the path that is left. */
function peelLines(token: string): { path: string; line: number | null; endLine: number | null } {
  for (const shape of [HASH_LINES, HASH_NUMBERS, COLON_LINES]) {
    const at = shape.exec(token);
    if (!at) continue;
    const line = Number(at[1]);
    const last = at[2] === undefined ? null : Number(at[2]);
    return { path: token.slice(0, at.index), line, endLine: last === line ? null : last };
  }
  return { path: token, line: null, endLine: null };
}

/** One path-and-lines, once the `@` and any quotes are off it, as a reference. */
function referenceOf(body: string): Reference | null {
  const token = body.replace(TRAILING, '');
  if (!token) return null;

  const { path, line, endLine } = peelLines(token);
  if (!path || !PATH_STARTS.test(path[0]!)) return null;

  // A trailing slash is the writer saying "the folder", which has no lines. The
  // slash itself is not kept — `formatReference` puts it back — except on the
  // root folder, which IS its slash.
  if (path.endsWith('/')) {
    return {
      path: path.length > 1 ? path.slice(0, -1) : path,
      line: null,
      endLine: null,
      kind: 'folder',
    };
  }
  return { path, line, endLine, kind: 'file' };
}

/** How far a reference beginning at `at` reaches, and what it names. */
function matchAt(text: string, at: number): FoundReference | null {
  if (text[at] !== '@') return null;

  // A quoted path is the only one allowed to hold a space, so it is the only one
  // whose end is not simply the next space.
  if (text[at + 1] === '"') {
    const close = text.indexOf('"', at + 2);
    if (close < 0) return null;
    const inside = referenceOf(text.slice(at + 2, close));
    if (!inside) return null;
    return { ...inside, start: at, end: close + 1, raw: text.slice(at, close + 1) };
  }

  const run = /^\S+/.exec(text.slice(at + 1))?.[0] ?? '';
  const body = run.replace(TRAILING, '');
  const found = referenceOf(body);
  if (!found) return null;
  const end = at + 1 + body.length;
  return { ...found, start: at, end, raw: text.slice(at, end) };
}

/**
 * The one reference a token is, or nothing.
 *
 * The whole of the text has to be that reference — trailing punctuation aside,
 * which belongs to the sentence and not to the path. A lone `@`, an email
 * address and a word with an `@` in the middle of it are all nothing.
 */
export function parseReference(text: string): Reference | null {
  const token = text.trim();
  const found = matchAt(token, 0);
  if (!found) return null;
  if (!/^[.,;:!?)\]}'"`>]*$/.test(token.slice(found.end))) return null;
  return { path: found.path, line: found.line, endLine: found.endLine, kind: found.kind };
}

/**
 * A reference written back out, always in our own form: `@path`, `@path:12`,
 * `@path:12-40`, `@dir/`. Whatever shape it was read in, this is the shape it is
 * written in, so a reference that has been through the app is the reference
 * everything else expects.
 */
export function formatReference(ref: Reference): string {
  const path = ref.kind === 'folder' && !ref.path.endsWith('/') ? `${ref.path}/` : ref.path;
  const lines =
    ref.line === null
      ? ''
      : ref.endLine === null || ref.endLine === ref.line
        ? `:${ref.line}`
        : `:${ref.line}-${ref.endLine}`;
  const body = `${path}${lines}`;
  return /\s/.test(body) ? `@"${body}"` : `@${body}`;
}

/**
 * What a reference is DRAWN as: our own form with the `@` taken off, because the
 * badge around it already says "this is a file" (bw-gr8y.2).
 */
export function referenceLabel(ref: Reference): string {
  return formatReference(ref).replace(/^@"?/, '').replace(/"$/, '');
}

/** A fenced block, terminated or running to the end of the text. */
const FENCE = /^[ \t]*(```+|~~~+)[^\n]*(?:\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|$)|$)/gm;
/** A run of backticks, whatever it holds, up to the same run again. */
const CODE_SPAN = /(`+)[^`]*?\1/g;

/** Where in a text nothing is a reference, because it is code. */
function codeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of text.matchAll(FENCE)) {
    if (m.index === undefined) continue;
    spans.push([m.index, m.index + m[0].length]);
  }
  const fenced = spans.length;
  for (const m of text.matchAll(CODE_SPAN)) {
    if (m.index === undefined) continue;
    if (spans.slice(0, fenced).some(([from, to]) => m.index! >= from && m.index! < to)) continue;
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/**
 * Every reference in a run of text, in the order it was written, with the span
 * it occupies so a caller can replace exactly those characters.
 *
 * Code is skipped whole: `` `@x` `` and a fenced block are somebody showing what
 * a reference LOOKS like, or a command that happens to contain one, and neither
 * is a file being pointed at.
 */
export function findReferences(text: string): FoundReference[] {
  const code = codeSpans(text);
  const found: FoundReference[] = [];
  let from = 0;

  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    if (at < from) continue;
    if (at > 0 && !BEFORE.test(text[at - 1]!)) continue;
    if (code.some(([start, end]) => at >= start && at < end)) continue;
    const ref = matchAt(text, at);
    if (!ref) continue;
    found.push(ref);
    from = ref.end;
  }

  return found;
}

/**
 * Where a reference actually is on disk, or null when that cannot be worked out
 * yet — a relative path with no folder to hang it on is not an address.
 *
 * The path may already be absolute, or written with `~`, in which case the root
 * has to say where home is; a plain string root is the folder alone.
 */
export function resolveReference(ref: Reference, root: string | Rooted): string | null {
  const where: Rooted = typeof root === 'string' ? { cwd: root, home: '' } : root;
  return resolvePath(ref.path, where);
}
