import type { ImagePayload } from '@/workbench/protocol';

export interface DraftPicture extends ImagePayload {
  id: string;
}

const MARKER = /\[\[atelier-image:([a-zA-Z0-9_-]+)\]\]/g;

export function imageMarker(id: string): string {
  return `[[atelier-image:${id}]]`;
}

export function imageIds(text: string): string[] {
  return Array.from(text.matchAll(MARKER), (match) => match[1]!);
}

export function promptWithoutImageMarkers(text: string, pictures: DraftPicture[] = []): string {
  const byId = new Map(pictures.map((picture) => [picture.id, picture]));
  return text.replace(MARKER, (_marker, id: string) => {
    const picture = byId.get(id);
    return picture ? `[Image: ${picture.alt}]` : '';
  }).replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * Every attached picture once, in the order the words name them.
 *
 * Named once each: a draft that mentions the same picture twice used to put its
 * whole base64 in here twice over, which is weight on the wire for a picture
 * the reader already has (bw-ad3r.3). Where a picture is named more than once
 * is `promptParts`' business, and a part names it rather than carrying it.
 */
export function orderedPictures(text: string, pictures: DraftPicture[]): DraftPicture[] {
  const byId = new Map(pictures.map((picture) => [picture.id, picture]));
  const mentioned = new Set<string>();
  const inText: DraftPicture[] = [];
  for (const id of imageIds(text)) {
    const picture = byId.get(id);
    if (!picture || mentioned.has(id)) continue;
    mentioned.add(id);
    inText.push(picture);
  }
  return [...inText, ...pictures.filter((picture) => !mentioned.has(picture.id))];
}

export type PromptPart = { type: 'text'; text: string } | { type: 'image'; id: string };

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
