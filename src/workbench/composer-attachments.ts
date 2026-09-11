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

export function orderedPictures(text: string, pictures: DraftPicture[]): DraftPicture[] {
  const byId = new Map(pictures.map((picture) => [picture.id, picture]));
  const inText = imageIds(text).flatMap((id) => {
    const picture = byId.get(id);
    return picture ? [picture] : [];
  });
  const mentioned = new Set(inText.map((picture) => picture.id));
  return [...inText, ...pictures.filter((picture) => !mentioned.has(picture.id))];
}

export function promptParts(text: string, pictures: DraftPicture[]): Array<
  { type: 'text'; text: string } | { type: 'image'; image: DraftPicture }
> {
  const byId = new Map(pictures.map((picture) => [picture.id, picture]));
  const parts: Array<{ type: 'text'; text: string } | { type: 'image'; image: DraftPicture }> = [];
  let from = 0;
  for (const match of text.matchAll(MARKER)) {
    const at = match.index!;
    if (at > from) parts.push({ type: 'text', text: text.slice(from, at) });
    const picture = byId.get(match[1]!);
    if (picture) parts.push({ type: 'image', image: picture });
    from = at + match[0].length;
  }
  if (from < text.length) parts.push({ type: 'text', text: text.slice(from) });
  return parts;
}
