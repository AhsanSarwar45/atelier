import type { ImagePayload, PromptPart } from '@/workbench/protocol';

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
  const byId = new Map(pictures.map((picture) => [picture.id, picture]));
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
 * Whether a chosen file is one we can put into the prompt as words.
 *
 * Same reasoning as `looksLikeAPicture`: the reported type first, the name when
 * the phone had nothing to say. A file that is neither a picture nor readable
 * as text has nowhere to go in a prompt, and is turned down out loud rather
 * than dropped (bw-ad3r.7).
 */
const TEXT_TYPES = ['text/', 'application/json', 'application/xml', 'application/javascript', 'application/x-yaml'];
const TEXT_ENDINGS = [
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv',
  '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env',
  '.xml', '.html', '.htm', '.css', '.scss', '.svg',
  '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.swift', '.sh', '.bash',
  '.sql', '.graphql', '.proto', '.diff', '.patch', '.lock', '.gitignore',
];

export function looksLikeText(file: { type?: string; name?: string }): boolean {
  if (file.type) return TEXT_TYPES.some((kind) => file.type!.startsWith(kind));
  const name = (file.name ?? '').toLowerCase();
  return TEXT_ENDINGS.some((ending) => name.endsWith(ending));
}

/**
 * A file's contents as a block in the draft, named so the agent knows what it
 * is looking at.
 *
 * Put into the writing box rather than carried beside it, so that what will be
 * sent is what the person can see and edit before they send it. The fence is
 * widened past any run of backticks inside the file, so a markdown file with
 * its own code blocks does not end the block early.
 */
export function fileAsABlock(name: string, contents: string): string {
  const longest = Math.max(0, ...Array.from(contents.matchAll(/`+/g), (run) => run[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  const ending = name.toLowerCase().split('.').pop() ?? '';
  return `${name}:\n${fence}${/^[a-z0-9]+$/.test(ending) ? ending : ''}\n${contents.replace(/\n$/, '')}\n${fence}\n`;
}
