/**
 * @vitest-environment node
 *
 * What a finished helper's row shows where its answer goes (bw-7ks.22.17).
 *
 * The text a helper hands back is written for the model that sent it: the kit
 * appends the helper's own id and a sentence about how to send it another
 * message. On a row about eighty characters wide, and in the pane's footer,
 * that trailer is most of what a reader gets — so the answer is taken from the
 * structured output beside it, which carries the report alone.
 *
 * It lives beside the sidecar because that is where the kit's messages are
 * read; nothing about this reaches the browser.
 */
import { describe, expect, it } from 'vitest';

import { answerOf } from '../drivers/claude.ts';

/** What a helper that answered DONE actually handed back, verbatim (2026-08-20). */
const REPORT = 'The 45-second sleep command completed successfully with no output, confirming the wait worked as expected.\nDONE';
const FOR_THE_MODEL = `${REPORT} agentId: ac8d9929e482d16e3 (use SendMessage with to: 'ac8d9929e482d16e3', summary: '<5-10 word recap>') to continue this conversation.`;

describe('what a helper answered', () => {
  it('is the report, not the kit’s instructions for talking to it again', () => {
    const answer = answerOf({ agentId: 'ac8d9929e482d16e3', content: [{ type: 'text', text: REPORT }] }, FOR_THE_MODEL);

    expect(answer).toBe(REPORT);
    expect(answer).not.toContain('SendMessage');
    expect(answer).not.toContain('agentId');
  });

  it('keeps every word of a report told in several parts, and skips what is not words', () => {
    const answer = answerOf(
      { content: [{ type: 'text', text: 'first' }, { type: 'image' }, { type: 'text', text: 'second' }] },
      FOR_THE_MODEL,
    );

    expect(answer).toBe('first\nsecond');
  });

  it('falls back to what the model was told when there is no report beside it', () => {
    // A kit that sends no structured output, an output that is not a list, and
    // one whose report is empty: a row with a blank answer is worse than a row
    // with a clumsy one.
    expect(answerOf(null, FOR_THE_MODEL)).toBe(FOR_THE_MODEL);
    expect(answerOf(undefined, FOR_THE_MODEL)).toBe(FOR_THE_MODEL);
    expect(answerOf({ status: 'completed' }, FOR_THE_MODEL)).toBe(FOR_THE_MODEL);
    expect(answerOf({ content: 'not a list' }, FOR_THE_MODEL)).toBe(FOR_THE_MODEL);
    expect(answerOf({ content: [{ type: 'text', text: '   ' }] }, FOR_THE_MODEL)).toBe(FOR_THE_MODEL);
  });
});
