/**
 * Reading a chat is not the chat doing something.
 *
 * Opening a conversation replays the whole of it onto the app's one live
 * stream, every message stamped with the moment it was read. The list took each
 * of those for activity, so reading a chat from March carried it to the top
 * under today's time — and the manager lost his place in the list every time he
 * looked at anything (bw-4wcd.9).
 */
import { describe, expect, it } from 'vitest';

import { movesTheClock } from '@/workbench/live';
import type { SessionState } from '@/workbench/protocol';

describe('a chat’s own clock', () => {
  it('does not move for a chat that is asleep', () => {
    expect(movesTheClock('dormant')).toBe(false);
    expect(movesTheClock('ended')).toBe(false);
  });

  it('moves for every state that means the agent is at work', () => {
    const working: SessionState[] = ['starting', 'thinking', 'streaming', 'running_tool', 'idle'];
    for (const state of working) expect(movesTheClock(state)).toBe(true);
  });

  it('does not move for a chat nothing is known about', () => {
    expect(movesTheClock(undefined)).toBe(false);
  });
});
