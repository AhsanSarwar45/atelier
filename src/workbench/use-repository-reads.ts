/**
 * How anything drawn from a repository stays current: one hook, written once
 * (bw-rx1y.5).
 *
 * The Git rail worked this out first, and the diff that stands in for the
 * transcript needs exactly the same thing — the same two signals and the same
 * care about not running its reads over each other. Two copies of it would
 * drift the moment one of them was fixed, so the rail and the diff share this
 * and neither owns it.
 *
 * What it does, in the order it matters:
 *
 * - A read the caller asked itself for, never more than one at a time. A push
 *   writes a burst of refs and a commit writes several files, so the change
 *   arrives as a handful of events in a moment. Reading git once per event
 *   would mean several runs racing each other over one repository, and the
 *   last one to answer — not the last one to be asked — deciding what is on
 *   screen. A read that arrives while one is in flight queues exactly one more
 *   behind it, which is enough: the queued read sees everything the events
 *   before it were about, because it asks git afresh.
 * - The repository changing without the app: a commit, a push, a fetch or a
 *   checkout made in a terminal, or by an agent working in this very checkout.
 *   The server watches the git directory and says so on the window's one
 *   connection (never a stream of its own), and this reads again on hearing it.
 * - A file merely edited on disk, which that watcher cannot see: the git
 *   directory does not move for it, and watching the working tree would report
 *   every `node_modules` write and every build. So an edit made outside the app
 *   arrives on the slow look instead — while the caller is drawn and the window
 *   is being looked at. A hidden tab asks for nothing at all, and asks once the
 *   moment it is looked at again, which is also when a reader who has been away
 *   in a terminal wants the answer.
 */
'use client';

import { useCallback, useEffect, useRef } from 'react';

import { git } from '@/lib/api';

/**
 * How often a repository is looked at of its own accord, in ms.
 *
 * Five seconds is slow enough to cost nothing (one git run on a local
 * repository, and only while something is drawn and the window is being looked
 * at) and quick enough that a file an agent writes shows up while the reader is
 * still looking.
 */
export const WORKING_TREE_MS = 5_000;

/**
 * Keep something drawn from `path` current, and hand back the re-read so the
 * caller can also ask for one itself (after a commit, say).
 *
 * `read` is the caller's quiet read — the one that does not spin a refresh
 * button, because a read nobody asked for must not look like the app doing
 * something. Keep it stable with `useCallback`, the way an effect's dependency
 * wants; it is depended on here.
 */
export function useRepositoryReads(path: string | null, read: () => Promise<void>): () => Promise<void> {
  const busyReading = useRef(false);
  const oneMore = useRef(false);
  const readAgain = useCallback(async () => {
    if (busyReading.current) {
      oneMore.current = true;
      return;
    }
    busyReading.current = true;
    try {
      do {
        oneMore.current = false;
        await read();
      } while (oneMore.current);
    } finally {
      busyReading.current = false;
    }
  }, [read]);

  // The git directory moving, told to us over the window's one connection.
  // Held only while the caller is on screen and only for the path it is
  // pointed at.
  useEffect(() => {
    if (!path) return;
    return git.watch(path, () => void readAgain());
  }, [path, readAgain]);

  // Coming back to the window, and the slow look while it is here.
  useEffect(() => {
    if (!path) return;
    const lookAgain = () => {
      if (document.visibilityState === 'hidden') return;
      void readAgain();
    };
    const woken = () => {
      if (document.visibilityState === 'visible') void readAgain();
    };
    const slowly = setInterval(lookAgain, WORKING_TREE_MS);
    window.addEventListener('focus', lookAgain);
    document.addEventListener('visibilitychange', woken);
    return () => {
      clearInterval(slowly);
      window.removeEventListener('focus', lookAgain);
      document.removeEventListener('visibilitychange', woken);
    };
  }, [path, readAgain]);

  return readAgain;
}
