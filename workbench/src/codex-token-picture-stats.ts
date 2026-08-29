import type { Cost, WbpEvent } from '../../src/workbench/protocol.ts';

export interface CodexTokenPictureStats {
  turns: number;
  toolCalls: number;
  forgettings: number;
  helperCount: number;
  latestTokenCost: Extract<Cost, { kind: 'tokens' }> | null;
}

/** Aggregate the counters beside a Codex token report without copying history. */
export function codexTokenPictureStats(events: readonly WbpEvent[]): CodexTokenPictureStats {
  const assistantMessages = new Set<string>();
  let turns = 0;
  let toolCalls = 0;
  let forgettings = 0;
  let helperCount = 0;
  let latestTokenCost: Extract<Cost, { kind: 'tokens' }> | null = null;

  for (const event of events) {
    if (event.type === 'message.started') {
      if (event.role === 'assistant') assistantMessages.add(event.messageId);
    } else if (event.type === 'message.completed') {
      if (assistantMessages.has(event.messageId)) turns += 1;
    } else if (event.type === 'tool.started') {
      toolCalls += 1;
    } else if (event.type === 'agent.started') {
      helperCount += 1;
    } else if (event.type === 'note' && (event.kind === 'thread/compacted' || event.kind === 'compact')) {
      forgettings += 1;
    } else if (event.type === 'cost' && event.cost.kind === 'tokens') {
      latestTokenCost = event.cost;
    }
  }

  return { turns, toolCalls, forgettings, helperCount, latestTokenCost };
}
