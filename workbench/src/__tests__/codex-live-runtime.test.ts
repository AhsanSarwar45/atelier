/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WbpEvent } from '../../../src/workbench/protocol';
import { CodexDriver, codexRolloutLine, codexThreadSettings, codexThreadUsageFromRollout, replayCodexThread } from '../drivers/codex';

type BareEvent = Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>;

describe('Codex live-runtime regressions', () => {
  it('reads the model and approval badge from the latest persisted turn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-runtime-'));
    const path = join(dir, 'rollout.jsonl');
    try {
      writeFileSync(path, [
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.4', approval_policy: 'never' } }),
        JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-codex', approval_policy: 'on-request' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
          total_token_usage: { input_tokens: 800, output_tokens: 200, total_tokens: 1000 },
          last_token_usage: { total_tokens: 100 }, model_context_window: 200_000,
        } } }),
      ].join('\n'));
      expect(codexThreadSettings({ path })).toEqual({ model: 'gpt-5.6-codex', permissionMode: 'on-request' });
      expect(codexThreadUsageFromRollout({ path })).toEqual({ input: 800, output: 200, total: 1000, contextUsed: 100, contextWindow: 200_000 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('uses native command actions and the house command categorizer', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);
    driver.itemStarted({ id: 'read', type: 'commandExecution', command: "sed -n '1,20p' src/app.ts", commandActions: [{ type: 'read', path: '/repo/src/app.ts' }] });
    driver.itemStarted({ id: 'test', type: 'commandExecution', command: 'npm test', commandActions: [{ type: 'unknown' }] });
    expect(events.find((event: any) => event.toolCallId === 'read')).toMatchObject({ name: 'Read', title: 'Read src/app.ts' });
    expect(events.find((event: any) => event.toolCallId === 'test')).toMatchObject({ name: 'Bash', title: 'Ran the tests' });
  });

  it('does not restore empty assistant rows', () => {
    const events: BareEvent[] = [];
    replayCodexThread({ turns: [{ items: [
      { id: 'empty', type: 'agentMessage', text: '' },
      { id: 'answer', type: 'agentMessage', text: 'Visible' },
    ] }] }, (event) => events.push(event));
    expect(events).not.toContainEqual(expect.objectContaining({ messageId: 'empty' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'text.delta', messageId: 'answer', text: 'Visible' }));
  });

  it('translates only newly appended rollout lines', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver();
    codexRolloutLine(JSON.stringify({ type: 'response_item', payload: {
      type: 'custom_tool_call', id: 'item', call_id: 'new', name: 'exec', input: 'const r = await tools.exec_command({cmd:"npm test"})',
    } }), driver, (event) => events.push(event));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'transcript.reset' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.started', toolCallId: 'new', title: 'Ran the tests' }));
    codexRolloutLine(JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'new', output: 'passed' } }), driver, (event) => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: 'tool.completed', toolCallId: 'new', output: 'passed' });
  });
});
