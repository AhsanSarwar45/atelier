/**
 * @vitest-environment node
 *
 * Whose work a row on the panel is (bw-7ks.22.18).
 *
 * The panel is everything THIS CHAT handed to something else. The kit reports
 * work a helper handed off on the same channel and in the same shape, so a
 * command a helper ran drew a row of its own beside the helper that ran it —
 * owned by nobody, counting zero seconds for a command that took forty-five,
 * and repeating its description where its answer goes.
 *
 * The two messages below are the kit's own, captured verbatim from a real run
 * on 2026-08-20: a chat sending one helper away, and that helper running a
 * shell command in the foreground.
 */
import { describe, expect, it } from 'vitest';

import { sentAwayByAHelper } from '../drivers/claude.ts';

/** The chat's own: it called the Agent tool, and the kit opened a task for it. */
const OURS = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'afa98b872c4df37bc',
  tool_use_id: 'toolu_01GDoyt2caPUwy8LmHwbcma1',
  description: 'Sleep 45 seconds then report',
  subagent_type: 'general-purpose',
  task_type: 'local_agent',
};

/** The helper's own: the same shape, one flag apart. */
const THE_HELPER_S = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'br1aixx0b',
  owned_by_subagent: true,
  tool_use_id: 'toolu_01JHPyJ8qeiC7mtF6QMDRAe2',
  description: 'Sleep for 45 seconds in foreground',
  task_type: 'local_bash',
};

describe('whose work a task is', () => {
  it('leaves the chat’s own helper to the chat', () => {
    // The call that SENT this helper was made by the chat, so it is not among
    // the calls helpers made and the task is the chat's own.
    expect(sentAwayByAHelper(OURS, new Set())).toBe(false);
  });

  it('reads the kit’s own word for it', () => {
    expect(sentAwayByAHelper(THE_HELPER_S, new Set())).toBe(true);
  });

  it('and knows it anyway from the call that started it', () => {
    // The flag is on the wire and not in the kit's published types, so it can
    // go away without anything failing to compile. The call is the second
    // signal: this driver watched the helper make it.
    const { owned_by_subagent, ...unflagged } = THE_HELPER_S;
    expect(sentAwayByAHelper(unflagged, new Set())).toBe(false);
    expect(sentAwayByAHelper(unflagged, new Set(['toolu_01JHPyJ8qeiC7mtF6QMDRAe2']))).toBe(true);
  });

  it('leaves a command left running by the chat itself to the chat', () => {
    // The background list carries no call at all, and nothing there is a
    // helper's unless the kit says so.
    expect(sentAwayByAHelper({ task_id: 'x', task_type: 'local_bash', description: 'npm run dev' }, new Set())).toBe(
      false,
    );
  });
});
