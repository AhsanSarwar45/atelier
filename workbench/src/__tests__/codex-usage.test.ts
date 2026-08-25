/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({}));

import { readCodexUsage } from '../codex-usage';

describe('Codex account usage', () => {
  it('keeps the session and weekly windows with their reset times', () => {
    const usage = readCodexUsage({ rateLimits: {
      planType: 'pro',
      primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { usedPercent: 48, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
      credits: { hasCredits: true, unlimited: false },
    } }, '2026-08-25T00:00:00.000Z');
    expect(usage).toMatchObject({
      available: true, plan: 'pro',
      session: { percent: 31, resetsAt: new Date(1_800_000_000_000).toISOString() },
      week: { percent: 48, resetsAt: new Date(1_800_500_000_000).toISOString() },
      credits: { enabled: true },
    });
  });
});
