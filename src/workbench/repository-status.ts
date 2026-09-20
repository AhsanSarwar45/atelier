/**
 * One `git status` per repository, however many things are drawn from it
 * (bw-o5i3.4).
 *
 * Two parts of the Files tab are drawn from the same answer: the tree, which
 * colours a name by what git says about it, and the Git rail beside it. Each
 * asked for itself. Both are kept current by the same rule — the watch on the
 * git directory, plus a slow look every five seconds for an edit no watcher
 * can see (`use-repository-reads.ts`) — so the two ran their own `git status`
 * on the same repository a few milliseconds apart, twice every five seconds,
 * for as long as the tab was open.
 *
 * The run itself is not usually the expensive part. What makes this worth
 * holding is what the run answers WITH: `--untracked-files=all` names every
 * untracked path one by one, and on a checkout whose `.gitignore` does not
 * cover its virtualenv and its build output that is 5,099 paths and 318 KB of
 * JSON — parsed, and turned into a map, twice.
 *
 * So an answer is held for a moment and the second asker is given the first
 * asker's. Held only for the slow look, which by definition has no reason to
 * think anything changed. The two reads that DO have a reason throw the held
 * answer away first:
 *
 * - Something a reader did — a refresh, a stage, a commit — asks for a fresh
 *   one and says so, because the point of reading again after a write is to
 *   see the write.
 * - A reason to think it moved: the watcher saying the git directory has, or
 *   the window being come back to after a reader has been away in a terminal.
 *   `use-repository-reads.ts` says so here before it tells its caller to read,
 *   and because every reader of one repository says it before any of them
 *   reads, they still share the single run that follows.
 */
'use client';

import { git, type GitStatus } from '@/lib/api';

/**
 * How long an answer stands in for the next asker's, in ms.
 *
 * Under half the slow look's five seconds, so the two readers of one
 * repository share an answer however their intervals happen to line up, and
 * short enough that nothing on screen is ever a whole cycle behind.
 */
export const FRESHLY_READ_MS = 2_000;

/** The last answer for a repository, and when it came. */
const held = new Map<string, { at: number; status: GitStatus }>();

/** The read already on its way for a repository, so a second asker joins it. */
const onTheWay = new Map<string, Promise<GitStatus>>();

/**
 * How many times a repository has been said to have moved, which is what makes
 * an answer keepable or not.
 *
 * A run started before the news is not the answer to the news, however long
 * after it the run happens to finish. Without this, a burst — a push writing a
 * handful of refs, a commit writing several files — would end with the run it
 * started held as current, and every reader would then be shown a repository
 * as it was a moment before the burst until the hold ran out.
 */
const moves = new Map<string, number>();

/**
 * What git says about `path`, possibly the answer it just gave somebody else.
 *
 * `fresh` is for a read a reader asked for: it ignores what is held and
 * replaces it. A quiet read — the slow look, or a watcher firing — does not
 * need to be the one that runs git.
 *
 * The caller's abort signal is deliberately not passed down: the answer is
 * shared, and one caller going away must not take another caller's read with
 * it. Callers check their own signal when the answer arrives, which is what
 * they did before; all that is lost is the cancelling of a request that a
 * local repository answers in milliseconds.
 */
export async function readRepositoryStatus(
  path: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<GitStatus> {
  if (!fresh) {
    const last = held.get(path);
    if (last && Date.now() - last.at < FRESHLY_READ_MS) return last.status;
    const already = onTheWay.get(path);
    if (already) return already;
  }
  const movesBefore = moves.get(path) ?? 0;
  const reading = git
    .status(path)
    .then((status) => {
      // Kept only if nothing said the repository moved while this was running.
      // The caller is still given it — it is the newest answer anyone has —
      // but the next asker runs git rather than being handed it.
      if ((moves.get(path) ?? 0) === movesBefore) held.set(path, { at: Date.now(), status });
      return status;
    })
    .finally(() => {
      if (onTheWay.get(path) === reading) onTheWay.delete(path);
    });
  onTheWay.set(path, reading);
  return reading;
}

/**
 * The repository moved, so what is held about it is no longer true.
 *
 * Only the held answer goes: a read already on its way was started for this
 * same news, and the reader behind it should join that one rather than start a
 * second run over the same repository.
 */
export function repositoryMayHaveMoved(path: string): void {
  held.delete(path);
  moves.set(path, (moves.get(path) ?? 0) + 1);
}

/** Throw away everything held. For a test that wants a clean bench. */
export function forgetRepositoryStatus(): void {
  held.clear();
  onTheWay.clear();
  moves.clear();
}
