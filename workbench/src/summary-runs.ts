/**
 * How long a compaction takes in THIS project, measured rather than assumed.
 *
 * The bar over a summarising chat has to fill against a number, and the only
 * number that existed was the median of 453 runs recorded across this whole
 * machine (summarising.ts). That is nobody's number in particular: a long
 * conversation in a large repository summarises for longer than a short one, on
 * the same machine, on the same day. So the app watches its own runs — every
 * project it has ever drawn a bar for accumulates a history — and fills the bar
 * against that project's middle run once it has seen enough of them.
 *
 * Measured, not reported. The tool fires a hook as a compaction BEGINS and none
 * as it ends (doing-told.ts), so a run's end is the first beat on which the chat
 * stopped saying it was summarising. That is the same beat the screen stops
 * drawing the bar on, which makes the thing measured exactly the thing the bar
 * is filling against.
 *
 * The disk is somebody else's job. This file holds the runs in flight and does
 * the arithmetic; where finished runs are written down is injected, so the
 * reading of a beat can be proved without a database (bw-jaoz.14.9).
 */
import { ownSummaryMedian } from '../../src/workbench/summarising.ts';

import type { Doing } from '../../src/workbench/chat-state.ts';

/** A finished run, ready to be written down. */
export interface SummaryRun {
  /** The project it happened in, which for a held chat is its working directory. */
  project: string;
  sessionId: string;
  /** When it ended, ms since the epoch. */
  at: number;
  ms: number;
}

/**
 * Longer than this and it was not a run.
 *
 * A laptop closed mid-compaction and opened the next morning leaves a chat that
 * was summarising eleven hours ago and is not now, and nothing on the machine
 * can tell that from a compaction that took eleven hours. Discarded rather than
 * clamped: a made-up number in the history is worse than a gap in it, because
 * the history is what every later bar is measured against.
 */
export const SUMMARY_RUN_CAP_MS = 1_800_000;

/** One chat as one beat sees it. */
export interface BeatOfAChat {
  id: string;
  project: string;
  doing: Doing;
  /** When it started doing that, for a run whose beginning we arrived after. */
  since: number | null;
}

/** Runs in flight, by chat. Module state, like the burst clock beside it. */
const began = new Map<string, { project: string; at: number }>();

/**
 * Read one beat: start the runs that began, finish the runs that ended.
 *
 * Nothing is written for a chat that vanished between beats — its process was
 * killed in the middle of a compaction, and the run it was in the middle of
 * never happened as far as any estimate is concerned.
 */
export function noteSummaryRuns(beat: BeatOfAChat[], now: number, write: (run: SummaryRun) => void): void {
  const here = new Set<string>();
  for (const chat of beat) {
    here.add(chat.id);
    const had = began.get(chat.id);
    if (chat.doing === 'summarising') {
      // `since` and not `now`: the sidecar restarts, or the app opens, in the
      // middle of somebody's compaction, and the state carries when it began.
      if (!had) began.set(chat.id, { project: chat.project, at: chat.since ?? now });
      continue;
    }
    if (!had) continue;
    began.delete(chat.id);
    const ms = now - had.at;
    if (ms > 0 && ms <= SUMMARY_RUN_CAP_MS) write({ project: had.project, sessionId: chat.id, at: now, ms });
  }
  began.forEach((_, id) => {
    if (!here.has(id)) began.delete(id);
  });
}

/** Forget every run in flight. For a test that wants a clean machine. */
export function forgetSummaryRuns(): void {
  began.clear();
}

/**
 * Where measured runs are kept, as the reading of a beat needs to see it.
 *
 * An interface rather than the store itself, so nothing in the path that reads
 * chats opens a database, and so a beat can be proved against a handful of
 * numbers in memory.
 */
export interface SummaryMemory {
  note(run: SummaryRun): void;
  /** This project's own median, or null while it has not enough runs of its own. */
  typical(project: string): number | null;
}

/**
 * The memory backed by the sidecar's own store.
 *
 * The median is cached per project and dropped when that project records a new
 * run, because `typical` is asked on every beat of every summarising chat and
 * the answer changes a few times an hour at most.
 */
export function summaryMemoryOf(store: {
  noteSummaryRun(run: SummaryRun): void;
  summaryRuns(project: string, limit?: number): number[];
}): SummaryMemory {
  const known = new Map<string, number | null>();
  return {
    note(run) {
      store.noteSummaryRun(run);
      known.delete(run.project);
    },
    typical(project) {
      if (known.has(project)) return known.get(project) ?? null;
      const answer = ownSummaryMedian(store.summaryRuns(project));
      known.set(project, answer);
      return answer;
    },
  };
}
