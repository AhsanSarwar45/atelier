/**
 * What can be made of an attachment, which is not quite what kind of file it is.
 *
 * `fileKind` (components/file-kinds.ts) answers what a file IS, for the icon and
 * the colour: a PDF and a log are both `text`, an HEIC and a PNG are both
 * `image`. This answers a different question — what the browser can actually
 * SHOW — and the two do not line up. A PDF opens in a frame and a log opens as
 * words. An HEIC is a picture no browser will draw and the store will not serve
 * as one, so it gets the same tile a zip gets rather than a broken `<img>`.
 *
 * The lists here are the client's half of one agreement: the server decides
 * what content type a kept file is served as, and refuses to serve anything
 * that could carry script as anything but a download (`served_as` in
 * server/src/routes/fs.rs). A look claimed here for an extension the server
 * will not serve inline would draw an empty box, so the two lists are the same
 * list, written on both sides of the wire.
 */
const PICTURE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp']);
const VIDEO = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv']);
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac']);
const WORDS = new Set([
  'json', 'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv', 'yaml', 'yml', 'toml',
  'ini', 'conf', 'env', 'xml', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'rb',
  'go', 'rs', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php',
  'swift', 'sh', 'bash', 'sql', 'graphql', 'proto', 'diff', 'patch',
]);

/** What a reader can be shown of one attachment. */
export type Look = 'picture' | 'video' | 'audio' | 'pdf' | 'words' | 'nothing';

/** What one file is, named and typed as far as anything knows either. */
export interface Attached {
  /** The file's name, which is where the extension is. */
  alt: string;
  /** What the browser or the record said it was, when anything did. */
  mime?: string;
}

/**
 * The type first, the name second.
 *
 * A picture that came out of a chat's own record is called `Picture 1` and has
 * no extension at all — the harness never wrote one — so a look worked out from
 * the name alone read it as an unopenable file and a reader clicking it got an
 * empty box instead of the viewer they have had all along. Its `mime` was
 * `image/png` the whole time. The name is the fallback, for the phones that
 * hand back a file with no type (bw-ad3r.6) and for a path typed into the
 * writing box, which has a name and nothing else.
 */
export function lookOf(file: Attached | string): Look {
  const { alt, mime } = typeof file === 'string' ? { alt: file, mime: undefined } : file;
  const said = (mime ?? '').toLowerCase();
  if (said.startsWith('image/')) return 'picture';
  if (said.startsWith('video/')) return 'video';
  if (said.startsWith('audio/')) return 'audio';
  if (said === 'application/pdf') return 'pdf';
  if (said.startsWith('text/')) return 'words';

  const extension = alt.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (PICTURE.has(extension)) return 'picture';
  if (VIDEO.has(extension)) return 'video';
  if (AUDIO.has(extension)) return 'audio';
  if (extension === 'pdf') return 'pdf';
  if (WORDS.has(extension)) return 'words';
  return 'nothing';
}

/** Whether opening this attachment would show the reader anything. */
export function opens(file: Attached | string): boolean {
  return lookOf(file) !== 'nothing';
}
