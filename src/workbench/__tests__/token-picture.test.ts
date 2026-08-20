/**
 * What a whole task has spent, read off its own record.
 *
 * The trap here is not the cache — that one the gauge already knows about
 * (context-window.test.ts). It is that ONE answer from the model is written
 * into the record as SEVERAL lines, each carrying a copy of that answer's
 * usage under the same message id, so the obvious arithmetic bills a turn once
 * per block it was made of (bw-3ug7).
 */
import { describe, expect, it } from 'vitest';

import { fullness } from '@/workbench/context-window';
import { NOTHING, spendIn, splitOf, taskSpend, turnsIn } from '@/workbench/token-picture';

/** One recorded line, as the kit writes one. */
const line = (
  id: string,
  usage: Record<string, unknown> | null,
  extra: { model?: string; content?: unknown[] } = {},
) => ({
  type: 'assistant',
  message: { id, role: 'assistant', model: extra.model ?? 'claude-opus-5', content: extra.content ?? [], usage },
});

const spent = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1_000, output_tokens: 20 };

describe('counting a turn once', () => {
  it('bills one answer once, however many lines the kit wrote it as', () => {
    // Thinking, then a call, then another: three lines, one answer, its usage
    // repeated on each of them. This is the ordinary shape of a working turn,
    // not an edge case — which is why the old arithmetic read 36 percent high.
    const record = [
      line('msg_1', spent, { content: [{ type: 'thinking' }] }),
      line('msg_1', spent, { content: [{ type: 'tool_use', name: 'Bash' }] }),
      line('msg_1', spent, { content: [{ type: 'tool_use', name: 'Read' }] }),
    ];
    expect(turnsIn(record)).toHaveLength(1);
    expect(spendIn(record).total).toBe(1_130);
    // The blocks, unlike the usage, are DIVIDED between those lines rather than
    // repeated on each — so the calls are counted on all of them.
    expect(taskSpend(record).toolCalls).toBe(2);
  });

  it('still adds up turns that are genuinely different', () => {
    expect(spendIn([line('msg_1', spent), line('msg_2', spent)]).total).toBe(2_260);
  });

  it('counts a line carrying no id, because two turns are never known to be one', () => {
    const nameless = { type: 'assistant', message: { role: 'assistant', usage: spent } };
    expect(spendIn([nameless, nameless]).total).toBe(2_260);
  });

  it('passes over lines that state no cost at all', () => {
    expect(spendIn([{ message: { role: 'user', content: 'hello' } }, line('msg_1', null)])).toEqual(NOTHING);
    expect(spendIn([])).toEqual(NOTHING);
  });
});

describe('the four ways a turn spends', () => {
  it('splits one call the way the kit reports it, thinking inside the writing', () => {
    expect(
      splitOf({ ...spent, output_tokens_details: { thinking_tokens: 12 } } as Record<string, number | object>),
    ).toEqual({ input: 10, cacheWrite: 100, cacheRead: 1_000, output: 20, thinking: 12, total: 1_130 });
  });

  it('reads a turn exactly as the gauge on the line reads it', () => {
    // One arithmetic, so the window figure and the task figure are comparable
    // and a reader can subtract one from the other (bw-7ks.22.8).
    const one = { input_tokens: 4, cache_read_input_tokens: 150_000, output_tokens: 900 };
    expect(splitOf(one).total).toBe(fullness(one));
  });
});

describe('the whole task', () => {
  const call = (name: string) => ({ type: 'tool_use', id: `t_${name}`, name, input: {} });
  const record = [
    line('msg_1', spent, { content: [{ type: 'thinking' }] }),
    line('msg_1', spent, { content: [call('Bash')] }), // the same answer, its next block
    { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'what happened so far' } },
    line('msg_2', spent, { model: 'claude-sonnet-5', content: [call('Read'), call('Grep')] }),
    { type: 'user', isCompactSummary: true, message: { role: 'user', content: 'what happened so far' } },
    line('msg_3', spent, { content: [] }),
  ];

  it('counts turns, calls and the times the chat forgot itself', () => {
    const picture = taskSpend(record);
    expect(picture.turns).toBe(3);
    expect(picture.toolCalls).toBe(3);
    expect(picture.forgettings).toBe(2);
    expect(picture.total.total).toBe(3_390);
  });

  it('spans every forgetting: the summaries are inside the record, not a new one', () => {
    // The gauge would read one turn here; the task read reads all three.
    expect(taskSpend(record).total.total).toBeGreaterThan(splitOf(spent).total);
  });

  it('names what the work it sent away cost, apart and folded in', () => {
    const picture = taskSpend(record, [
      { model: 'claude-opus-5', spend: splitOf({ input_tokens: 1, output_tokens: 9 }) },
      { model: 'claude-haiku-4-5', spend: splitOf({ cache_read_input_tokens: 500 }) },
    ]);
    expect(picture.helperCount).toBe(2);
    expect(picture.helpers.total).toBe(510);
    expect(picture.own.total).toBe(3_390);
    expect(picture.total.total).toBe(3_900);
  });

  it('gives one row per model, the biggest spender first', () => {
    const picture = taskSpend(record, [{ model: 'claude-haiku-4-5', spend: splitOf({ cache_read_input_tokens: 5 }) }]);
    expect(picture.models.map((m) => [m.model, m.spend.total, m.turns])).toEqual([
      ['claude-opus-5', 2_260, 2],
      ['claude-sonnet-5', 1_130, 1],
      ['claude-haiku-4-5', 5, 0],
    ]);
  });

  it('has nothing to say about a record whose turns state no cost', () => {
    expect(taskSpend([{ message: { role: 'user', content: 'hello' } }]).total).toEqual(NOTHING);
  });
});
