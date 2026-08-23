/**
 * @vitest-environment node
 *
 * The app watching a compaction begin and end (bw-jaoz.14.9).
 *
 * The bar over a summarising chat filled against one number for every project
 * on the machine — the middle of 453 runs recorded across all of them. A long
 * conversation in a large repository is not that number and never was. So each
 * run is now timed where it happens, and a project with a history of its own is
 * measured against itself.
 *
 * Nothing here touches a database: the beat is read against a handful of numbers
 * in memory, which is the whole reason the writing-down is injected.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { SUMMARY_RUNS_ENOUGH, SUMMARY_TYPICAL_MS, typicalSummaryMs } from '../../../src/workbench/summarising.ts';
import {
  SUMMARY_RUN_CAP_MS,
  forgetSummaryRuns,
  noteSummaryRuns,
  summaryMemoryOf,
} from '../summary-runs.ts';
import type { BeatOfAChat, SummaryRun } from '../summary-runs.ts';

const HERE = '/home/ahsan/dev/beads-web';
const NOW = 1_787_138_400_000;

/** One chat on one beat. */
function beat(doing: BeatOfAChat['doing'], since: number | null, id = 'ef56704b'): BeatOfAChat[] {
  return [{ id, project: HERE, doing, since }];
}

/** Read a sequence of beats, and hand back everything written down. */
function watch(beats: Array<{ at: number; chats: BeatOfAChat[] }>): SummaryRun[] {
  const written: SummaryRun[] = [];
  for (const b of beats) noteSummaryRuns(b.chats, b.at, (run) => written.push(run));
  return written;
}

beforeEach(forgetSummaryRuns);

describe('timing one run', () => {
  it('writes down how long it took, once it has ended', () => {
    const written = watch([
      { at: NOW, chats: beat('summarising', NOW) },
      { at: NOW + 30_000, chats: beat('summarising', NOW) },
      { at: NOW + 47_000, chats: beat('idle', null) },
    ]);
    expect(written).toEqual([{ project: HERE, sessionId: 'ef56704b', at: NOW + 47_000, ms: 47_000 }]);
  });

  it('writes nothing while it is still running', () => {
    expect(
      watch([
        { at: NOW, chats: beat('summarising', NOW) },
        { at: NOW + 90_000, chats: beat('summarising', NOW) },
      ]),
      'a run half done is not a measurement',
    ).toEqual([]);
  });

  it('counts from when the run began, not from when we first looked', () => {
    // The sidecar restarts, or the app opens, in the middle of somebody's
    // compaction. The state carries when it started, so the length is right.
    const written = watch([
      { at: NOW + 60_000, chats: beat('summarising', NOW) },
      { at: NOW + 100_000, chats: beat('answering', null) },
    ]);
    expect(written[0]?.ms).toBe(100_000);
  });

  it('counts the next run on its own, not from the first one', () => {
    const written = watch([
      { at: NOW, chats: beat('summarising', NOW) },
      { at: NOW + 40_000, chats: beat('idle', null) },
      { at: NOW + 600_000, chats: beat('summarising', NOW + 600_000) },
      { at: NOW + 650_000, chats: beat('idle', null) },
    ]);
    expect(written.map((r) => r.ms)).toEqual([40_000, 50_000]);
  });
});

describe('what is not a run', () => {
  it('a chat killed in the middle of one, which never ended at all', () => {
    // Its process is gone, so it is absent from the beat rather than doing
    // something else. Nothing may be written: we have no idea how long it had
    // left to go.
    const written = watch([
      { at: NOW, chats: beat('summarising', NOW) },
      { at: NOW + 20_000, chats: [] },
      { at: NOW + 25_000, chats: beat('idle', null) },
    ]);
    expect(written).toEqual([]);
  });

  it('a machine that slept through one and woke up hours later', () => {
    const written = watch([
      { at: NOW, chats: beat('summarising', NOW) },
      { at: NOW + SUMMARY_RUN_CAP_MS + 1, chats: beat('idle', null) },
    ]);
    expect(written, 'eleven hours is a closed laptop, not a compaction').toEqual([]);
    // The bound itself still counts, so a genuinely slow run is not thrown away.
    forgetSummaryRuns();
    expect(
      watch([
        { at: NOW, chats: beat('summarising', NOW) },
        { at: NOW + SUMMARY_RUN_CAP_MS, chats: beat('idle', null) },
      ]).length,
    ).toBe(1);
  });

  it('two chats at once, each timed against its own beginning', () => {
    const both = (a: BeatOfAChat['doing'], b: BeatOfAChat['doing']): BeatOfAChat[] => [
      { id: 'one', project: HERE, doing: a, since: NOW },
      { id: 'two', project: '/home/ahsan/dev/other', doing: b, since: NOW + 10_000 },
    ];
    const written = watch([
      { at: NOW, chats: both('summarising', 'thinking') },
      { at: NOW + 10_000, chats: both('summarising', 'summarising') },
      { at: NOW + 50_000, chats: both('idle', 'summarising') },
      { at: NOW + 80_000, chats: both('idle', 'idle') },
    ]);
    expect(written).toEqual([
      { project: HERE, sessionId: 'one', at: NOW + 50_000, ms: 50_000 },
      { project: '/home/ahsan/dev/other', sessionId: 'two', at: NOW + 80_000, ms: 70_000 },
    ]);
  });
});

describe('what the bar is then filled against', () => {
  /** A store's worth of runs, kept in memory. */
  function memoryOf(runs: number[]) {
    const kept = new Map<string, number[]>([[HERE, [...runs]]]);
    let reads = 0;
    const memory = summaryMemoryOf({
      noteSummaryRun(run) {
        kept.set(run.project, [run.ms, ...(kept.get(run.project) ?? [])]);
      },
      summaryRuns(project) {
        reads += 1;
        return kept.get(project) ?? [];
      },
    });
    return { memory, reads: () => reads };
  }

  it('nothing, until this project has enough runs of its own', () => {
    const { memory } = memoryOf([40_000, 40_000]);
    expect(memory.typical(HERE)).toBeNull();
    expect(typicalSummaryMs([]), 'and the bar then fills against the machine').toBe(SUMMARY_TYPICAL_MS);
  });

  it("this project's middle run, once it has", () => {
    const { memory } = memoryOf(Array.from({ length: SUMMARY_RUNS_ENOUGH }, () => 40_000));
    expect(memory.typical(HERE)).toBe(40_000);
    expect(memory.typical('/nowhere/we/have/watched')).toBeNull();
  });

  it('asks the store once and remembers, because every beat asks it again', () => {
    const { memory, reads } = memoryOf(Array.from({ length: SUMMARY_RUNS_ENOUGH }, () => 40_000));
    for (let i = 0; i < 20; i++) memory.typical(HERE);
    expect(reads(), 'a screenful of chats must not be a screenful of queries').toBe(1);
  });

  it('forgets what it remembered as soon as a new run lands', () => {
    const { memory } = memoryOf([90_000, 90_000, 90_000, 90_000, 90_000]);
    expect(memory.typical(HERE)).toBe(90_000);
    for (let i = 0; i < 5; i++) memory.note({ project: HERE, sessionId: `s${i}`, at: NOW, ms: 30_000 });
    // Five slow runs and five quick ones: the middle of the ten has moved.
    expect(memory.typical(HERE)).toBe(60_000);
  });
});
