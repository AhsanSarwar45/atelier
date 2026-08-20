/**
 * Reading the kit's own `/usage` answer.
 *
 * The fixture beside this file is not written by hand: it is the answer this
 * machine's kit actually gave on 2026-08-20, saved verbatim. That matters,
 * because the published type for that answer is not what comes back — the
 * windows arrive twice (named fields AND a `limits[]` array), there are
 * codenamed windows no plan of ours has, and the dollar figures are null on a
 * subscription. A hand-written fixture would agree with the type and disagree
 * with reality (bw-malh).
 */
import { describe, expect, it } from 'vitest';

import {
  chipReads,
  clockReads,
  CRITICAL_AT,
  percentReads,
  type RawPlanUsage,
  readUsage,
  sessionChipReads,
  severityOf,
  untilReads,
  WARN_AT,
  weekChipReads,
  windowReads,
} from '@/workbench/plan-usage';

import answer from './fixtures/usage-answer.json';

const AT = '2026-08-20T08:00:00.000Z';
const REAL = answer as RawPlanUsage;

describe('the answer the kit actually gives', () => {
  const usage = readUsage(REAL, AT);

  it('finds the five-hour window the terminal calls the session', () => {
    expect(usage.available).toBe(true);
    expect(usage.plan).toBe('max');
    expect(usage.session).toEqual({
      key: 'session',
      label: 'This session',
      percent: 74,
      resetsAt: '2026-08-20T09:49:59.833280+00:00',
      severity: 'normal',
    });
  });

  it('finds the weekly window, and the one scoped to a model', () => {
    expect(usage.week?.percent).toBe(60);
    expect(usage.week?.resetsAt).toBe('2026-08-23T07:59:59.833299+00:00');
    expect(usage.perModel).toHaveLength(1);
    expect(usage.perModel[0].label).toBe('This week · Fable');
    expect(usage.perModel[0].percent).toBe(13);
  });

  it('ignores the codenamed windows no plan of ours has', () => {
    // `nimbus_quill`, `tangelo`, `iguana_necktie` all ride along in the answer;
    // reading them would draw a chip for a limit nobody has.
    expect([usage.session?.key, usage.week?.key, ...usage.perModel.map((w) => w.key)]).toEqual([
      'session',
      'week',
      'model:Fable:0',
    ]);
  });

  it('says credits are off rather than saying nothing about them', () => {
    expect(usage.credits).toEqual({ enabled: false, percent: null, used: null, limit: null, currency: null });
  });

  it('carries what the machine says is driving the spend, in our words', () => {
    const week = usage.driving.find((d) => d.span === 'week');
    expect(week?.requests).toBe(37_672);
    expect(week?.sessions).toBe(606);
    expect(week?.traits[0]).toEqual({ key: 'subagent_heavy', label: 'Agents sent off', pct: 68 });
    expect(week?.agents.map((a) => a.name)).toEqual(['general-purpose', 'builder', 'lead']);
    expect(week?.skills).toEqual([{ name: 'report', pct: 5 }]);
    expect(week?.plugins).toEqual([]);
    expect(week?.servers).toEqual([{ name: 'chrome-devtools', pct: 2 }]);
    expect(usage.driving.map((d) => d.span)).toEqual(['day', 'week']);
  });

  it('stamps the answer with when it was read, not with the clock', () => {
    expect(usage.at).toBe(AT);
  });
});

describe('an account with no plan behind it', () => {
  it('draws nothing rather than a zero, on an API key', () => {
    // A zero there reads as "nothing spent", which is the opposite of the
    // truth: an API key has no plan window at all.
    const usage = readUsage({ subscription_type: null, rate_limits_available: false }, AT);
    expect(usage.available).toBe(false);
    expect(usage.session).toBeNull();
    expect(usage.week).toBeNull();
  });

  it('keeps the plan name when the limits are the only thing missing', () => {
    const usage = readUsage({ subscription_type: 'pro', rate_limits_available: false }, AT);
    expect(usage.plan).toBe('pro');
    expect(usage.available).toBe(false);
  });

  it('says nothing at all about no answer', () => {
    expect(readUsage(null, AT).available).toBe(false);
  });
});

