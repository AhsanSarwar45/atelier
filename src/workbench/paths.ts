/**
 * A file NAMED in a chat, turned into something you can open.
 *
 * Agents write addresses on disk all day — in their prose ("the fix is in
 * src/workbench/chat-tab.tsx:212"), in the line where a tool says which file it
 * read, and above all inside the commands they run, where nearly every line
 * opens `cd /home/dev/beads-web/worktrees/bw-1p2 && …`. Every one of
 * them was dead text: the reader had to select it, leave the app, and find it
 * by hand (bw-khe.13).
 *
 * ## Only files that are really there
 *
 * Shape alone cannot decide. `and/or`, `24/7`, `w/e`, a version like `1.5.0`
 * and every web address in the world have the shape of a path, and prose is
 * full of them. Nothing here becomes a chip unless the caller says that exact
 * address is a real thing on disk. A lookup that knows nothing yields no chips
 * and the words are left alone, which is the right thing to draw while the
 * answers are still coming back — the same rule `mentions.ts` follows for cards.
 *
 * ## What the reader wrote is not what gets opened
 *
 * A message says `src/workbench/paths.ts`; the file is at
 * `/home/dev/dev/beads-web/src/workbench/paths.ts`. A chip keeps the reader's
 * own words as its text — so copying a command still copies the command — and
 * carries the resolved address separately, worked out against the folder that
 * chat was running in.
 */

/** One stretch of text: plain words, or a file that opens. */
export type PathPiece =
  | { kind: 'text'; text: string }
  | {
      /** As it was written, and what the chip draws. */
      kind: 'path';
      raw: string;
      /** Where that actually is on disk. */
      absolute: string;
      /** The line it named, when it named one. */
      line: number | null;
    };

/**
 * An address rooted somewhere the reader can name: `/a/b`, `~/a/b`, `./a`,
 * `../a`. The last segment may be empty so a trailing slash is part of the
 * match rather than left dangling in the prose.
 */
const ROOTED = String.raw`(?:~|\.{1,2})?\/(?:[\w.@%+~-]+\/)*[\w.@%+~-]*`;

/**
 * An address written from inside the project — `src/workbench/paths.ts`. It
 * must have a slash AND an extension: without the extension, every `and/or`
 * and `24/7` in the language becomes a question for the disk.
 */
const BARE = String.raw`(?:[\w.@%+-]+\/)+[\w.@%+-]*\.[A-Za-z0-9]{1,12}`;

/** `:42`, or `:42:7` — the line, and the column nobody opens on. */
const AT_LINE = String.raw`(?::\d+){0,2}`;

const CANDIDATE = new RegExp(`(?:${ROOTED}|${BARE})${AT_LINE}`, 'g');

/** A web address. Everything inside one is part of it, not a file. */
const URL_SPAN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/g;

/**
 * What a sentence puts after an address and never means as part of it. A real
 * name could end in any of these; none of them ever does in practice, and the
 * cost of being wrong is one word that stays plain.
 */
const TRAILING = /[.,;:!?)\]}'"`>]+$/;

/** Characters that mean the match started in the middle of a longer word. */
const GLUED = /[\w\\]/;

/** Where a chat was working, so a relative address means something. */
export interface Rooted {
  /** The folder that chat ran in. Empty when it is not known yet. */
  cwd: string;
  /** The reader's home, for an address written with `~`. Empty when unknown. */
  home: string;
}

/**
 * The address a written one points at, or `null` when it cannot be worked out
 * — a relative name with no folder to hang it on is not an address yet.
 */
export function resolvePath(raw: string, where: Rooted): string | null {
  if (raw.startsWith('/')) return normalise(raw);
  if (raw === '~' || raw.startsWith('~/')) {
    if (!where.home) return null;
    return normalise(`${where.home}/${raw.slice(2)}`);
  }
  if (!where.cwd) return null;
  return normalise(`${where.cwd}/${raw}`);
}

/** `a/./b`, `a/b/../c` and doubled slashes, put back into one plain address. */
function normalise(path: string): string {
  const rooted = path.startsWith('/');
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!rooted) out.push('..');
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  return rooted ? `/${joined}` : joined;
}

/** One address found in a run of text, before anything has vouched for it. */
export interface Candidate {
  /** As written, without the line and without the sentence's punctuation. */
  raw: string;
  line: number | null;
  /** Where it sits in the text it was found in, punctuation already dropped. */
  at: number;
  length: number;
}

/**
 * Every address-shaped thing in a run of text, in the order it was written.
 *
 * Nothing here asks whether they exist; that is the caller's to answer, and it
 * is answered off a list this hands back so one round of asking covers a whole
 * conversation.
 */
export function candidatesIn(text: string): Candidate[] {
  const urls: Array<[number, number]> = [];
  for (const u of Array.from(text.matchAll(URL_SPAN))) {
    if (u.index === undefined) continue;
    urls.push([u.index, u.index + u[0].length]);
  }

  const found: Candidate[] = [];
  const scan = new RegExp(CANDIDATE.source, CANDIDATE.flags);
  let m: RegExpExecArray | null;

  while ((m = scan.exec(text)) !== null) {
    const start = m.index;
    if (m[0] === '') {
      scan.lastIndex++;
      continue;
    }
    if (start > 0 && GLUED.test(text[start - 1]!)) continue;
    if (urls.some(([from, to]) => start < to && start + m![0].length > from)) continue;

    let token = m[0].replace(TRAILING, '');
    if (!token || token === '/' || token === '~' || token === '.' || token === '..') continue;

    // The line is peeled off the end, so what is left is the name of a file.
    let line: number | null = null;
    const at = /:(\d+)(?::\d+)?$/.exec(token);
    if (at) {
      line = Number(at[1]);
      token = token.slice(0, at.index);
    }
    if (!token || !token.includes('/')) continue;

    found.push({ raw: token, line, at: start, length: m[0].replace(TRAILING, '').length });
  }

  return found;
}

/** What the caller knows about disk. May say no to everything. */
export interface OnDisk {
  /** Whether that address is a real thing. Unknown counts as no. */
  real(absolute: string): boolean;
}

/**
 * One run of text, split into what it names.
 *
 * Always at least one piece, and text with nothing in it comes back as itself,
 * so a caller can tell "nothing to do" by the length.
 */
export function pathsIn(text: string, where: Rooted, disk: OnDisk): PathPiece[] {
  const pieces: PathPiece[] = [];
  let from = 0;

  for (const c of candidatesIn(text)) {
    if (c.at < from) continue;
    const absolute = resolvePath(c.raw, where);
    if (!absolute || !disk.real(absolute)) continue;
    if (c.at > from) pieces.push({ kind: 'text', text: text.slice(from, c.at) });
    pieces.push({
      kind: 'path',
      raw: text.slice(c.at, c.at + c.length),
      absolute,
      line: c.line,
    });
    from = c.at + c.length;
  }

  if (from < text.length || pieces.length === 0) pieces.push({ kind: 'text', text: text.slice(from) });
  return pieces;
}

/**
 * Every address a run of text might be naming, resolved, whether or not it is
 * real — what to go and ask disk about.
 */
export function askableIn(text: string, where: Rooted): string[] {
  const out = new Set<string>();
  for (const c of candidatesIn(text)) {
    const absolute = resolvePath(c.raw, where);
    if (absolute) out.add(absolute);
  }
  return Array.from(out);
}
