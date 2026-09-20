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
 *   before it were about, because it asks git afresh. That part is
 *   `useSerialReads`, shared with the folder rule (`use-folder-reads.ts`),
 *   which needs the same care about not running its reads over each other.
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

import { useCallback, useEffect } from 'react';

import { git } from '@/lib/api';
import { repositoryMayHaveMoved } from '@/workbench/repository-status';
import { useSerialReads } from '@/workbench/use-serial-reads';

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
 * Everything waiting on the slow look, and the one clock they all wait on.
 *
 * One interval for the whole window rather than one per caller, so that every
 * caller's slow look falls on the same tick. The Files tab draws the tree and
 * the Git rail from one `git status`, and they share the run only if they ask
 * within a moment of each other (`repository-status.ts`). Intervals of their
 * own would put them wherever their mounts happened to fall — the rail can be
 * opened halfway through a cycle — and two readers two and a half seconds
 * apart are two readers running git twice, which is the thing this exists to
 * stop. A shared beat has no offset to drift by.
 *
 * The clock runs only while something is waiting on it, and stops when the
 * last caller lets go.
 */
const waiting = new Set<() => void>();
let beat: ReturnType<typeof setInterval> | null = null;

function onTheSlowLook(look: () => void): () => void {
  waiting.add(look);
  beat ??= setInterval(() => {
    // Copied first: a caller that lets go while the beat is being served must
    // not change the set being walked.
    for (const each of [...waiting]) each();
  }, WORKING_TREE_MS);
  return () => {
    waiting.delete(look);
    if (waiting.size === 0 && beat !== null) {
      clearInterval(beat);
      beat = null;
    }
  };
}

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
  // A repository asks about nothing in particular: whatever moved, the caller
  // re-reads the whole of what it draws, because only git knows what it says
  // now. So the names `useSerialReads` can carry are simply not used here.
  const wholeThing = useCallback(() => read(), [read]);
  const readAgain = useSerialReads<never>(wholeThing);

  // The git directory moving, told to us over the window's one connection.
  // Held only while the caller is on screen and only for the path it is
  // pointed at.
  useEffect(() => {
    if (!path) return;
    return git.watch(path, () => {
      // The held status is about a repository that has just moved, so it is
      // thrown away before the caller reads — every reader of this repository
      // does this before any of them reads, so they still share the one run
      // that follows rather than each running git over the news (bw-o5i3.4).
      repositoryMayHaveMoved(path);
      void readAgain();
    });
  }, [path, readAgain]);

  // Coming back to the window, and the slow look while it is here.
  useEffect(() => {
    if (!path) return;
    const lookAgain = () => {
      if (document.visibilityState === 'hidden') return;
      void readAgain();
    };
    // Coming back is the one moment a reader is owed a fresh answer rather
    // than a shared one: they have been away, possibly in a terminal doing the
    // very thing they are coming back to look at. So what is held about this
    // repository goes, and the readers share the run that replaces it.
    const backAgain = () => {
      repositoryMayHaveMoved(path);
      lookAgain();
    };
    const woken = () => {
      if (document.visibilityState === 'visible') backAgain();
    };
    const slowly = onTheSlowLook(lookAgain);
    window.addEventListener('focus', backAgain);
    document.addEventListener('visibilitychange', woken);
    return () => {
      slowly();
      window.removeEventListener('focus', backAgain);
      document.removeEventListener('visibilitychange', woken);
    };
  }, [path, readAgain]);

  return readAgain;
}
