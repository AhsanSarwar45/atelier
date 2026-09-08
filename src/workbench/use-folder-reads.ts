/**
 * How a drawing of a folder stays true to the folder (bw-g3o3.3).
 *
 * The Files tab reads a directory once and draws it. A file written from a
 * terminal, by an agent working in the checkout, or by a build left that
 * drawing describing a folder that no longer existed, until somebody collapsed
 * and reopened it. This is the rule that closes that gap, and it is the
 * repository rule (`use-repository-reads.ts`) with one difference: what arrives
 * carries names.
 *
 * That difference is the whole reason this is not the same hook. A repository
 * answers "something moved" by re-reading the whole of what it draws, which is
 * two git runs. A tree is a drawing of thousands of directories, and re-reading
 * all of them because one file was saved would be the tab's entire work for
 * nothing — so the server names the paths that moved and the caller re-reads
 * only the directories those paths are in.
 *
 * The three signals, in the order they matter:
 *
 * - The folder changing without the app, told over the window's one connection
 *   (never a stream of its own), naming what moved.
 * - The slow look, for whatever no watcher could see — a folder over a network
 *   mount, a change while the watch was being re-established. It names nothing,
 *   which is how a caller is asked to re-read what it already draws.
 * - Coming back to the window, which is when a reader who has been away in a
 *   terminal wants the answer, and which is also the moment a hidden tab starts
 *   reading again: while it is hidden it reads nothing at all.
 *
 * Reads never run over each other, and a burst never queues more than one more
 * behind the read in flight — `useSerialReads`, which the repository rule uses
 * too, and which gathers the names of every ask it swallowed so the one run
 * that answers them all answers for all of them.
 */
'use client';

import { useEffect } from 'react';

import { fs } from '@/lib/api';
import { useSerialReads } from '@/workbench/use-serial-reads';

/**
 * How often a folder is looked at of its own accord, in ms.
 *
 * The same five seconds the repository takes, and for the same reason: slow
 * enough to cost nothing while something is drawn and the window is being
 * looked at, quick enough that anything the watcher missed shows up while the
 * reader is still there.
 */
export const FOLDER_MS = 5_000;

/**
 * Keep something drawn from `root` current, and hand back the re-read so the
 * caller can also ask for one itself (after writing a file, say).
 *
 * `read` is given the absolute paths that moved. An empty list is not "nothing
 * happened" — it is "look again at what you draw", which is what the slow look
 * and the window being come back to say. Keep `read` stable with `useCallback`,
 * the way an effect's dependency wants; it is depended on here.
 */
export function useFolderReads(
  root: string | null,
  read: (moved: string[]) => Promise<void>,
): (moved?: readonly string[]) => Promise<void> {
  const readAgain = useSerialReads(read);

  // The folder moving, told to us over the window's one connection. Held only
  // while the caller is on screen and only for the folder it is pointed at.
  useEffect(() => {
    if (!root) return;
    return fs.watch(root, (paths) => void readAgain(paths));
  }, [root, readAgain]);

  // Coming back to the window, and the slow look while it is here.
  useEffect(() => {
    if (!root) return;
    const lookAgain = () => {
      if (document.visibilityState === 'hidden') return;
      void readAgain();
    };
    const woken = () => {
      if (document.visibilityState === 'visible') void readAgain();
    };
    const slowly = setInterval(lookAgain, FOLDER_MS);
    window.addEventListener('focus', lookAgain);
    document.addEventListener('visibilitychange', woken);
    return () => {
      clearInterval(slowly);
      window.removeEventListener('focus', lookAgain);
      document.removeEventListener('visibilitychange', woken);
    };
  }, [root, readAgain]);

  return readAgain;
}
