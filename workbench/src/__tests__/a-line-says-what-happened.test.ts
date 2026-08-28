/**
 * @vitest-environment node
 *
 * Whether a line in the conversation says what happened, or says the name of
 * the wire message it came from (bw-6jq5.3, bw-wasy).
 *
 * Agent lifecycle signals are not prose. They feed the categorized helper row
 * and its command icon; drawing another ordinary note beside that row gives the
 * parent agent words it never said and duplicates the same transition.
 *
 * Two things are held here, and the second is the one that lasts: the three
 * kinds we now know say what they mean, AND a kind nobody has ever seen says
 * whatever words it carries, wherever in the message it kept them. The kit
 * invents kinds; the first half of this file goes stale and the second does not.
 */
import { describe, expect, it } from 'vitest';

import { ClaudeDriver } from '../drivers/claude.ts';

type Said = { type: string; kind?: string; text?: string };

/** Every sentence one driver says while it is fed these messages. */
function linesFrom(messages: Record<string, unknown>[]): string[] {
  const said: string[] = [];
  const driver = new ClaudeDriver();
  (driver as unknown as { emit: (e: Said) => void }).emit = (e) => {
    if (e.type === 'note') said.push(String(e.text));
  };
  for (const m of messages) driver.draw(m);
  return said;
}

/** The agent whose whole life the messages below describe. Captured 2026-08-20. */
const SENT_OFF = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'a93460d15c610bb9e',
  tool_use_id: 'toolu_01GDoyt2caPUwy8LmHwbcma1',
  description: 'Idle dummy agent',
  subagent_type: 'general-purpose',
  task_type: 'local_agent',
};

describe('a line about sent-off work', () => {
  it('does not turn an agent stopping into an ordinary transcript line', () => {
    const said = linesFrom([
      SENT_OFF,
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'a93460d15c610bb9e',
        patch: { status: 'killed', end_time: 1787227672410 },
      },
    ]);

    expect(said).toEqual([]);
  });

  it('does not invent parent prose for an agent it never heard start', () => {
    const said = linesFrom([
      { type: 'system', subtype: 'task_updated', task_id: 'unheard-of', patch: { status: 'failed' } },
    ]);

    expect(said).toEqual([]);
  });

  it('keeps background-list bookkeeping out of ordinary transcript lines', () => {
    const said = linesFrom([
      {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'b1', task_type: 'local_agent', description: 'Idle dummy agent' }],
      },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
    ]);

    expect(said).toEqual([]);
  });
});

describe('a line about a kind this build has never seen', () => {
  it('says the words the message carried at the top of it', () => {
    const said = linesFrom([{ type: 'brand_new_thing', summary: 'The kit did something new' }]);

    expect(said).toEqual(['The kit did something new']);
  });

  it('says the words the message kept a level down', () => {
    const said = linesFrom([{ type: 'brand_new_thing', patch: { reason: 'It ran out of room' } }]);

    expect(said).toEqual(['It ran out of room']);
  });

  it('reads the first of a list, because a line is a line and not a paragraph', () => {
    const said = linesFrom([
      { type: 'brand_new_thing', items: [{ description: 'The first of them' }, { description: 'The second' }] },
    ]);

    expect(said).toEqual(['The first of them']);
  });

  // The last resort, and still not the wire name on its own: a reader is told
  // there was something and that this build has no words for it, which is true
  // and is more than the kind alone ever told him.
  it('says in words that it has no words, when the message carries none', () => {
    const said = linesFrom([{ type: 'brand_new_thing', count: 4 }]);

    expect(said).toEqual(['The machine said something this build has no words for.']);
    // Not merely "is not the name": the name is not IN it. It used to ride in
    // brackets at the end, which is the same wire word one punctuation mark
    // further from the reader (bw-cx70.3).
    expect(said[0]).not.toContain('brand_new_thing');
  });
});
