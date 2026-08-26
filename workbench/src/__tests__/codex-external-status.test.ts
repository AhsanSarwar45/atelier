import { describe, expect, it } from 'vitest';

import { codexDoingFromLines } from '../registry.ts';

const row = (type: string, item?: string) => JSON.stringify({
  type: 'event_msg',
  payload: { type, ...(item ? { item: { type: item } } : {}) },
});

describe('external Codex activity', () => {
  it('is idle after a completed or aborted turn', () => {
    expect(codexDoingFromLines([row('task_started'), row('task_complete')])).toBe('idle');
    expect(codexDoingFromLines([row('task_started'), row('turn_aborted')])).toBe('idle');
  });

  it('names the latest work in an active turn', () => {
    expect(codexDoingFromLines([row('task_started'), row('item_completed', 'Reasoning')])).toBe('thinking');
    expect(codexDoingFromLines([row('task_started'), row('custom_tool_call')])).toBe('running');
    expect(codexDoingFromLines([row('task_started'), row('item_completed', 'AgentMessage')])).toBe('answering');
    expect(codexDoingFromLines([row('task_started'), row('request_user_input')])).toBe('waiting');
    expect(codexDoingFromLines([row('task_started'), JSON.stringify({ type: 'compaction' })])).toBe('summarising');
  });
});
