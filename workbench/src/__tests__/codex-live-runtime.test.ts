/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WbpEvent } from '../../../src/workbench/protocol';
import { foldAll } from '../../../src/workbench/fold';
import { CodexDriver, codexRolloutLine, codexThreadSettings, codexThreadUsageFromRollout, replayCodexThread, seedCodexSnapshot } from '../drivers/codex';

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

  it('shows assistant messages recorded as response items', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver();
    const emit = (event: BareEvent) => events.push(event);
    codexRolloutLine(JSON.stringify({ type: 'response_item', payload: {
      type: 'message', id: 'reply', role: 'assistant',
      content: [{ type: 'output_text', text: 'All tests pass.' }], phase: 'final_answer',
    } }), driver, emit);

    expect(events).toContainEqual({ type: 'message.started', messageId: 'reply', role: 'assistant' });
    expect(events).toContainEqual({ type: 'text.delta', messageId: 'reply', text: 'All tests pass.' });
    expect(events).toContainEqual({ type: 'message.completed', messageId: 'reply' });
  });

  it('does not repeat a reply recorded in both rollout shapes', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver();
    const emit = (event: BareEvent) => events.push(event);
    const content = [{ type: 'output_text', text: 'Shown once.' }];
    codexRolloutLine(JSON.stringify({ type: 'response_item', payload: {
      type: 'message', id: 'reply', role: 'assistant', content,
    } }), driver, emit);
    codexRolloutLine(JSON.stringify({ type: 'event_msg', payload: {
      type: 'item_completed', item: { type: 'AgentMessage', id: 'reply', content },
    } }), driver, emit);

    expect(events.filter((event) => event.type === 'text.delta')).toEqual([
      { type: 'text.delta', messageId: 'reply', text: 'Shown once.' },
    ]);
    expect(events.filter((event) => event.type === 'message.completed')).toEqual([
      { type: 'message.completed', messageId: 'reply' },
    ]);
  });

  it('does not append a complete Codex snapshot below an existing command timeline', () => {
    const existing = [
      { type: 'message.started', messageId: 'live-commentary', role: 'assistant' },
      { type: 'text.delta', messageId: 'live-commentary', text: 'I will inspect it.' },
      { type: 'message.completed', messageId: 'live-commentary' },
      { type: 'tool.started', toolCallId: 'live-command', name: 'Bash', input: {}, title: 'Inspected it', parentToolCallId: null },
      { type: 'tool.completed', toolCallId: 'live-command', ok: true, output: 'done' },
    ] as unknown as BareEvent[];
    const snapshot = { turns: [{ items: [
      { id: 'item-1', type: 'agentMessage', text: 'I will inspect it.' },
      { id: 'item-2', type: 'commandExecution', command: 'rg thing', status: 'completed', exitCode: 0 },
      { id: 'item-3', type: 'agentMessage', text: 'It is fixed.' },
    ] }] };

    const replayed = [...existing];
    expect(seedCodexSnapshot(snapshot, { importedBy: 9, drawn: 1, drivenHere: true }, (event) => replayed.push(event))).toBe(false);
    const rows = foldAll(replayed.map((event, index) => ({
      ...event, seq: index + 1, sessionId: 'external', at: new Date(0).toISOString(),
    })) as WbpEvent[]).items;

    expect(rows.map((row) => row.id)).toEqual(['live-commentary', 'live-command']);
    expect(rows.filter((row) => row.kind === 'message')).toHaveLength(1);
    const commandsOnly = [...existing.slice(3)];
    expect(seedCodexSnapshot(snapshot, { importedBy: null, drawn: 0, drivenHere: true }, (event) => commandsOnly.push(event))).toBe(false);
    expect(commandsOnly.map((event) => 'toolCallId' in event ? event.toolCallId : null)).toEqual(['live-command', 'live-command']);

    const empty: BareEvent[] = [];
    expect(seedCodexSnapshot(snapshot, { importedBy: null, drawn: 0, drivenHere: false }, (event) => empty.push(event))).toBe(true);
    expect(empty.some((event) => event.type === 'text.delta')).toBe(true);
  });

  it('settles an external turn and unwraps orchestration patches as edits', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver();
    const emit = (event: BareEvent) => events.push(event);
    codexRolloutLine(JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }), driver, emit);
    codexRolloutLine(JSON.stringify({ type: 'response_item', payload: {
      type: 'custom_tool_call', call_id: 'patch', name: 'exec',
      input: 'const patch = "*** Begin Patch\\n*** Update File: /repo/src/a.ts\\n*** End Patch"; await tools.apply_patch(patch)',
    } }), driver, emit);
    codexRolloutLine(JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }), driver, emit);

    expect(events).toContainEqual(expect.objectContaining({ type: 'session.state', state: 'thinking' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool.started', name: 'Edit' }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'tool.started', name: 'Bash' }));
    expect(events.at(-1)).toMatchObject({ type: 'session.state', state: 'dormant' });
  });

  it('translates every orchestration call observed in Codex rollouts', () => {
    const calls = [
      ['shell', 'const r = await tools.exec_command({cmd:"npm test"})', 'Bash', 'Ran the tests'],
      ['patch', 'const p = "*** Begin Patch\\n*** Update File: /repo/a.ts\\n*** End Patch"; await tools.apply_patch(p)', 'Edit', 'Changed repo/a.ts'],
      ['poll', 'await tools.write_stdin({session_id:12,chars:""})', 'Wait', 'Waited for a running command'],
      ['search', 'await tools.web__run({search_query:[{q:"Codex docs"}]})', 'WebSearch', 'Searched the web for Codex docs'],
      ['open', 'await tools.web__run({open:[{ref_id:"page"}]})', 'WebFetch', 'Fetched a page'],
      ['image', 'await tools.view_image({path:"/tmp/screen.png"})', 'Read', 'Read tmp/screen.png'],
    ] as const;
    for (const [id, input, name, title] of calls) {
      const events: BareEvent[] = [];
      codexRolloutLine(JSON.stringify({ type: 'response_item', payload: {
        type: 'custom_tool_call', call_id: id, name: 'exec', input,
      } }), new CodexDriver(), (event) => events.push(event));
      expect(events[0], id).toMatchObject({ type: 'tool.started', name, title });
    }
  });

  it('gives wrapped common commands the same human labels as every provider', () => {
    const calls = [
      ['git', 'const r = await tools.exec_command({"cmd":"git -C /repo status --short"}); text(r.output)', 'Checked the working tree'],
      ['rg', 'const r = await tools.exec_command({"cmd":"rg --files -g \\\"*.ts\\\""}); text(r.output)', 'Listed the files matching *.ts'],
      ['sed', 'const r = await tools.exec_command({"cmd":"sed -n \\\"1,80p\\\" src/app.ts"}); text(r.output)', 'Read part of src/app.ts'],
    ] as const;
    for (const [id, input, title] of calls) {
      const events: BareEvent[] = [];
      codexRolloutLine(JSON.stringify({ type: 'response_item', payload: {
        type: 'custom_tool_call', call_id: id, name: 'exec', input,
      } }), new CodexDriver(), (event) => events.push(event));
      expect(events[0], id).toMatchObject({ type: 'tool.started', name: 'Bash', title });
    }
  });

  it('unwraps the login shell used by native Codex command executions', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver();
    driver.emit = (event) => events.push(event);
    driver.itemStarted({
      id: 'native-shell',
      type: 'commandExecution',
      command: "/bin/bash -lc 'sed -n \"1,240p\" .agents/skills/beads/SKILL.md && bd prime'",
      commandActions: [{ type: 'unknown' }],
    });
    expect(events[0]).toMatchObject({
      type: 'tool.started',
      name: 'Bash',
      title: 'Read part of beads/SKILL.md, then read the board rules',
    });
  });
});
