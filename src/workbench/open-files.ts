/**
 * Which files are open above the viewer, and which of them is only being
 * glanced at (bw-g3o3.14).
 *
 * Every editor a reader has used works the same way: clicking through a tree
 * does not fill the strip with twenty tabs, because one click only *previews* —
 * it takes the single replaceable slot and the file that was in it goes away.
 * Committing to a file (double-clicking it, or typing in it) pins it, and from
 * then on it stays until it is closed. Without that, walking a tree to find one
 * function leaves a strip nobody can read.
 *
 * The rules live here, apart from the drawing, because they are all about
 * *which* file ends up where and none of them need a screen to be wrong: the
 * slot is replaced rather than appended to, a file already open is not opened
 * twice, and closing the file being read has to land on a neighbour rather than
 * on nothing while there are still files open.
 */

export interface OpenFile {
  /** The absolute path of the file on the machine. */
  path: string;
  /** True while this is the one replaceable slot — drawn in italics. */
  preview: boolean;
}

export interface OpenFiles {
  /** The tabs, left to right, in the order they were opened. */
  files: OpenFile[];
  /** The path being shown. Null only when nothing is open at all. */
  current: string | null;
}

export const NOTHING_OPEN: OpenFiles = { files: [], current: null };

/**
 * Opened with a single click: it takes the preview slot.
 *
 * A file that is already open is simply shown — including when it is pinned, so
 * clicking a pinned tab in the tree does not quietly un-pin it and lose the
 * reader's place the next time they glance at something else.
 */
export function previewing(state: OpenFiles, path: string): OpenFiles {
  if (state.files.some((file) => file.path === path)) return { ...state, current: path };
  const slot = state.files.findIndex((file) => file.preview);
  const opened: OpenFile = { path, preview: true };
  const files = slot === -1
    ? [...state.files, opened]
    : state.files.map((file, at) => (at === slot ? opened : file));
  return { files, current: path };
}

/**
 * Pinned: a double click, or the first edit. The tab stops being replaceable
 * and stops being drawn in italics. Pinning a file that was not open opens it
 * pinned, which is what a double click in the tree means.
 */
export function pinning(state: OpenFiles, path: string): OpenFiles {
  if (!state.files.some((file) => file.path === path)) {
    return { files: [...state.files, { path, preview: false }], current: path };
  }
  return {
    files: state.files.map((file) => (file.path === path ? { ...file, preview: false } : file)),
    current: path,
  };
}

/**
 * Closed by its × or by a middle click.
 *
 * When the file being read is the one closed, the reader is left looking at the
 * tab that slid into its place, and at the one before it when it was the last —
 * the same landing every editor makes, so the strip never closes down to a file
 * still being open but nothing on screen.
 */
export function closing(state: OpenFiles, path: string): OpenFiles {
  const at = state.files.findIndex((file) => file.path === path);
  if (at === -1) return state;
  const files = state.files.filter((file) => file.path !== path);
  if (state.current !== path) return { files, current: state.current };
  const next = files[at] ?? files[at - 1] ?? null;
  return { files, current: next?.path ?? null };
}

/** What Ctrl+W means. Nothing open, nothing to close. */
export function closingCurrent(state: OpenFiles): OpenFiles {
  return state.current === null ? state : closing(state, state.current);
}

/** Where the strip is remembered, one key per project, like the root is. */
export function openFilesKey(projectId: string | null): string {
  return `workbench.open-files.${projectId ?? 'unknown'}`;
}

/**
 * The remembered strip, read back defensively.
 *
 * What is in the browser's store was written by some earlier version of this
 * app and can be anything at all; a strip that threw on the way in would take
 * the whole tab with it, so anything unreadable is simply no strip.
 */
export function openFilesFrom(raw: string | null): OpenFile[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is { path: string; preview?: unknown } =>
        typeof entry === 'object' && entry !== null && typeof (entry as { path?: unknown }).path === 'string')
      .map((entry) => ({ path: entry.path, preview: entry.preview === true }));
  } catch {
    return [];
  }
}
