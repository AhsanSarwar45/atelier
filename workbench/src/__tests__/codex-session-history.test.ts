/** @vitest-environment node */
import { describe, expect, it } from 'vitest';

import type { WbpEvent } from '../../../src/workbench/protocol';
import { foldAll } from '../../../src/workbench/fold';
import { replayCodexRollout } from '../drivers/codex';

type BareEvent = Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>;

describe('opening persisted Codex history', () => {
  it('restores user prompts beside their assistant replies', () => {
    const lines = [
      { timestamp: '2026-08-28T05:00:01.000Z', type: 'event_msg', payload: {
        type: 'user_message', message: 'First prompt', images: [], local_images: [],
      } },
      { type: 'response_item', payload: {
        type: 'message', id: 'answer-1', role: 'assistant',
        content: [{ type: 'output_text', text: 'First answer' }],
      } },
      { timestamp: '2026-08-28T05:01:01.000Z', type: 'event_msg', payload: {
        type: 'user_message', message: 'Second prompt', images: [], local_images: [],
      } },
      { type: 'response_item', payload: {
        type: 'message', id: 'answer-2', role: 'assistant',
        content: [{ type: 'output_text', text: 'Second answer' }],
      } },
    ].map((row) => JSON.stringify(row)).join('\n');
    const events: BareEvent[] = [];
    replayCodexRollout(lines, (event) => events.push(event));
    const transcript = foldAll(events.map((event, index) => ({
      ...event, seq: index + 1, sessionId: 'old-codex-chat', at: new Date(0).toISOString(),
    })) as WbpEvent[]).items;

    expect(transcript.filter((item) => item.kind === 'message').map((item) => ({
      role: item.kind === 'message' ? item.role : null,
      text: item.kind === 'message' ? item.text : null,
    }))).toEqual([
      { role: 'user', text: 'First prompt' },
      { role: 'assistant', text: 'First answer' },
      { role: 'user', text: 'Second prompt' },
      { role: 'assistant', text: 'Second answer' },
    ]);
  });
});
