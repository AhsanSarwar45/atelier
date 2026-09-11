/**
 * What the Git panel says when an operation answers (bw-8qrr.3).
 *
 * Every call the panel makes used to end in silence. A push that worked drew
 * nothing at all, and a push that failed put git's words in a red panel that
 * the panel's own five-second re-read wiped off the screen moments later
 * (bw-8qrr.1) — so the everyday experience of the Git rail was pressing a
 * button and being told nothing either way.
 *
 * A toast is the answer because it outlives the view it was raised from: it is
 * not erased by a re-read, it is not scrolled past, and it is still there when
 * the reader looks back from whatever they went to do while the push ran.
 *
 * The words are labels, not sentences. "Pushed", "Push failed", "Switched" —
 * a toast is read in the corner of an eye that is looking somewhere else, and
 * anything that has to be read twice has failed at the one thing it is for.
 * The line under the label is the same: `ours → origin/ours`, `3 files`, the
 * one line of git's that says what went wrong. git's words whole stay where
 * they were, in the panel, for a reader who wants to read them.
 */
'use client';

import {
  Check,
  CloudDownload,
  Download,
  GitBranch,
  GitCommitVertical,
  Loader2,
  Minus,
  Plus,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  type LucideIcon,
} from 'lucide-react';

import { toast } from '@/hooks/use-toast';

/** One thing the panel can do to a repository. */
export type GitDeed =
  | 'fetch'
  | 'pull'
  | 'push'
  | 'commit'
  | 'amend'
  | 'checkout'
  | 'discard'
  | 'remove'
  | 'stage'
  | 'unstage';

/** The three words an operation is known by, and the mark it carries. */
interface DeedWords {
  icon: LucideIcon;
  /** While it runs. */
  doing: string;
  /** When it worked. */
  done: string;
  /** When it did not. */
  failed: string;
}

/**
 * The whole vocabulary, in one place.
 *
 * One table rather than a word chosen at each call site: "Push failed" has to
 * read the same wherever a push is made from, and a label written twice is a
 * label that will be written differently the second time.
 */
const DEEDS: Record<GitDeed, DeedWords> = {
  fetch: { icon: CloudDownload, doing: 'Fetching', done: 'Fetched', failed: 'Fetch failed' },
  pull: { icon: Download, doing: 'Pulling', done: 'Pulled', failed: 'Pull failed' },
  push: { icon: Upload, doing: 'Pushing', done: 'Pushed', failed: 'Push failed' },
  commit: { icon: GitCommitVertical, doing: 'Committing', done: 'Committed', failed: 'Commit failed' },
  amend: { icon: GitCommitVertical, doing: 'Amending', done: 'Amended', failed: 'Amend failed' },
  checkout: { icon: GitBranch, doing: 'Switching', done: 'Switched', failed: 'Switch failed' },
  discard: { icon: Undo2, doing: 'Discarding', done: 'Discarded', failed: 'Discard failed' },
  remove: { icon: Trash2, doing: 'Removing', done: 'Removed', failed: 'Remove failed' },
  stage: { icon: Plus, doing: 'Staging', done: 'Staged', failed: 'Stage failed' },
  unstage: { icon: Minus, doing: 'Unstaging', done: 'Unstaged', failed: 'Unstage failed' },
};

/** Long enough that nothing dismisses a running toast but the call finishing. */
const WHILE_IT_RUNS_MS = 24 * 60 * 60 * 1000;

/** A confirmation has been read the moment it is seen. */
const WORKED_MS = 4_000;

/** A failure carries a reason, so it is given time to be read. */
const FAILED_MS = 10_000;

/** Longer than this and it is not a label any more. */
const MOST = 140;

/**
 * The one line of git's worth putting under a label.
 *
 * git leads with where it was going — `To github.com:…` — and says what
 * actually went wrong on the line after, so the first line is regularly the
 * least useful one there is. The lines git marks itself are preferred, and its
 * own marker comes off: the toast already says "Push failed", and `fatal:` on
 * top of that is the same word twice.
 */
export function theShortOfIt(said: string): string {
  const lines = said
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const pointed = lines.find(
    (line) => line.startsWith('!') || line.startsWith('fatal:') || line.startsWith('error:'),
  );
  const line = (pointed ?? lines[0] ?? 'git gave no reason').replace(
    /^(!|fatal:|error:)\s*/,
    '',
  );
  return line.length > MOST ? `${line.slice(0, MOST - 1)}…` : line;
}

/** What a raised toast can be told once the call it belongs to answers. */
export interface DeedReport {
  /** It did what it said; `note` is the short of what it did. */
  worked: (note?: string) => void;
  /** It did not, and `said` is git's own answer. */
  failed: (said: string) => void;
  /**
   * Neither, and nothing is owed to the reader — the call has stopped to ask
   * for something, and the asking is on screen. The toast goes rather than
   * sitting there spinning behind a dialog.
   */
  letGo: () => void;
}

/**
 * Say an operation has started, and hand back the way to say how it ended.
 *
 * The toast is raised before the call rather than after it, and the same toast
 * becomes the answer: a reader who pressed Push sees "Pushing" for as long as
 * the push takes and then watches that very toast turn into "Pushed". Two
 * toasts — one to start, one to finish — would tell the same story twice.
 */
export function reportOn(deed: GitDeed, note?: string): DeedReport {
  const words = DEEDS[deed];
  const raised = toast({
    variant: 'running',
    icon: <Loader2 className="size-4 animate-spin text-t-tertiary motion-reduce:animate-none" />,
    title: words.doing,
    description: note,
    duration: WHILE_IT_RUNS_MS,
  });

  return {
    worked: (ended) =>
      raised.update({
        id: raised.id,
        open: true,
        variant: 'success',
        icon: <Check className="size-4 text-success" />,
        title: words.done,
        description: ended ?? note,
        duration: WORKED_MS,
      }),
    failed: (said) =>
      raised.update({
        id: raised.id,
        open: true,
        variant: 'danger',
        icon: <TriangleAlert className="size-4 text-danger" />,
        title: words.failed,
        description: theShortOfIt(said),
        duration: FAILED_MS,
      }),
    letGo: () => raised.dismiss(),
  };
}

/**
 * The same, for an operation whose result is already on the screen.
 *
 * Staging a file moves it from one list to the next, in front of the reader,
 * the moment it happens — so a toast saying "Staged" is the app telling
 * somebody a thing they just watched. Ticking through a dozen files would be a
 * dozen of them. A failure is the other way round: nothing visible happens at
 * all, and without a toast the tick simply springs back with no reason given.
 * So this is silent until something goes wrong, and then says so exactly as
 * loudly as anything else here.
 */
export function quietlyOn(deed: GitDeed, note?: string): DeedReport {
  const words = DEEDS[deed];
  return {
    worked: () => {},
    letGo: () => {},
    failed: (said) => {
      toast({
        variant: 'danger',
        icon: <TriangleAlert className="size-4 text-danger" />,
        title: words.failed,
        description: note ? `${note} — ${theShortOfIt(said)}` : theShortOfIt(said),
        duration: FAILED_MS,
      });
    },
  };
}

/** `3 files`, `1 file` — the whole of what a toast needs to say about a set. */
export function howManyFiles(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`;
}
