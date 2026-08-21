/**
 * @vitest-environment node
 *
 * Four kinds of message the kit really sends and its SDKMessage union leaves out.
 *
 * The manager asked whether this app was reading the toolkit's own sources or
 * only what we happened to know: "maybe other messages that you missed. are
 * you checking their sdk and dcos?" It was reading half of them. The kit's
 * types name a union its own iterator is declared with; its shipped program
 * hands four kinds to whoever is reading a run that appear in that union
 * nowhere — `active_goal`, `autocompact_state`, and two system subtypes. Two
 * of them drew the wire's own word into the middle of a conversation, and two
 * drew whatever text they carried with nobody having ruled who it was for
 * (bw-cx70).
 *
 * Outside that union is not the same as written down nowhere (bw-cx70.7).
 * `active_goal` is declared in full, with its own doc comment, as
 * SDKActiveGoalMessage — reachable only through the transport's union. The
 * other three are named in the type file nowhere at all.
 *
 * Every field the fixtures below carry comes from the program that writes
 * these messages, Claude Code itself, which ships its own schema for each one.
 * These cases cannot prove that on their own — a fixture and the code it
 * exercises agreeing on an invented name proves nothing — so the field names
 * are checked against those schemas by `scripts/chat-shows-what-is-yours.mjs`,
 * which reads them out of the very program the app drives (bw-cx70.8).
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

/** Nothing a line says may be shaped like a name off the wire (§8.2.4). */
const OFF_THE_WIRE = /\b[a-z]+(?:_[a-z]+)+\b|\b[a-z]+[A-Z]\w*\b/;

describe('a standing goal of his', () => {
  it('is the machine getting on with it while the goal is still being chased', () => {
    const [said] = notesFrom([
      {
        type: 'active_goal',
        value: { condition: 'the tests pass', iterations: 2, set_at: 0, tokens_at_start: 0 },
        uuid: 'u',
        session_id: 's',
      },
    ]);

    expect(said.text).toBe('Still working towards the goal you set: the tests pass.');
    expect(said.audience).toBe('machine');
  });

  it('is his the moment the goal is gone, because only he started it', () => {
    const [said] = notesFrom([{ type: 'active_goal', value: null, uuid: 'u', session_id: 's' }]);

    expect(said.text).toBe('The goal you set is no longer running.');
    expect(said.audience).toBe('you');
  });
});

describe('whether the chat folds its own history up', () => {
  it('says so in words, and reads none of the four fields nobody has declared', () => {
    const [said] = notesFrom([
      {
        type: 'autocompact_state',
        value: { enabled: true, effective_window: 200000, threshold: 160000, enforced: false, source: 'local' },
        uuid: 'u',
        session_id: 's',
      },
    ]);

    expect(said.text).toBe('This chat folds its own history up as the window fills.');
    expect(said.audience).toBe('machine');
    expect(said.text).not.toMatch(OFF_THE_WIRE);
  });

  it('is the setting and not the fold, so it stays off his side either way', () => {
    const [said] = notesFrom([
      { type: 'autocompact_state', value: { enabled: false }, uuid: 'u', session_id: 's' },
    ]);

    expect(said.text).toBe('This chat does not fold its own history up.');
    expect(said.audience).toBe('machine');
  });
});

describe("the kit's own reading of where the turn ended", () => {
  it('is his when the turn is stopped on him, and carries what it is stopped on', () => {
    const [said] = notesFrom([
      {
        type: 'system',
        subtype: 'post_turn_summary',
        summarizes_uuid: 'u',
        status_category: 'blocked',
        status_detail: 'waiting on your answer',
        needs_action: 'answer the question',
      },
    ]);

    expect(said.text).toBe('This turn is stopped, waiting on you — waiting on your answer.');
    expect(said.audience).toBe('you');
    expect(said.text).not.toMatch(OFF_THE_WIRE);
  });

  it('is the same answer under the name the kit rewords it to on the way out', () => {
    const [said] = notesFrom([
      {
        type: 'system',
        subtype: 'post_turn_summary',
        status_category: 'need_input',
        status_detail: 'waiting on your answer',
      },
    ]);

    expect(said.audience).toBe('you');
    expect(said.text).not.toContain('need_input');
  });

  it('is not his when the turn merely ended with something to look at', () => {
    const [said] = notesFrom([
      {
        type: 'system',
        subtype: 'post_turn_summary',
        status_category: 'review_ready',
        status_detail: 'the change is written',
      },
    ]);

    expect(said.audience).toBe('machine');
    expect(said.text).not.toMatch(OFF_THE_WIRE);
  });

  it('says in English that it has no words, rather than the code word, for a state it has never met', () => {
    const [said] = notesFrom([
      { type: 'system', subtype: 'post_turn_summary', status_category: 'brand_new_category' },
    ]);

    expect(said.text).toBe('This turn ended in a way this build has no words for.');
    expect(said.text).not.toContain('brand_new_category');
    expect(said.audience).toBe('machine');
  });
});

describe('the running commentary on what this chat is doing', () => {
  it('stays off his side, because the chip and the panel both draw it already', () => {
    const [said] = notesFrom([
      { type: 'system', subtype: 'task_summary', detail: 'reading the settings' },
    ]);

    expect(said.text).toBe('Working on: reading the settings.');
    expect(said.audience).toBe('machine');
  });

  it('says the chat has nothing on the go when the kit clears it', () => {
    const [said] = notesFrom([{ type: 'system', subtype: 'task_summary', detail: null }]);

    expect(said.text).toBe('This chat has nothing on the go.');
    expect(said.audience).toBe('machine');
  });
});
