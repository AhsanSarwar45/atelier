import type { ImagePayload, PromptPart } from '@/workbench/protocol';

export interface DraftPicture extends ImagePayload {
  id: string;
}

/** How an attached file is named in the draft: the badge's own characters. */
export const MARKER = /\[\[atelier-image:([a-zA-Z0-9_-]+)\]\]/g;

export function imageMarker(id: string): string {
  return `[[atelier-image:${id}]]`;
}

export function imageIds(text: string): string[] {
  return Array.from(text.matchAll(MARKER), (match) => match[1]!);
}

/**
 * What the person wrote, and where each picture they attached belongs in it.
 *
 * The marker comes out and nothing is written in its place. It used to be
 * replaced by the words `[Image: name]`, which put the app's own prose into the
 * middle of his sentence and then left the transcript to work out, by matching
 * regexes against that prose, which parts of the message he had actually
 * written. A picture attached before the first word put that prose at position
 * zero and the whole message was read as one of the kit's notes and hidden
 * (bw-oamr.1). Structure the composer already has should not have to be guessed
 * back out of prose, so the position travels as a number on the picture instead
 * of as words in the text.
 *
 * `at` is an offset into the returned `text`, so the transcript can draw the
 * picture exactly where its badge sat in the writing box rather than pinning
 * every picture above the words (bw-oamr.2). A picture named twice is carried
 * once, at the first place it was named — its bytes travel once (bw-ad3r.3) and
 * a second copy of the same picture in one message is not what the badge meant.
 */
export function promptFromDraft(draft: string, pictures: DraftPicture[] = []): {
  text: string;
  images: DraftPicture[];
} {
  // Its bytes stay behind. A kept file is named by its asset, and the name is
  // all the message needs: carrying the base64 too would put it back in the
  // event log, which is the thing bw-oamr.5 took it out of. A picture the store
  // never answered for keeps its own bytes, because otherwise it is lost.
  const byId = new Map(pictures.map((picture) => [
    picture.id,
    picture.asset ? { ...picture, dataUrl: '' } : picture,
  ]));
  const segments: string[] = [];
  const marks: Array<{ id: string; after: number }> = [];
  const named = new Set<string>();
  let from = 0;
  for (const match of draft.matchAll(MARKER)) {
    segments.push(draft.slice(from, match.index!));
    const id = match[1]!;
    if (byId.has(id) && !named.has(id)) {
      named.add(id);
      marks.push({ id, after: segments.length });
    }
    from = match.index! + match[0].length;
  }
  segments.push(draft.slice(from));

  // Trailing blanks before a newline are cosmetic and live inside one segment,
  // so taking them out cannot move any segment but their own.
  const tidy = segments.map((segment) => segment.replace(/[ \t]+\n/g, '\n'));
  const raw = tidy.join('');
  const text = raw.trim();
  // The ends are trimmed off the whole message rather than off a segment, so
  // every offset shifts by whatever came off the front.
  const lead = raw.length - raw.replace(/^\s+/, '').length;
  const placed = marks.map((mark) => {
    const at = tidy.slice(0, mark.after).join('').length - lead;
    return { ...byId.get(mark.id)!, at: Math.max(0, Math.min(text.length, at)) };
  });
  // A picture whose badge was edited out of the writing box is still attached,
  // and belongs at the end rather than nowhere.
  const loose = pictures.filter((picture) => !named.has(picture.id)).map((picture) => ({ ...picture, at: text.length }));
  return { text, images: [...placed, ...loose] };
}

/**
 * Where each picture sits between the words, said by name rather than by value.
 *
 * A part names its picture and does not carry it. The bytes travel once, in the
 * prompt's own `images`, which the record is written from; this says where in
 * the sentence each of those belongs, and the server pairs the two up by id.
 * Carrying the whole `dataUrl` here as well put every attachment on the wire
 * twice in one document — the same base64 in `images` and again in `parts` —
 * which halved what a message could hold before the request was refused
 * outright (bw-ad3r.3).
 */
export function promptParts(text: string, pictures: DraftPicture[]): PromptPart[] {
  const byId = new Map(pictures.map((picture) => [picture.id, picture]));
  const parts: PromptPart[] = [];
  let from = 0;
  for (const match of text.matchAll(MARKER)) {
    const at = match.index!;
    if (at > from) parts.push({ type: 'text', text: text.slice(from, at) });
    const picture = byId.get(match[1]!);
    if (picture) parts.push({ type: 'image', id: picture.id });
    from = at + match[0].length;
  }
  if (from < text.length) parts.push({ type: 'text', text: text.slice(from) });
  return parts;
}

/**
 * Whether a chosen file is a picture we can attach.
 *
 * The type the browser reports is the first answer, but it is not always
 * there: Android's Drive, Files and Downloads providers hand back a file whose
 * `type` is the empty string, and iOS does the same for some HEIC paths.
 * Judging on the reported type alone dropped every one of those silently
 * (bw-ad3r.6), so a file with nothing to say for itself is judged by the
 * ending on its name instead.
 */
const PICTURE_ENDINGS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.heic', '.heif', '.svg'];

export function looksLikeAPicture(file: { type?: string; name?: string }): boolean {
  if (file.type) return file.type.startsWith('image/');
  const name = (file.name ?? '').toLowerCase();
  return PICTURE_ENDINGS.some((ending) => name.endsWith(ending));
}

/**
 * The largest file the store will keep, in bytes, and the same number the
 * server enforces (`server/src/workbench/media.rs`, ATTACHMENT_LIMIT).
 *
 * Held here as well so a file too big is turned down while it is still on the
 * disk it came from, rather than after it has been read into a string, turned
 * into base64 and pushed a hundred megabytes up the wire to be refused at the
 * far end.
 */
export const ATTACHMENT_LIMIT = 100 * 1024 * 1024;

/**
 * Why a chosen file cannot be attached, or nothing when it can.
 *
 * There is no longer a list of kinds this box will take. A zip, a video, a
 * spreadsheet and a screenshot are all a file with a name, and every one of
 * them is something a person may reasonably hand an agent; what used to happen
 * instead was that anything outside two hand-written extension lists was
 * announced as having "nowhere to go in a message" and dropped (bw-ad3r.7).
 * Size is the only thing left that can stop one, and it is said out loud.
 */
export function whyNot(file: { name?: string; size?: number }): string | null {
  const name = file.name || 'that file';
  if (file.size === 0) return `${name} is empty, so there is nothing to attach.`;
  if ((file.size ?? 0) > ATTACHMENT_LIMIT) {
    return `${name} is larger than ${ATTACHMENT_LIMIT / (1024 * 1024)} MB, which is more than a message can carry.`;
  }
  return null;
}
