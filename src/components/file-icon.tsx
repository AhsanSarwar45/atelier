/**
 * The picture beside a name in the file tree (bw-g3o3.12).
 *
 * The icons are material-icon-theme's, and they are drawn as `<img>` pointing
 * at a static SVG under `public/file-icons/` — never as a React component. That
 * is the whole trick: a hundred and ninety-three file types cost the bundle the
 * few kilobytes of the lookup table in `file-icons.ts` and nothing else, and
 * the browser caches the pictures the way it caches any other image.
 *
 * The table is pruned (see scripts/build-file-icons.mjs), so plenty of names
 * match nothing in it. Those get the app's own lucide glyph, which is what the
 * rest of the app already draws a file with — a plain outline rather than a
 * missing picture.
 */
'use client';

import { File as FileGlyph, Folder as FolderGlyph, FolderOpen as FolderOpenGlyph } from 'lucide-react';

import { ICON_BY_EXTENSION, ICON_BY_FOLDER, ICON_BY_NAME, iconUrl } from '@/components/file-icons';

/**
 * The icon name for a file, or null when nothing in the pruned table matches.
 *
 * The whole filename is asked first — `Dockerfile` and `package.json` mean more
 * than "no ending" and "some JSON" do. Then endings, longest first, so a
 * `types.d.ts` is a declaration file rather than TypeScript and a
 * `bundle.tar.gz` is an archive rather than whatever `.gz` alone would be.
 */
export function iconForFile(name: string): string | null {
  const lower = name.toLowerCase();
  const byName = ICON_BY_NAME[lower];
  if (byName) return byName;
  // Every ending the name has, longest first: `a.test.tsx` asks about
  // `test.tsx` before `tsx`. A leading dot is never an ending of its own, or
  // `.env` would be looked up as the extension `env` of a nameless file — which
  // happens to be right here, and is wrong the moment a `.gitignore` arrives.
  let cut = lower.indexOf('.', 1);
  while (cut !== -1) {
    const icon = ICON_BY_EXTENSION[lower.slice(cut + 1)];
    if (icon) return icon;
    cut = lower.indexOf('.', cut + 1);
  }
  return null;
}

/** The icon name for a folder, shut or open, or null when none matches. */
export function iconForFolder(name: string, open: boolean): string | null {
  const pair = ICON_BY_FOLDER[name.toLowerCase()];
  return pair ? pair[open ? 1 : 0] : null;
}

interface FileIconProps {
  /** The entry's own name, not its path. */
  name: string;
  kind: 'dir' | 'file' | 'link';
  /** Only means anything for a directory. */
  open?: boolean;
}

/** One entry's picture: material's if there is one, the app's glyph if not. */
export function FileIcon({ name, kind, open = false }: FileIconProps) {
  const icon = kind === 'dir' ? iconForFolder(name, open) : iconForFile(name);
  if (icon) {
    return (
      /* A static SVG of a known size, one of a couple of hundred. Next's
         image loader has nothing to optimise about a vector and would put a
         request in front of each one, which is the opposite of the point. */
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={iconUrl(icon)}
        alt=""
        aria-hidden="true"
        width={16}
        height={16}
        className="h-4 w-4 shrink-0"
        data-icon={icon}
        draggable={false}
      />
    );
  }
  const Glyph = kind === 'dir' ? (open ? FolderOpenGlyph : FolderGlyph) : FileGlyph;
  return <Glyph className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" data-icon="lucide" />;
}