describe('a build that sends no limits array', () => {
  it('falls back to the named windows beside it', () => {
    const usage = readUsage(
      {
        subscription_type: 'max',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 91, resets_at: '2026-08-20T09:00:00.000Z' },
          seven_day: { utilization: 40, resets_at: '2026-08-23T00:00:00.000Z' },
          model_scoped: [{ display_name: 'Opus', utilization: 12, resets_at: '2026-08-23T00:00:00.000Z' }],
        },
      },
      AT,
    );
    expect(usage.session?.percent).toBe(91);
    // No severity comes with the named form, so the reading has to supply one.
    expect(usage.session?.severity).toBe('warning');
    expect(usage.perModel[0].label).toBe('This week · Opus');
    expect(usage.perModel[0].percent).toBe(12);
  });

  it('drops a window that states neither a figure nor a reset', () => {
    const usage = readUsage(
      { subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: null, resets_at: null } } },
      AT,
    );
    expect(usage.session).toBeNull();
  });
});

describe('how much trouble a window is in', () => {
  it('takes the server at its word when it is more worried than we are', () => {
    expect(severityOf(3, 'critical')).toBe('critical');
    expect(severityOf(3, 'warning')).toBe('warning');
    expect(severityOf(3, 'exceeded')).toBe('critical');
  });

  it('does not let a calm server draw a calm chip at 99%', () => {
    expect(severityOf(99, 'normal')).toBe('critical');
    expect(severityOf(85, 'normal')).toBe('warning');
    expect(severityOf(WARN_AT - 1)).toBe('normal');
    expect(severityOf(WARN_AT)).toBe('warning');
    expect(severityOf(CRITICAL_AT)).toBe('critical');
  });

  it('is calm about a figure nobody stated', () => {
    expect(severityOf(null)).toBe('normal');
  });
});

describe('what the chip says', () => {
  const now = new Date('2026-08-20T08:00:00.000Z');

  it('leads with the percentage, because that is the question', () => {
    expect(chipReads({ key: 'session', label: 'This session', percent: 74, resetsAt: '2026-08-20T14:50:00Z', severity: 'normal' }, 'UTC')).toBe(
      '74% · resets 14:50',
    );
  });

  it('names both figures, because two bare percentages say which is which to nobody', () => {
    // Both are on the top line side by side (bw-malh.5), so each has to say
    // which window it is measuring without being hovered.
    expect(
      sessionChipReads({ key: 'session', label: 'This session', percent: 74, resetsAt: '2026-08-20T14:50:00Z', severity: 'normal' }, 'UTC'),
    ).toBe('5h 74% · resets 14:50');
    expect(weekChipReads({ key: 'week', label: 'This week', percent: 18, resetsAt: '2026-08-23T07:00:00Z', severity: 'normal' })).toBe('wk 18%');
  });

  it('leaves the week without a countdown, which is days away and belongs in the panel', () => {
    expect(weekChipReads({ key: 'week', label: 'This week', percent: null, resetsAt: null, severity: 'normal' })).toBe('wk —');
  });

  it('says only the percentage when nothing resets on a clock', () => {
    expect(chipReads({ key: 'session', label: 'This session', percent: 74, resetsAt: null, severity: 'normal' })).toBe('74%');
  });

  it('rounds rather than showing a percentage to four places', () => {
    expect(percentReads(73.6)).toBe('74%');
    expect(percentReads(null)).toBe('—');
  });

  it('spells the whole thing out for the tooltip', () => {
    expect(
      windowReads({ key: 'week', label: 'This week', percent: 60, resetsAt: '2026-08-20T10:30:00Z', severity: 'normal' }, now, 'UTC'),
    ).toBe('60% of this window used — resets 10:30 (in 2h 30m)');
    expect(windowReads({ key: 'week', label: 'This week', percent: null, resetsAt: null, severity: 'normal' }, now, 'UTC')).toBe(
      'Usage not reported',
    );
  });

  it('reads a bad time as no time rather than as NaN', () => {
    expect(clockReads('not a date')).toBeNull();
    expect(clockReads(null)).toBeNull();
    expect(untilReads('not a date', now)).toBeNull();
  });
});

describe('how long until it comes back', () => {
  const now = new Date('2026-08-20T08:00:00.000Z');

  it('counts down in the units a reader thinks in', () => {
    expect(untilReads('2026-08-20T08:09:00Z', now)).toBe('9m');
    expect(untilReads('2026-08-20T10:14:00Z', now)).toBe('2h 14m');
    expect(untilReads('2026-08-20T11:00:00Z', now)).toBe('3h');
    expect(untilReads('2026-08-23T11:00:00Z', now)).toBe('3d 3h');
    expect(untilReads('2026-08-23T08:00:00Z', now)).toBe('3d');
  });

  it('never says 0m, which reads as a stuck clock', () => {
    expect(untilReads('2026-08-20T08:00:30Z', now)).toBe('any moment');
    expect(untilReads('2026-08-20T07:00:00Z', now)).toBe('any moment');
  });
});
