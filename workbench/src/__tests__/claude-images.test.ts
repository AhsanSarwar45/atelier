/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({}));

import type { WbpEvent } from '../../../src/workbench/protocol';
import { ClaudeDriver } from '../drivers/claude';

type BareEvent = Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>;

describe('Claude agent-produced images', () => {
  it('turns image blocks in a live tool result into a transcript image message', () => {
    const events: BareEvent[] = [];
    const driver = new ClaudeDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);
    driver.liveTools.set('picture', 'Read');

    driver.draw({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 'picture', is_error: false,
          content: [
            { type: 'text', text: 'Selected image' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
          ],
        }],
      },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'message.started', messageId: 'picture:images', role: 'assistant',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'image', messageId: 'picture:images',
      image: { mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', alt: 'Agent-produced image' },
    }));
  });
});
