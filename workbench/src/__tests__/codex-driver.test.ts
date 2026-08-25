/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({}));

import type { WbpEvent } from '../../../src/workbench/protocol';
import { CodexDriver, codexAgentDefinitions, replayCodexThread } from '../drivers/codex';
import { createDriver, defaultPermissionMode } from '../drivers';

type BareEvent = Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>;

describe('the provider boundary', () => {
  it('selects Codex without leaking that choice through the session runtime', () => {
    expect(createDriver('codex')).toBeInstanceOf(CodexDriver);
    expect(defaultPermissionMode('codex')).toBe('on-request');
  });

  it('offers only the subagent control Codex can honestly perform', () => {
    expect(new CodexDriver().agentControls()).toEqual(['stop', 'say']);
  });

  it('surfaces project Codex agent definitions with project overrides', () => {
    const project = mkdtempSync(join(tmpdir(), 'codex-agents-'));
    try {
      mkdirSync(join(project, '.codex', 'agents'), { recursive: true });
      writeFileSync(join(project, '.codex', 'agents', 'reviewer.toml'), 'description = "Reviews risky changes"\n');
      expect(codexAgentDefinitions(project)).toContainEqual({
        name: 'reviewer', description: 'Reviews risky changes', source: 'project',
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('Codex subagents on the common workbench protocol', () => {
  it('draws a native spawned agent and its result as one agent row', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);

    driver.itemStarted({
      id: 'call-1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'inProgress',
      prompt: 'Inspect the session registry', model: 'gpt-5.6-luna',
      receiverThreadIds: ['agent-1'], agentsStates: { 'agent-1': { status: 'running' } },
    });
    driver.itemCompleted({
      id: 'call-1', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed',
      receiverThreadIds: ['agent-1'],
      agentsStates: { 'agent-1': { status: 'completed', message: 'Registry checked.' } },
    });

    expect(events[0]).toMatchObject({
      type: 'agent.started', agentId: 'agent-1', toolCallId: 'call-1',
      what: 'Inspect the session registry', model: 'gpt-5.6-luna',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'agent.finished', agentId: 'agent-1', state: 'done', result: 'Registry checked.',
    });
  });
});

describe('Codex app-server requests', () => {
  it('collects every ordinary user question and returns the protocol answer map', () => {
    const events: BareEvent[] = [];
    const writes: any[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);
    driver.write = (message: any) => writes.push(message);

    driver.ask({ id: 9, method: 'item/tool/requestUserInput', params: {
      isBlocking: true,
      questions: [
        { id: 'shape', header: 'Shape', question: 'Which shape?', options: [{ label: 'Circle' }] },
        { id: 'name', header: 'Name', question: 'What name?', options: null, isOther: true },
      ],
    } });
    const asks = events.filter((event: any) => event.type === 'ask.permission') as any[];
    expect(asks).toHaveLength(2);
    expect(asks[0]).toMatchObject({ question: true, toolName: 'Shape' });
    expect(asks[1]).toMatchObject({ question: true, allowText: true });

    driver.answer('9:shape', 'Circle');
    expect(writes).toHaveLength(0);
    driver.answer('9:name', 'text', 'Ada');
    expect(writes[0]).toEqual({ jsonrpc: '2.0', id: 9, result: {
      answers: { shape: { answers: ['Circle'] }, name: { answers: ['Ada'] } },
    } });
  });

  it('answers expanded permission requests with granted permissions and scope', () => {
    const writes: any[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = () => {};
    driver.write = (message: any) => writes.push(message);
    const permissions = { network: { enabled: true } };
    driver.ask({ id: 4, method: 'item/permissions/requestApproval', params: { itemId: 'p', permissions } });
    driver.answer('p', 'allow_always');
    expect(writes[0]).toEqual({ jsonrpc: '2.0', id: 4, result: { permissions, scope: 'session' } });
  });

  it('answers Codex clock requests without interrupting the turn', () => {
    const writes: any[] = [];
    const driver = new CodexDriver() as any;
    driver.write = (message: any) => writes.push(message);
    driver.ask({ id: 8, method: 'currentTime/read', params: {} });
    expect(writes[0]).toMatchObject({ jsonrpc: '2.0', id: 8, result: { currentTimeAt: expect.any(Number) } });
  });
});

describe('Codex persisted history', () => {
  it('restores reasoning, tools, images, and subagents as WBP events', () => {
    const events: BareEvent[] = [];
    replayCodexThread({ turns: [{ items: [
      { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Check it' }, { type: 'image', url: 'data:image/png;base64,AA==' }] },
      { id: 'r', type: 'reasoning', summary: ['Looking'] },
      { id: 'sh', type: 'commandExecution', command: 'pwd', status: 'completed', exitCode: 0, aggregatedOutput: '/tmp' },
      { id: 'a', type: 'agentMessage', text: 'Done' },
      { id: 'c', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', prompt: 'Inspect', receiverThreadIds: ['helper'], agentsStates: { helper: { status: 'completed', message: 'OK' } } },
      { id: 'sa', type: 'subAgentActivity', agentThreadId: 'typed-helper', agentPath: '/repo/.codex/agents/reviewer.toml', kind: 'started' },
    ] }] }, (event) => events.push(event));
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'image', 'thinking.delta', 'tool.started', 'tool.completed', 'agent.started', 'agent.finished',
    ]));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'session.state' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'agent.started', agentId: 'typed-helper', agentType: 'reviewer' }));
  });
});

describe('Codex first-class controls and live work', () => {
  it('shows a file edit with its before and after sides', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);
    driver.itemStarted({ id: 'edit', type: 'fileChange', status: 'inProgress', changes: [{
      path: 'src/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;',
    }] });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.started', toolCallId: 'edit', name: 'Edit',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'diff', toolCallId: 'edit', path: 'src/a.ts', before: 'const a = 1;', after: 'const a = 2;',
    }));
  });

  it('shows streaming command output while the command is still running', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);
    driver.itemStarted({ id: 'shell', type: 'commandExecution', status: 'inProgress', command: 'npm test' });
    driver.event('item/commandExecution/outputDelta', { itemId: 'shell', delta: 'first\n' });
    driver.event('item/commandExecution/outputDelta', { itemId: 'shell', delta: 'second\n' });
    expect(events.at(-1)).toMatchObject({ type: 'tool.progress', toolCallId: 'shell', summary: 'first\nsecond\n' });
    driver.itemCompleted({ id: 'shell', type: 'commandExecution', status: 'completed', exitCode: 0 });
    expect(events.at(-1)).toMatchObject({ type: 'tool.completed', output: 'first\nsecond\n' });
  });

  it('uses cumulative spend but the last prompt for context fullness', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);
    driver.event('thread/tokenUsage/updated', { tokenUsage: {
      last: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      total: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 },
      modelContextWindow: 200_000,
    } });
    expect(events).toContainEqual({ type: 'cost', cost: { kind: 'tokens', input: 800, output: 200, total: 1000 } });
    expect(events).toContainEqual({ type: 'context', used: 100, window: 200_000 });
  });

  it('runs compact as a Codex control call rather than prompt text', async () => {
    const calls: any[] = [];
    const driver = new CodexDriver() as any;
    driver.threadId = 'thread';
    driver.emit = () => {};
    driver.call = async (method: string, params: any) => { calls.push([method, params]); return {}; };
    await driver.send({ text: '/compact', images: [] });
    expect(calls).toEqual([['thread/compact/start', { threadId: 'thread' }]]);
  });

  it('reports account limits from model buckets as well as the top-level bucket', async () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.threadId = 'thread';
    driver.emit = (event: BareEvent) => events.push(event);
    driver.call = async () => ({
      rateLimits: { secondary: { windowDurationMins: 10080, usedPercent: 8, resetsAt: 2_000_000_000 } },
      rateLimitsByLimitId: { codex_fast: { primary: { windowDurationMins: 300, usedPercent: 2, resetsAt: 2_000_000_100 } } },
    });
    await driver.send({ text: '/usage', images: [] });
    expect(events.at(-1)).toMatchObject({ type: 'note', text: expect.stringContaining('300m: 2% used') });
    expect((events.at(-1) as any).text).toContain('10080m: 8% used');
  });

  it('translates the house slash menu spelling into Codex skill invocation', async () => {
    const calls: any[] = [];
    const driver = new CodexDriver() as any;
    driver.threadId = 'thread';
    driver.skills = new Map([['beads', '/skills/beads/SKILL.md']]);
    driver.emit = () => {};
    driver.call = async (method: string, params: any) => { calls.push([method, params]); return { turn: { id: 'turn' } }; };
    await driver.send({ text: '/beads find ready work', images: [] });
    expect(calls[0][0]).toBe('turn/start');
    expect(calls[0][1].input).toEqual([
      { type: 'skill', name: 'beads', path: '/skills/beads/SKILL.md' },
      { type: 'text', text: 'find ready work', text_elements: [] },
    ]);
  });

  it('steers an active turn instead of trying to start a second turn', async () => {
    const calls: any[] = [];
    const driver = new CodexDriver() as any;
    driver.threadId = 'thread';
    driver.turnId = 'active-turn';
    driver.emit = () => {};
    driver.call = async (method: string, params: any) => { calls.push([method, params]); return {}; };
    await driver.send({ text: 'Tell the helper to focus on tests', images: [] });
    expect(calls[0]).toMatchObject(['turn/steer', { threadId: 'thread', expectedTurnId: 'active-turn' }]);
  });

  it('stops one Codex subagent by interrupting its active child turn', async () => {
    const calls: any[] = [];
    const driver = new CodexDriver() as any;
    driver.agents.set('helper', { since: Date.now(), model: null, calls: 0 });
    driver.call = async (method: string, params: any) => {
      calls.push([method, params]);
      return method === 'thread/read' ? { thread: { turns: [{ id: 'child-turn', status: 'inProgress' }] } } : {};
    };
    await driver.stopAgent('helper');
    expect(calls.at(-1)).toEqual(['turn/interrupt', { threadId: 'helper', turnId: 'child-turn' }]);
  });
});
