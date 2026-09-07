/**
 * What kind of file a name is, and how that kind is drawn.
 *
 * A file badge is built in two places — a markdown link that points at a file
 * (`markdown-body.tsx`) and a bare path an agent wrote in its own words
 * (`workbench/path-chip.tsx`) — and the two must be the same badge. The reader
 * is not being shown two kinds of file; they are being shown a file, and where
 * the words came from is not their problem (bw-un8y.1).
 *
 * The colours are the ones a file tree uses, so an extension keeps the hue a
 * reader already associates with it.
 */
import {
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
} from "lucide-react";

export type FileKind = 'archive' | 'audio' | 'code' | 'data' | 'image' | 'table' | 'text' | 'video' | 'file';

export const FILE_KINDS: Record<FileKind, { extensions: Set<string>; icon: LucideIcon; color: string }> = {
  archive: { extensions: new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip']), icon: FileArchive, color: 'border-[#e37933]/40 bg-[#e37933]/10 text-[#e37933] hover:bg-[#e37933]/15' },
  audio: { extensions: new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'wav']), icon: FileAudio, color: 'border-[#cbcb41]/40 bg-[#cbcb41]/10 text-[#cbcb41] hover:bg-[#cbcb41]/15' },
  code: { extensions: new Set(['c', 'cc', 'cpp', 'css', 'go', 'h', 'html', 'java', 'js', 'jsx', 'kt', 'php', 'py', 'rb', 'rs', 'sh', 'sql', 'swift', 'ts', 'tsx', 'vue']), icon: FileCode2, color: 'border-[#519aba]/40 bg-[#519aba]/10 text-[#519aba] hover:bg-[#519aba]/15' },
  data: { extensions: new Set(['json', 'jsonl', 'toml', 'xml', 'yaml', 'yml']), icon: FileJson, color: 'border-[#cbcb41]/40 bg-[#cbcb41]/10 text-[#cbcb41] hover:bg-[#cbcb41]/15' },
  image: { extensions: new Set(['avif', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']), icon: FileImage, color: 'border-[#a074c4]/40 bg-[#a074c4]/10 text-[#a074c4] hover:bg-[#a074c4]/15' },
  table: { extensions: new Set(['csv', 'numbers', 'ods', 'tsv', 'xls', 'xlsx']), icon: FileSpreadsheet, color: 'border-[#8dc149]/40 bg-[#8dc149]/10 text-[#8dc149] hover:bg-[#8dc149]/15' },
  text: { extensions: new Set(['log', 'md', 'pdf', 'rtf', 'txt']), icon: FileText, color: 'border-[#6d8086]/40 bg-[#6d8086]/10 text-[#91a3a8] hover:bg-[#6d8086]/15' },
  video: { extensions: new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'webm']), icon: FileVideo, color: 'border-[#e06c75]/40 bg-[#e06c75]/10 text-[#e06c75] hover:bg-[#e06c75]/15' },
  file: { extensions: new Set(), icon: File, color: 'border-muted-foreground/30 bg-muted/30 text-muted-foreground hover:bg-muted/50' },
};

/**
 * The kind a name belongs to, by its extension. A folder, an extension nobody
 * listed, and a name with no extension at all are all just a file.
 */
export function fileKind(path: string): FileKind {
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return (Object.entries(FILE_KINDS) as [FileKind, (typeof FILE_KINDS)[FileKind]][])
    .find(([kind, definition]) => kind !== 'file' && definition.extensions.has(extension))?.[0] ?? 'file';
}

/**
 * The classes that make a span or an anchor look like a file badge. Shared so
 * the two places that build one cannot drift apart.
 *
 * A badge wraps rather than running off the side. An agent's addresses are
 * long — a worktree under a branch named after a whole sentence is most of a
 * line by itself — and a badge is a flex box, which by default is one unbroken
 * run: the first long path drawn as one pushed straight out of the message and
 * was cut off by its edge (bw-1e2e.1). So the letters are allowed to break and
 * the box is allowed to grow tall enough to hold them.
 *
 * The icon stays in the middle of however tall that turns out to be. Pinned to
 * the top it read as a bullet against the first line rather than as the mark of
 * the whole badge, which is what it is.
 */
export const FILE_BADGE_CLASS =
  'mx-0.5 align-middle font-mono no-underline '
  + 'h-auto max-w-full items-center whitespace-normal break-all py-px';
