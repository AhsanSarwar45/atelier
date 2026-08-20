/**
 * @vitest-environment node
 *
 * Where the account's plan figure comes from, and how often.
 *
 * The complaint: the chips on a chat that was doing nothing sat still while
 * another chat spent, and the figure served was measured going 44%, 38%, 47%
 * with nothing running at all — the 38% being exactly the five-minute-old
 * snapshot the kit keeps on disk and hands back, without saying so, whenever
 * its live read fails (bw-dmoe).
 *
 * Two things had to change and both are checked here: the figure is read on
 * this server's own beat and pushed to whoever is watching, rather than being
 * whatever the last page happened to ask for; and an answer whose window has
 * gone backwards under an unmoved reset time is refused, so the last good one
 * stands until a real one arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every answer the fake kit will give, in order; the last one repeats. */
let answers: unknown[] = [];
/** How many times the kit was asked, and how many probers were ever started. */
let asked = 0;
let started = 0;

function limits(sessionPercent: number, resetsAt: string): unknown {
  return {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: sessionPercent, resets_at: resetsAt },
      seven_day: { utilization: 70, resets_at: '2026-08-23T08:00:00Z' },
    },
  };
}

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    started++;
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
        const next = answers[Math.min(asked, answers.length - 1)];
        asked++;
        return Promise.resolve(next);
      },
      close: () => {},
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    };
  },
}));

async function freshModule() {
  vi.resetModules();
  return await import('../plan-usage.ts');
}

beforeEach(() => {
  answers = [];
  asked = 0;
  started = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the account figure', () => {
  it('is read on the server’s own beat and pushed to whoever is watching', async () => {
    answers = [limits(40, '2026-08-20T22:20:00Z'), limits(47, '2026-08-20T22:20:00Z')];
    const { watchUsage, usageNow, stopProbing } = await freshModule();

    const heard: (number | null | undefined)[] = [];
    const stop = watchUsage((u) => heard.push(u.session?.percent));
    await vi.advanceTimersByTimeAsync(0);
    expect(heard, 'nothing was said to the page that just started watching').toEqual([40]);

    // Half a minute later the server has asked again on its own — no page asked
    // for it, and no chat has taken a turn.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heard).toEqual([40, 47]);
    expect(usageNow()?.session?.percent).toBe(47);

    // One helper of our own answered both times: the figure never depends on
    // which chat happens to be running.
    expect(started, 'a second helper was started').toBe(1);

    stop();
    // Nobody is watching, so nothing is read.
    const asAsked = asked;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(asked, 'it kept reading with nobody watching').toBe(asAsked);
    stopProbing();
  });

  it('refuses an answer that has gone backwards, and takes the next good one', async () => {
    answers = [
      limits(44, '2026-08-20T22:20:00Z'),
      // The kit's own snapshot: older, smaller, and the window it belongs to
      // has not rolled — its reset time is the same one.
      limits(38, '2026-08-20T22:20:00Z'),
      limits(47, '2026-08-20T22:20:00Z'),
    ];
    const { watchUsage, usageNow, stopProbing } = await freshModule();

    const heard: (number | null | undefined)[] = [];
    const stop = watchUsage((u) => heard.push(u.session?.percent));
    await vi.advanceTimersByTimeAsync(0);
    expect(heard).toEqual([44]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(heard, 'the snapshot was drawn and the chip walked backwards').toEqual([44]);
    expect(usageNow()?.session?.percent, 'the last good reading did not stand').toBe(44);

    // A refused answer is asked for again shortly rather than leaving the chip
    // half a minute behind.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(heard).toEqual([44, 47]);

    stop();
    stopProbing();
  });

  it('believes a fall when the window it belongs to has rolled', async () => {
    answers = [limits(96, '2026-08-20T22:20:00Z'), limits(3, '2026-08-21T03:20:00Z')];
    const { watchUsage, stopProbing } = await freshModule();

    const heard: (number | null | undefined)[] = [];
    const stop = watchUsage((u) => heard.push(u.session?.percent));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heard, 'a fresh five-hour window was refused as a stale answer').toEqual([96, 3]);

    stop();
    stopProbing();
  });
});
