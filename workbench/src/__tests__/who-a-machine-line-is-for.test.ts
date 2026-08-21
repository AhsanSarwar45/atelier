/**
 * @vitest-environment node
 *
 * The driver settles who a line is for, because only the driver knows the state.
 *
 * "Allowance: the seven-day window is allowed_warning until 12:00 PM", drawn in
 * the manager's own group, 2026-08-21. The screen had nothing to sort on but
 * how loud the line was, and loudness puts a window merely filling up in the
 * same bucket as one that has stopped his work. The state that tells them apart
 * only ever exists here, so the answer is decided here and carried on the note
 * (bw-iiv6).
 */
import { describe, expect, it } from 'vitest';

import { ClaudeDriver } from '../drivers/claude.ts';

type Said = { type: string; kind?: string; text?: string; audience?: string; rank?: string };

/** Every note one driver emits while it is fed these messages. */
function notesFrom(messages: Record<string, unknown>[]): Said[] {
  const said: Said[] = [];
  const driver = new ClaudeDriver();
  (driver as unknown as { emit: (e: Said) => void }).emit = (e) => {
    if (e.type === 'note') said.push(e);
  };
  for (const m of messages) driver.draw(m);
  return said;
}

/** One allowance message as the kit sends it. */
const allowance = (status: string, extra: Record<string, unknown> = {}) => ({
  type: 'rate_limit_event',
  rate_limit_info: { status, rateLimitType: 'seven_day', resetsAt: 1_700_000_000, ...extra },
});

describe('an allowance line', () => {
  it('keeps a window that is merely filling up on the machine\'s own side', () => {
    const [low] = notesFrom([allowance('allowed_warning')]);
    expect(low.audience).toBe('machine');
    expect(low.text).toContain('Your weekly allowance is running low');
    expect(low.text).not.toContain('allowed_warning');
    expect(low.text).not.toContain('seven_day');
  });

  it('puts a window that has stopped his work in front of him, and says so', () => {
    const [out] = notesFrom([allowance('rejected')]);
    expect(out.audience).toBe('you');
    expect(out.rank).toBe('note');
    expect(out.text).toContain('has run out');
    expect(out.text).toContain('nothing more runs until');
  });

  it('reads the one state the kit files somewhere else entirely', () => {
    // Needing credits arrives on `errorCode`, beside a rejected status, and
    // never on `status` itself — so a screen sorting on status alone cannot see
    // that there is now something to buy.
    const [pay] = notesFrom([allowance('rejected', { errorCode: 'credits_required' })]);
    expect(pay.audience).toBe('you');
    expect(pay.text).toContain('buying credits');
  });

  it('stays readable, and quiet, about a state this build has never met', () => {
    const [odd] = notesFrom([allowance('throttled_by_something_new')]);
    expect(odd.audience).toBe('machine');
    expect(odd.text).not.toContain('throttled_by_something_new');
  });
});
