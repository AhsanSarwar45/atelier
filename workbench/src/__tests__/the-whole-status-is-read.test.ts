/**
 * @vitest-environment node
 *
 * Three lines that were built from half the message they came in.
 *
 * The manager asked, after the first sweep of this job, whether there was more
 * wrong. There was, and all three faults are the same fault: a line written
 * from the fields somebody happened to read, and silent about the rest of what
 * the kit had sent.
 *
 *  - His allowance carries a SECOND window behind it — paid overflow, with its
 *    own status and its own reasons for being shut. None of it was read, so a
 *    chat that could not spend another penny said "Your weekly allowance is
 *    fine." (bw-iiv6.16)
 *  - A model that refused with nothing left to try drew a completely blank
 *    row when the refusal carried no words of its own (bw-iiv6.17).
 *  - A chat whose program stopped said "Shutting down: host_exit" — the kit's
 *    own code word, which its type file spells out as one (bw-iiv6.19).
 *
 * Held here at the driver, because that is where the sentence is built. What
 * the chat then DOES with the sentence — which group it lands in, whether he
 * sees it — is machine-lines' half, and is held in its own tests.
 */
import { describe, expect, it } from 'vitest';

import { ClaudeDriver } from '../drivers/claude.ts';

type Said = { type: string; kind?: string; text?: string; audience?: string };

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

/** One allowance message, with whatever the overflow behind it is doing. */
const allowance = (info: Record<string, unknown>): Record<string, unknown> => ({
  type: 'rate_limit_event',
  rate_limit_info: { rateLimitType: 'seven_day', status: 'allowed', resetsAt: 1787227200, ...info },
});

describe('an allowance line reads the whole allowance', () => {
  it('says when there is nothing behind a window that is otherwise fine', () => {
    const [said] = notesFrom([allowance({ overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' })]);

    expect(said.text).toContain('There is no extra usage behind it: you are out of credits.');
    // The window itself has room, so the line is still the machine's own books.
    expect(said.audience).toBe('machine');
  });

  it('names whose switch it is when the block is not his to lift', () => {
    const [said] = notesFrom([
      allowance({ overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled' }),
    ]);

    expect(said.text).toContain('your organisation has turned it off');
  });

  it('says so when the overflow is running low, and when he is already on it', () => {
    expect(notesFrom([allowance({ overageStatus: 'allowed_warning' })])[0].text)
      .toContain('The extra usage behind it is running low.');
    expect(notesFrom([allowance({ overageStatus: 'allowed', isUsingOverage: true })])[0].text)
      .toContain('You are running on extra usage now.');
  });

  it('leaves the ordinary line alone', () => {
    // Nothing behind it to report is the common case, and it adds no clause.
    // The clock is the reader's own, so only its shape is held here.
    expect(notesFrom([allowance({})])[0].text).toMatch(/^Your weekly allowance is fine \(it renews at .+\)\.$/);
  });

  it('keeps the closed window as the sentence when both are shut', () => {
    // A window that has actually stopped his work is the thing to read; the
    // overflow is only ever the clause on the end.
    const [said] = notesFrom([
      allowance({ status: 'rejected', overageStatus: 'rejected', overageDisabledReason: 'out_of_credits' }),
    ]);

    expect(said.text).toMatch(/^Your weekly allowance has run out — nothing more runs until/);
    expect(said.audience).toBe('you');
  });

  it('never draws a word off the wire, whatever the overflow says', () => {
    for (const why of ['out_of_credits', 'org_level_disabled', 'a_reason_nobody_here_has_met']) {
      const [said] = notesFrom([allowance({ overageStatus: 'rejected', overageDisabledReason: why })]);
      expect(String(said.text), why).not.toContain(why);
    }
  });
});

describe('a refusal with nothing left to try', () => {
  it('says what happened when the refusal brought no words of its own', () => {
    const [said] = notesFrom([
      { type: 'system', subtype: 'model_refusal_no_fallback', original_model: 'claude-opus-5', content: '' },
    ]);

    expect(said.text).toBe('claude-opus-5 would not answer, and there was nothing else to try.');
  });

  it('adds the reason when the kit gives one', () => {
    const [said] = notesFrom([
      {
        type: 'system',
        subtype: 'model_refusal_no_fallback',
        original_model: 'claude-opus-5',
        content: '',
        api_refusal_explanation: 'the request was declined',
      },
    ]);

    expect(said.text).toBe('claude-opus-5 would not answer, and there was nothing else to try: the request was declined.');
  });

  it('quotes the refusal itself when there is one, rather than talking over it', () => {
    const [said] = notesFrom([
      { type: 'system', subtype: 'model_refusal_no_fallback', content: 'I cannot help with that.' },
    ]);

    expect(said.text).toBe('I cannot help with that.');
  });
});

describe('a chat whose program stops', () => {
  it('says why in English, not in the host’s own code word', () => {
    const [said] = notesFrom([{ type: 'system', subtype: 'worker_shutting_down', reason: 'host_exit' }]);

    expect(said.text).toBe('This chat stopped running: the app it was running under closed.');
    expect(said.text).not.toContain('host_exit');
  });

  it('puts a reason nobody here has met into words rather than quoting it', () => {
    const [said] = notesFrom([
      { type: 'system', subtype: 'worker_shutting_down', reason: 'some_new_reason' },
    ]);

    expect(said.text).toBe('This chat stopped running: some new reason.');
  });

  it('says the one thing it knows when the reason is missing', () => {
    // It used to end on a dangling colon and say nothing at all after it.
    expect(notesFrom([{ type: 'system', subtype: 'worker_shutting_down' }])[0].text)
      .toBe('This chat stopped running.');
  });
});
