/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({}));

import { boundedEvent } from '../sessions';

describe('the shared provider wire boundary', () => {
  it('bounds and human-labels tool payloads from every driver', () => {
    const started = boundedEvent({
      type: 'tool.started', toolCallId: '1', name: 'Bash',
      input: { command: 'npm test', body: 'x'.repeat(100_000) },
      title: 'Bash raw provider title', parentToolCallId: null,
    });
    expect(started.title).toBe('Ran the tests');
    expect(String(started.input.body).length).toBeLessThan(5_000);

    const completed = boundedEvent({
      type: 'tool.completed', toolCallId: '1', ok: true, output: 'y'.repeat(1_000_000),
    });
    expect(completed.output.length).toBeLessThan(5_000);
  });

  it('also bounds old persisted events when they are replayed', () => {
    const old = boundedEvent({
      seq: 4, sessionId: 'old', at: '2026-08-26T00:00:00.000Z',
      type: 'diff', toolCallId: 'edit', path: 'src/a.ts',
      before: 'a'.repeat(20_000), after: 'b'.repeat(20_000),
    });
    expect(old.before.length).toBeLessThan(5_000);
    expect(old.after.length).toBeLessThan(5_000);
  });
});
