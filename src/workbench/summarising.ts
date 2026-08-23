/**
 * How full the bar is while a chat is summarising itself.
 *
 * Summarising is the one thing a chat does that a reader cannot see the end of
 * and cannot interrupt: no line is written while it runs, the command card
 * above it is whatever was last run, and the only honest thing on the screen is
 * a clock counting up. It is also the one thing whose length we can predict —
 * 453 compaction boundaries recorded on this machine put the middle run at
 * 124 seconds, with half of them between 108 and 140 (bw-jaoz.14.2). A bar
 * against that median says "about here" the way a clock never can.
 *
 * The bar is only ever for this one state. Everything else a chat does is
 * open-ended — a think can be four seconds or four minutes — and a bar filling
 * against a number nobody measured is a lie drawn in a straight line.
 *
 * It stops at 95 percent and waits. The estimate is a median, so half of all
 * runs are longer than it, and a bar that reached the end and sat there would
 * say finished while the work went on. The last five percent belongs to the
 * finish itself, whenever it actually lands.
 */

/**
 * The middle of 453 runs measured on this machine, in milliseconds.
 *
 * A default, not a constant of nature: a slower machine or a longer
 * conversation summarises for longer, and callers with a measured length of
 * their own should pass it.
 */
export const SUMMARY_TYPICAL_MS = 124_000;

/** As far as the bar fills before the finish itself lands. */
export const SUMMARY_HELD_AT = 0.95;

/**
 * How full the bar is, from 0 to {@link SUMMARY_HELD_AT}.
 *
 * Reaches its hold exactly at the estimate — so a run of typical length arrives
 * at the far end just as it finishes — and stays there however long the rest
 * takes. Never returns 1: filling the last of it is the finish's job, and the
 * finish is a different state.
 */
export function summaryFill(elapsedMs: number, typicalMs: number = SUMMARY_TYPICAL_MS): number {
  if (!(typicalMs > 0)) return SUMMARY_HELD_AT;
  if (elapsedMs <= 0) return 0;
  return Math.min(SUMMARY_HELD_AT, (elapsedMs / typicalMs) * SUMMARY_HELD_AT);
}

/**
 * How many runs of its own a project needs before its median is used.
 *
 * A median of two is not a median; it is whichever of the two was slower. Below
 * this the machine-wide number stands in, because a bar filling against one
 * measurement is less honest than one filling against 453.
 */
export const SUMMARY_RUNS_ENOUGH = 5;

/**
 * The middle of the runs THIS project actually took, or null while it has not
 * taken enough of them.
 *
 * Null rather than a number, so the caller decides what to stand in — and so
 * "we have not watched this project summarise yet" is a different answer from
 * "this project summarises in 124 seconds".
 */
export function ownSummaryMedian(runs: number[], enough = SUMMARY_RUNS_ENOUGH): number | null {
  const sane = runs.filter((ms) => ms > 0).sort((a, b) => a - b);
  if (sane.length < enough) return null;
  const mid = Math.floor(sane.length / 2);
  return sane.length % 2 === 1 ? sane[mid]! : Math.round((sane[mid - 1]! + sane[mid]!) / 2);
}

/**
 * What the bar should fill against for a project, given the runs it has taken.
 *
 * Every project summarises at its own length: a long conversation in a large
 * repository takes longer than a short one on the same machine, and the median
 * of 453 runs across all of them is nobody's number in particular. So a project
 * the app has watched enough of is measured against itself, and the
 * machine-wide figure stands in until then (bw-jaoz.14.9).
 */
export function typicalSummaryMs(runs: number[], enough = SUMMARY_RUNS_ENOUGH): number {
  return ownSummaryMedian(runs, enough) ?? SUMMARY_TYPICAL_MS;
}

/** Past the estimate, where the bar has stopped moving and the wait is open-ended. */
export function summaryOverrun(elapsedMs: number, typicalMs: number = SUMMARY_TYPICAL_MS): boolean {
  return typicalMs > 0 && elapsedMs >= typicalMs;
}
