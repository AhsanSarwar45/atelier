/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ listSessions: vi.fn() }));

import { codexDoingFromLines, latestCodexThreadsByPid, restoreRunningElsewhere } from '../registry.ts';

const row = (type: string, item?: string) => JSON.stringify({
  type: 'event_msg',
  payload: { type, ...(item ? { item: { type: item } } : {}) },
});

describe('external Codex activity', () => {
  it('finds one current conversation for every live Codex process from newest-first logs', () => {
    expect([...latestCodexThreadsByPid([
      { process_uuid: 'pid:101:one', thread_id: 'CURRENT-A' },
      { process_uuid: 'pid:101:one', thread_id: 'old-helper-a' },
      { process_uuid: 'pid:202:two', thread_id: 'CURRENT-B' },
      { process_uuid: 'not-a-process', thread_id: 'ignored' },
    ])]).toEqual([
      [101, 'current-a'],
      [202, 'current-b'],
    ]);
  });

  it('keeps an externally held Codex row external after imported activity changes its stored state', () => {
    const codex = new Set(['outside-codex']);
    expect(restoreRunningElsewhere('codex', 'running_tool', 'outside-codex', new Map(), codex)).toBe(true);
    expect(restoreRunningElsewhere('codex', 'starting', 'OUTSIDE-CODEX', new Map(), codex)).toBe(true);
    expect(restoreRunningElsewhere('codex', 'dormant', 'not-running', new Map(), codex)).toBe(false);
  });

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
