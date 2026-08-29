import { describe, expect, it } from 'vitest';

import type { WbpEvent } from '../../../src/workbench/protocol.ts';
import { codexTokenPictureStats } from '../codex-token-picture-stats.ts';

describe('Codex token-picture statistics', () => {
  it('counts assistant turns and the other history counters together', () => {
    const events = [
      { type: 'message.started', messageId: 'assistant-1', role: 'assistant' },
      { type: 'tool.started' },
      { type: 'agent.started' },
      { type: 'note', kind: 'compact' },
      { type: 'message.completed', messageId: 'assistant-1' },
      { type: 'message.started', messageId: 'user-1', role: 'user' },
      { type: 'note', kind: 'thread/compacted' },
      { type: 'message.completed', messageId: 'user-1' },
      { type: 'note', kind: 'ordinary' },
      { type: 'cost', cost: { kind: 'tokens', input: 5, output: 3, total: 8 } },
      { type: 'cost', cost: { kind: 'usd', usd: 0.01 } },
      { type: 'cost', cost: { kind: 'tokens', input: 8, output: 5, total: 13 } },
    ] as WbpEvent[];

    expect(codexTokenPictureStats(events)).toEqual({
      turns: 1,
      toolCalls: 1,
      forgettings: 2,
      helperCount: 1,
      latestTokenCost: { kind: 'tokens', input: 8, output: 5, total: 13 },
    });
  });
});
