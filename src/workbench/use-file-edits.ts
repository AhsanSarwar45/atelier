'use client';

/**
 * Editing one open file: what the reader has typed, what is on disk, and what
 * to do when those two stopped being the same thing (bw-g3o3.8).
 *
 * The viewer is handed its file rather than fetching one, and this keeps that
 * true — it is handed each fresh read too, and decides what the read means. A
 * file is read once when it is opened and again whenever the folder watch says
 * it moved (`use-folder-reads.ts`), and the difference between those two cases
 * is the whole of what a reader notices:
 *
 * - Nothing typed yet, and the file moved: take the new text. This is the case
 *   that matters most in practice, because the thing writing the file is
 *   usually an agent working in the same checkout, and a viewer showing a
 *   version from four minutes ago is worse than useless.
 * - Something typed, and the file moved: say so and ask. Taking the new text
 *   would throw the reader's work away; ignoring it would let them save over
 *   somebody else's. Neither is ours to choose, so both are offered.
 *
 * The digest is what makes the second case honest all the way down. Every read
 * carries the SHA-256 of exactly the bytes it read, a save sends it back as
 * `ifSha`, and the server refuses the save when the file no longer matches —
 * so a file that moved between a read and a save is caught even when it moved
 * in the moment between them, which no amount of watching could see in time.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import * as api from '@/lib/api';
import { ApiError } from '@/lib/api';
import { markUnsaved } from '@/workbench/unsaved-files';

/** The file as it was last read, in the only two parts editing cares about. */
export interface FileOnDisk {
  text: string;
  /** The digest those bytes were read at, or null when the read had none. */
  sha: string | null;
}

/** What a viewer needs to let a file be edited, saved, and told about. */
export interface FileEdits {
  /** The text to show: the reader's, once they have typed anything. */
  text: string;
  /** Whether the editor takes keystrokes. False until the file is opened up. */
  editable: boolean;
  /** Unsaved edits are in hand. What the dot is drawn from. */
  dirty: boolean;
  /** A save is in flight; the Save button is spent while it is. */
  saving: boolean;
  /** What went wrong with the last save, or nothing. */
  error: string | null;
  /**
   * The file moved on disk while there were unsaved edits. Holds the text that
   * is there now, which is what Reload takes.
   */
  outside: FileOnDisk | null;
  /** Open the file up for typing — the Edit button, and the first keystroke. */
  open: () => void;
  /** Take a keystroke's worth of new text from the editor. */
  change: (next: string) => void;
  /** Save, if there is anything to save. */
  save: () => Promise<void>;
  /** Take what is on disk, dropping the unsaved edits. */
  reload: () => void;
  /** Keep the unsaved edits; the next save deliberately writes over disk. */
  keep: () => void;
}

/**
 * Hold the editing state for `path`, fed by each read of it.
 *
 * `read` is the answer of the last `GET /api/fs/read`, or null while there has
 * not been one. Hand over a fresh object whenever the file is read again — the
 * digest is what is compared, so re-reading an unchanged file costs nothing.
 */
export function useFileEdits(path: string | null, read: FileOnDisk | null): FileEdits {
  const [text, setText] = useState(read?.text ?? '');
  const [disk, setDisk] = useState<FileOnDisk>({ text: read?.text ?? '', sha: read?.sha ?? null });
  const [editable, setEditable] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outside, setOutside] = useState<FileOnDisk | null>(null);

  const dirty = text !== disk.text;

  // What a keystroke handler bound once has to read the current answer out of.
  const latest = useRef({ text, disk });
  latest.current = { text, disk };

  // A different file is a different everything. Keyed on the path rather than
  // done by remounting, because the viewer deliberately keeps one CodeMirror
  // view alive across files and a remount is the thing that would lose it.
  const opened = useRef(path);
  if (opened.current !== path) {
    opened.current = path;
    setText(read?.text ?? '');
    setDisk({ text: read?.text ?? '', sha: read?.sha ?? null });
    setEditable(false);
    setSaving(false);
    setError(null);
    setOutside(null);
  }

  // What each fresh read means. Compared by digest, so the five-second look at
  // an unchanged file lands here and does nothing at all.
  const seen = useRef<FileOnDisk | null>(null);
  useEffect(() => {
    if (!read) return;
    if (seen.current && seen.current.sha === read.sha && seen.current.text === read.text) return;
    seen.current = read;
    if (read.sha != null && read.sha === disk.sha) return;
    if (read.text === disk.text) {
      // The same text under a digest we had not seen — a save of our own
      // coming back, or a rewrite with identical contents. Take the digest so
      // the next save is checked against it, and leave the reader alone.
      setDisk({ text: read.text, sha: read.sha });
      return;
    }
    if (dirty) setOutside(read);
    else {
      setText(read.text);
      setDisk(read);
    }
  }, [read, disk.sha, disk.text, dirty]);

  // The dot in the header and the dot on the open-files strip are drawn from
  // the same one bit, and the window guard from all of them together.
  useEffect(() => {
    if (!path) return;
    markUnsaved(path, dirty);
  }, [path, dirty]);
  useEffect(() => {
    // Closing a file with unsaved edits is bw-g3o3.14's question to ask; what
    // must not happen is the strip keeping a dot for a file nobody holds.
    if (!path) return () => {};
    return () => markUnsaved(path, false);
  }, [path]);

  const open = useCallback(() => setEditable(true), []);

  const change = useCallback((next: string) => {
    setText(next);
    setError(null);
  }, []);

  const save = useCallback(async () => {
    if (!path) return;
    // Through the refs rather than this render's values: Ctrl-S is bound inside
    // CodeMirror once, so the `save` it holds is the one built on the render
    // the file was opened on, and the text it must send is the one on screen.
    const wanted = latest.current.text;
    const sha = latest.current.disk.sha;
    if (wanted === latest.current.disk.text) return;

    setSaving(true);
    setError(null);
    try {
      const answer = await api.fs.write(path, wanted, sha);
      setDisk({ text: wanted, sha: answer.sha256 });
      setOutside(null);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        // The file moved between the read and the save. The refusal carries
        // the digest of what is there now but not its text, so fetch that and
        // put the same two choices in front of the reader as a watched change.
        setError('The file changed on disk since it was opened.');
        try {
          const now = await api.fs.read(path);
          if (now.kind === 'text' && now.text != null) setOutside({ text: now.text, sha: now.sha256 ?? null });
        } catch {
          // The re-read failed too. The banner still says what happened; there
          // is simply nothing to offer as the other side of it.
        }
      } else {
        setError(failure instanceof Error ? failure.message.replace(/^API error: \d+ /, '') : 'The file could not be saved.');
      }
    } finally {
      setSaving(false);
    }
  }, [path]);

  const reload = useCallback(() => {
    setOutside((them) => {
      if (them) {
        setText(them.text);
        setDisk(them);
      }
      return null;
    });
    setError(null);
  }, []);

  const keep = useCallback(() => {
    // Their text becomes what we believe is on disk, so the edits stay dirty
    // and the next save carries their digest and deliberately writes over it.
    setOutside((them) => {
      if (them) setDisk(them);
      return null;
    });
    setError(null);
  }, []);

  return { text, editable, dirty, saving, error, outside, open, change, save, reload, keep };
}
