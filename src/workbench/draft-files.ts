/**
 * Everything the draft names, in the order it names it.
 *
 * The strip of tiles above the writing box and the badges inside it are two
 * drawings of ONE list — the files this message carries — and they were built
 * from two different readings of the draft. The tray read the attached
 * pictures; the badges read the attached pictures AND every `@path` typed in
 * the line. So a path the reader wrote had a badge and no tile, and the tray
 * and the box disagreed about what was going with the message (bw-oamr.8).
 *
 * This is the one reading. The tray draws it and the box draws it, so there is
 * nothing left for them to disagree about, and taking one away takes the other
 * with it because they were never two things.
 *
 * A typed path is not carried as bytes: it is a place on this machine, and its
 * `path` is what points at it. `attachmentSrc` knows all three ways an
 * attachment can say where it is, so a tile does not care which kind it holds.
 */
import { MARKER, type DraftPicture } from '@/workbench/composer-attachments';
import { resolvePath, type Rooted } from '@/workbench/paths';
import type { ImagePayload } from '@/workbench/protocol';
import { findReferences } from '@/workbench/references';

/** One file the draft names, and exactly the characters that name it. */
export interface DraftFile {
  /** Steady across redraws, so a tile is not rebuilt under the reader's hand. */
  key: string;
  /** What to draw: a name, and where its bytes are. */
  file: ImagePayload;
  /** The attached file this stands for, when it stands for one. */
  picture?: DraftPicture;
  /** The first character of what names it in the draft. */
  from: number;
  /** One past the last. */
  to: number;
}

/** The last segment of an address, which is what a person calls the file. */
export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

/**
 * Every file this draft names, in writing order.
 *
 * A path that cannot be resolved — a relative name written before the chat has
 * said where it is working — is left out rather than given a tile that points
 * nowhere. Its badge stays, because the badge is a drawing of the characters
 * and those are still there.
 */
export function draftFiles(draft: string, pictures: DraftPicture[], where: Rooted): DraftFile[] {
  const byId = new Map(pictures.map((picture) => [picture.id, picture]));
  const found: DraftFile[] = [];

  for (const match of draft.matchAll(MARKER)) {
    const picture = byId.get(match[1]!);
    if (!picture || match.index === undefined) continue;
    found.push({ key: picture.id, file: picture, picture, from: match.index, to: match.index + match[0].length });
  }

  for (const reference of findReferences(draft)) {
    if (reference.kind === 'folder') continue;
    const path = resolvePath(reference.path, where);
    if (!path) continue;
    found.push({
      key: `${reference.start}:${reference.raw}`,
      // A path says nothing about what is at the end of it, so the type is left
      // empty and `lookOf` reads the name — which is all a path ever offers.
      file: { alt: baseName(path), mime: '', dataUrl: '', path },
      from: reference.start,
      to: reference.end,
    });
  }

  return found.sort((one, other) => one.from - other.from);
}

/**
 * The draft with one file's name taken out of it.
 *
 * One adjoining space goes too. A name lifted out of the middle of a sentence
 * otherwise leaves the two spaces that surrounded it pressed together, and a
 * reader who removes three files in a row is left picking gaps out of their own
 * line by hand.
 */
export function withoutFile(draft: string, file: Pick<DraftFile, 'from' | 'to'>): string {
  let { from, to } = file;
  if (draft[to] === ' ') to += 1;
  else if (from > 0 && draft[from - 1] === ' ') from -= 1;
  return draft.slice(0, from) + draft.slice(to);
}
