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

/** Past the estimate, where the bar has stopped moving and the wait is open-ended. */
export function summaryOverrun(elapsedMs: number, typicalMs: number = SUMMARY_TYPICAL_MS): boolean {
  return typicalMs > 0 && elapsedMs >= typicalMs;
}
