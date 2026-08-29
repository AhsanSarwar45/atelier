/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({}));

import type { WbpEvent } from '../../../src/workbench/protocol';
import { foldAll } from '../../../src/workbench/fold';
import { CodexDriver, codexAgentDefinitions, codexRolloutLine, codexThreadOpenRequest, replayCodexThread } from '../drivers/codex';
import { createDriver, defaultPermissionMode } from '../drivers';

type BareEvent = Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>;

describe('the provider boundary', () => {
  it('materializes a native MCP completion once when its begin row already exists', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);
    driver.itemStarted({
      id: 'exec-mcp', type: 'mcpToolCall', server: 'linear', tool: 'get_issue',
      arguments: { id: 'KEY-1309' }, readOnlyHint: true,
    });

    codexRolloutLine(JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'mcp_tool_call_end', call_id: 'exec-mcp', read_only_hint: true,
        invocation: { server: 'linear', tool: 'get_issue', arguments: { id: 'KEY-1309' } },
        result: { Ok: { content: [] } }, duration: { secs: 1, nanos: 0 },
      },
    }), driver, (event) => events.push(event as BareEvent));

    expect(events.filter((event) => event.type === 'tool.started')).toEqual([
      expect.objectContaining({
        toolCallId: 'exec-mcp', name: 'linear/get_issue', title: 'Read Linear issue KEY-1309',
      }),
    ]);
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(1);
  });

  it('materializes an MCP row from a native completion with no separate begin', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    codexRolloutLine(JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'mcp_tool_call_end', call_id: 'exec-delete', read_only_hint: false,
        invocation: { server: 'gmail', tool: 'delete_label', arguments: { id: 'old' } },
        result: { Ok: { content: [] } }, duration: { secs: 0, nanos: 1 },
      },
    }), driver, (event) => events.push(event as BareEvent));

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.started', toolCallId: 'exec-delete', name: 'gmail/delete_label',
      title: 'Deleted Gmail label old',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.completed', toolCallId: 'exec-delete', ok: true,
    }));
  });

  it('publishes a plan update immediately as checklist state', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);

    driver.event('turn/plan/updated', { plan: [
      { step: 'Find the cause', status: 'completed' },
      { step: 'Fix the screen', status: 'in_progress' },
    ] });

    expect(events).toEqual([{
      type: 'todo',
      items: [
        { id: '0', text: 'Find the cause', status: 'completed' },
        { id: '1', text: 'Fix the screen', status: 'in_progress' },
      ],
    }]);
  });

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
  it('draws native spawn and wait calls as named agent tools around one agent row', () => {
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
    driver.itemStarted({
      id: 'wait-1', type: 'collabAgentToolCall', tool: 'wait', status: 'inProgress',
      receiverThreadIds: ['agent-1'], agentsStates: { 'agent-1': { status: 'running', message: null } },
    });
    driver.itemCompleted({
      id: 'wait-1', type: 'collabAgentToolCall', tool: 'wait', status: 'completed',
      receiverThreadIds: ['agent-1'],
      agentsStates: { 'agent-1': { status: 'completed', message: 'Registry checked.' } },
    });

    expect(events[0]).toMatchObject({
      type: 'agent.started', agentId: 'agent-1', toolCallId: 'call-1',
      what: 'Inspect the session registry', model: 'gpt-5.6-luna',
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'agent.finished', agentId: 'agent-1', state: 'done', result: 'Registry checked.',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.started', toolCallId: 'call-1', name: 'spawn_agent', title: expect.stringContaining('Sent off'),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.started', toolCallId: 'wait-1', name: 'wait_agent',
      title: 'Waited for helper agent-1',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.completed', toolCallId: 'wait-1', title: 'helper agent-1 finished',
    }));
  });

  it('materializes categorized rows when Codex reports collaboration calls only at completion', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);

    driver.itemCompleted({
      id: 'completed-spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed',
      prompt: 'Inspect the worker', receiverThreadIds: ['completed-child'],
      agentsStates: { 'completed-child': { status: 'running', message: null } },
    });
    driver.itemCompleted({
      id: 'completed-wait', type: 'collabAgentToolCall', tool: 'wait', status: 'completed',
      receiverThreadIds: ['completed-child'],
      agentsStates: { 'completed-child': { status: 'completed', message: 'Worker finished.' } },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.started', toolCallId: 'completed-spawn', name: 'spawn_agent',
      title: expect.stringContaining('Inspect the worker'),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.completed', toolCallId: 'completed-spawn', ok: true,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.started', toolCallId: 'completed-wait', name: 'wait_agent',
      title: 'Waited for helper complete',
    }));
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(2);
  });

  it('finishes child threads without changing the parent chat state', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.threadId = 'parent';
    driver.emit = (event: BareEvent) => events.push(event);

    for (const agentThreadId of ['finished-child', 'failed-child']) {
      driver.itemStarted({
        id: `activity-${agentThreadId}`, type: 'subAgentActivity', kind: 'started',
        agentThreadId, agentPath: '/repo/.codex/agents/reviewer.toml',
      });
    }
    driver.event('thread/status/changed', {
      threadId: 'finished-child', status: { type: 'active', activeFlags: [] },
    });
    driver.event('thread/status/changed', {
      threadId: 'finished-child', status: { type: 'idle' },
    });
    driver.event('thread/status/changed', {
      threadId: 'failed-child', status: { type: 'systemError' },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'agent.progress', agentId: 'finished-child', state: 'running',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'agent.finished', agentId: 'finished-child', state: 'done',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'agent.finished', agentId: 'failed-child', state: 'failed',
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'session.state' }));
    expect(driver.agents.size).toBe(0);
  });

  it('draws a native sub-agent activity launch as a categorized agent command', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);

    driver.itemStarted({
      id: 'native-spawn', type: 'subAgentActivity', kind: 'started',
      agentThreadId: 'native-child', agentPath: '/repo/.codex/agents/inspector.toml',
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.started', toolCallId: 'native-spawn', name: 'spawn_agent',
      title: 'Sent off an inspector',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.completed', toolCallId: 'native-spawn', ok: true,
    }));

    driver.itemCompleted({
      id: 'native-spawn', type: 'collabAgentToolCall', tool: 'spawnAgent',
      receiverThreadIds: ['native-child'], agentsStates: { 'native-child': { status: 'running', message: null } },
    });
    expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool.completed')).toHaveLength(1);
  });

  it('names a native wait from the active helper when Codex omits its receiver list', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);
    driver.itemStarted({
      id: 'native-spawn', type: 'subAgentActivity', kind: 'started',
      agentThreadId: 'native-child', agentPath: '/repo/.codex/agents/inspector.toml',
    });

    driver.itemStarted({
      id: 'native-wait', type: 'collabAgentToolCall', tool: 'wait', status: 'inProgress',
      receiverThreadIds: [], agentsStates: {},
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.started', toolCallId: 'native-wait', name: 'wait_agent',
      title: 'Waited for inspector',
    }));
  });

  it('keeps nested commands and agents on one recursive execution graph', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.threadId = 'parent-thread';
    driver.emit = (event: BareEvent) => events.push(event);

    driver.itemStarted({
      id: 'outer-spawn', type: 'subAgentActivity', kind: 'started',
      agentThreadId: 'outer-agent', agentPath: '/repo/.codex/agents/researcher.toml',
    });
    driver.event('item/started', {
      threadId: 'outer-agent',
      item: {
        id: 'nested-spawn', type: 'collabAgentToolCall', tool: 'spawnAgent',
        prompt: 'Inspect the parser', model: 'gpt-5.6-luna',
        receiverThreadIds: ['nested-agent'],
        agentsStates: { 'nested-agent': { status: 'running', message: null } },
      },
    });
    driver.event('item/started', {
      threadId: 'nested-agent',
      item: { id: 'nested-command', type: 'commandExecution', command: 'rg parser', commandActions: [] },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'agent.started', agentId: 'nested-agent',
      execution: expect.objectContaining({
        conversationId: 'nested-agent', actorId: 'nested-agent',
        parentActorId: 'outer-agent', operationId: 'nested-spawn',
        parentOperationId: 'outer-spawn',
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.started', toolCallId: 'nested-spawn', parentToolCallId: 'outer-spawn',
      execution: expect.objectContaining({
        conversationId: 'outer-agent', actorId: 'outer-agent',
        operationId: 'nested-spawn', parentOperationId: 'outer-spawn',
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.started', toolCallId: 'nested-command', parentToolCallId: 'nested-spawn',
      execution: expect.objectContaining({
        conversationId: 'nested-agent', actorId: 'nested-agent',
        parentActorId: 'outer-agent', operationId: 'nested-command',
      }),
    }));
  });

  it('projects native completion onto the categorized agent command instead of a message', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);
    driver.itemStarted({
      id: 'spawn-reviewer', type: 'subAgentActivity', kind: 'started',
      agentThreadId: 'reviewer-id', agentPath: '/repo/.codex/agents/reviewer.toml',
    });
    driver.event('thread/status/changed', { threadId: 'reviewer-id', status: { type: 'active' } });
    driver.event('thread/status/changed', { threadId: 'reviewer-id', status: { type: 'idle' } });

    const view = foldAll(events.map((event, index) => ({
      ...event, seq: index + 1, sessionId: 'chat', at: new Date(index * 1_000).toISOString(),
    })) as WbpEvent[]);
    const operation = view.items.find((item) => item.kind === 'tool' && item.id === 'spawn-reviewer');
    expect(operation).toMatchObject({
      kind: 'tool', name: 'spawn_agent', title: 'reviewer finished', status: 'ok',
    });
    expect(view.items.filter((item) => item.kind === 'message')).toHaveLength(0);
  });

  it.each(['status-first', 'item-first'] as const)(
    'writes one opening and one ending when native completion is %s',
    (order) => {
      const events: BareEvent[] = [];
      const driver = new CodexDriver() as any;
      driver.threadId = 'parent';
      driver.emit = (event: BareEvent) => events.push(event);
      driver.call = async () => ({});
      const started = {
        id: 'call-order', type: 'collabAgentToolCall', tool: 'spawnAgent',
        prompt: 'Check ordering', model: 'gpt-5.6-luna', receiverThreadIds: ['ordered-child'],
        agentsStates: { 'ordered-child': { status: 'running', message: null } },
      };
      const completed = {
        ...started,
        agentsStates: { 'ordered-child': { status: 'completed', message: 'Done.' } },
      };

      if (order === 'status-first') {
        driver.event('thread/status/changed', { threadId: 'ordered-child', status: { type: 'active' } });
        driver.event('thread/status/changed', { threadId: 'ordered-child', status: { type: 'idle' } });
        driver.itemStarted(started);
        driver.itemCompleted(completed);
      } else {
        driver.itemStarted(started);
        driver.itemCompleted(completed);
        driver.event('thread/status/changed', { threadId: 'ordered-child', status: { type: 'active' } });
        driver.event('thread/status/changed', { threadId: 'ordered-child', status: { type: 'idle' } });
      }

      expect(events.filter((event) => event.type === 'agent.started')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'agent.finished')).toHaveLength(1);
    },
  );

  it('adds late native usage as final accounting without a second ending', async () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);
    driver.call = async () => ({ threadUsage: { groups: [{ totalTokens: 321 }] } });
    const item = {
      id: 'call-usage', type: 'collabAgentToolCall', tool: 'spawnAgent',
      prompt: 'Count usage', model: 'gpt-5.6-luna', receiverThreadIds: ['usage-child'],
      agentsStates: { 'usage-child': { status: 'completed', message: 'Done.' } },
    };
    driver.itemStarted({ ...item, agentsStates: { 'usage-child': { status: 'running', message: null } } });
    driver.itemCompleted(item);
    driver.itemStarted({ ...item, id: 'wait-usage', tool: 'wait', agentsStates: { 'usage-child': { status: 'running', message: null } } });
    driver.itemCompleted({ ...item, id: 'wait-usage', tool: 'wait' });

    await vi.waitFor(() => expect(events.some((event: any) => event.type === 'agent.progress' && event.finalUsage)).toBe(true));
    expect(events.filter((event) => event.type === 'agent.finished')).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'agent.progress', agentId: 'usage-child', tokens: 321, finalUsage: true,
    }));
  });

  it('still uses the parent thread status for the parent chat', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.threadId = 'parent';
    driver.emit = (event: BareEvent) => events.push(event);

    driver.event('thread/status/changed', {
      threadId: 'parent', status: { type: 'active', activeFlags: [] },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'session.state', state: 'thinking', label: 'Working',
    }));
  });

  it('attributes a child thread message to the call that spawned it', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.threadId = 'parent';
    driver.emit = (event: BareEvent) => events.push(event);
    driver.itemStarted({
      id: 'spawn-child', type: 'collabAgentToolCall', tool: 'spawnAgent', prompt: 'Inspect',
      receiverThreadIds: ['child-thread'], agentsStates: { 'child-thread': { status: 'running', message: null } },
    });
    driver.event('item/agentMessage/delta', {
      threadId: 'child-thread', itemId: 'child-answer', delta: 'CHILD ANSWER',
    });
    driver.event('item/completed', {
      threadId: 'child-thread', item: { id: 'child-answer', type: 'agentMessage', text: 'CHILD ANSWER' },
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'message.started', messageId: 'child-answer', parentToolCallId: 'spawn-child',
    }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'session.state', state: 'streaming' }));
  });
});

describe('Codex app-server requests', () => {
  it('switches collaboration modes through thread settings and carries the full preset into turns', async () => {
    const calls: any[] = [];
    const events: BareEvent[] = [];
    const driver = new CodexDriver() as any;
    driver.threadId = 'thread';
    driver.model = 'gpt-5.6-sol';
    driver.effort = 'high';
    driver.collaborationPresets = new Map([
      ['default', { name: 'Default', mode: 'default', model: null, reasoning_effort: null }],
      ['plan', { name: 'Plan', mode: 'plan', model: null, reasoning_effort: 'xhigh' }],
    ]);
    driver.emit = (event: BareEvent) => events.push(event);
    driver.call = async (method: string, params: any) => {
      calls.push([method, params]);
      return method === 'turn/start' ? { turn: { id: 'turn' } } : {};
    };

    await driver.setCollaborationMode('plan');
    await driver.send({ text: 'Ask before deciding', images: [] });

    expect(calls[0]).toEqual(['thread/settings/update', {
      threadId: 'thread',
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'gpt-5.6-sol', reasoning_effort: 'xhigh', developer_instructions: null },
      },
    }]);
    expect(calls[1][1].collaborationMode).toEqual(calls[0][1].collaborationMode);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'session.pinned', collaborationMode: 'plan', permissionMode: null, model: null,
    }));
  });

  it('rejects collaboration modes the provider did not advertise', async () => {
    const driver = new CodexDriver() as any;
    driver.collaborationPresets = new Map([['default', { mode: 'default' }]]);
    await expect(driver.setCollaborationMode('invented')).rejects.toThrow('does not support collaboration mode');
  });

  it('adapts shared image payloads to native local images and cleans them after the turn', async () => {
    const calls: any[] = [];
    const driver = new CodexDriver() as any;
    driver.threadId = 'thread';
    driver.emit = () => {};
    driver.call = async (method: string, params: any) => {
      calls.push([method, params]);
      const path = params.input?.find((part: any) => part.type === 'localImage')?.path;
      if (path) expect(existsSync(path)).toBe(true);
      return { turn: { id: 'turn' } };
    };

    await driver.send({
      text: 'What is in this image?',
      images: [{ mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', alt: 'sample.png' }],
    });

    const image = calls[0][1].input.find((part: any) => part.type === 'localImage');
    expect(image.path).toMatch(/atelier-codex-images-.*image-0\.png$/);
    driver.event('turn/completed', { turn: { id: 'turn', status: 'completed' } });
    expect(existsSync(image.path)).toBe(false);
  });

  it('denies and clears outstanding questions before interrupting a turn', async () => {
    const events: BareEvent[] = [];
    const answered: string[] = [];
    const driver = new CodexDriver() as any;
    driver.threadId = 'thread';
    driver.turnId = 'turn';
    driver.emit = (event: BareEvent) => events.push(event);
    driver.asks.set('approval', { answer: (choice: string) => answered.push(choice) });
    driver.call = vi.fn().mockResolvedValue({});

    await driver.interrupt();

    expect(answered).toEqual(['deny']);
    expect(driver.asks.size).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'ask.resolved', askId: 'approval', chosen: 'deny' }));
  });

  it('collects every ordinary user question and returns the protocol answer map', () => {
    const events: BareEvent[] = [];
    const writes: any[] = [];
    const driver = new CodexDriver() as any;
    driver.emit = (event: BareEvent) => events.push(event);
    driver.write = (message: any) => writes.push(message);

    driver.ask({ id: 9, method: 'item/tool/requestUserInput', params: {
      isBlocking: true,
      questions: [
        { id: 'shape', header: 'Shape', question: 'Which shape?', options: [{ label: 'Circle', description: 'Round' }] },
        { id: 'name', header: 'Name', question: 'What name?', options: null, isOther: true },
      ],
    } });
    const requested = events.find((event: any) => event.type === 'question.requested') as any;
    expect(requested).toMatchObject({
      requestId: '9', blocking: true,
      questions: [
        { id: 'shape', selection: 'single', options: [{ id: 'shape:option:0', label: 'Circle', description: 'Round' }] },
        { id: 'name', selection: 'text', allowCustom: true },
      ],
    });
    expect(events.some((event: any) => event.type === 'ask.permission')).toBe(false);

    driver.answerQuestions('9', { answers: [
      { questionId: 'shape', optionIds: ['shape:option:0'], note: 'Prefer simple' },
      { questionId: 'name', optionIds: [], customText: 'Ada' },
    ] });
    expect(writes[0]).toEqual({ jsonrpc: '2.0', id: 9, result: {
      answers: { shape: { answers: ['Circle', 'Additional note: Prefer simple'] }, name: { answers: ['Ada'] } },
    } });
    expect(events).toContainEqual(expect.objectContaining({ type: 'question.resolved', requestId: '9' }));
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

  it('finishes persisted helpers when the rollout active set clears', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver();
    const line = (type: string, payload: Record<string, unknown>) =>
      codexRolloutLine(JSON.stringify({ type, payload }), driver, (event) => events.push(event));

    line('world_state', { full: true, state: { environments: { subagents: null } } });
    line('event_msg', {
      type: 'sub_agent_activity', event_id: 'spawn-reviewer', kind: 'started',
      agent_thread_id: 'reviewer-thread', agent_path: '/root/reviewer',
    });
    line('world_state', {
      full: false, state: { environments: { subagents: '- reviewer: Ada' } },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'agent.finished' }));

    line('world_state', { full: false, state: { environments: { subagents: null } } });

    expect(events.filter((event) => event.type === 'agent.started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent.finished')).toEqual([
      expect.objectContaining({ type: 'agent.finished', agentId: 'reviewer-thread', state: 'done' }),
    ]);
  });

  it('finishes only helpers omitted from a non-empty rollout active set', () => {
    const events: BareEvent[] = [];
    const driver = new CodexDriver();
    const line = (type: string, payload: Record<string, unknown>) =>
      codexRolloutLine(JSON.stringify({ type, payload }), driver, (event) => events.push(event));

    for (const name of ['reader', 'reviewer']) line('event_msg', {
      type: 'sub_agent_activity', event_id: `spawn-${name}`, kind: 'started',
      agent_thread_id: `${name}-thread`, agent_path: `/root/${name}`,
    });
    line('world_state', {
      full: false, state: { environments: { subagents: '- reviewer: Ada' } },
    });

    expect(events.filter((event) => event.type === 'agent.finished')).toEqual([
      expect.objectContaining({ agentId: 'reader-thread', state: 'done' }),
    ]);
  });
});

describe('Codex first-class controls and live work', () => {
  it('turns a live generated image into a transcript image message', () => {
    const folder = mkdtempSync(join(tmpdir(), 'codex-generated-image-'));
    const path = join(folder, 'result.png');
    writeFileSync(path, Buffer.from('89504e470d0a1a0a', 'hex'));
    try {
      const events: BareEvent[] = [];
      const driver = new CodexDriver() as any;
      driver.emit = (event: BareEvent) => events.push(event);
      driver.itemStarted({ id: 'generated', type: 'imageGeneration', status: 'inProgress', result: '' });
      driver.itemCompleted({ id: 'generated', type: 'imageGeneration', status: 'completed', result: 'Made it', savedPath: path });

      expect(events).toContainEqual(expect.objectContaining({
        type: 'message.started', messageId: 'generated:image', role: 'assistant',
      }));
      expect(events).toContainEqual(expect.objectContaining({
        type: 'image', messageId: 'generated:image',
        image: expect.objectContaining({ mime: 'image/png', alt: 'result.png' }),
      }));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('turns a live viewed image into a transcript image message', () => {
    const folder = mkdtempSync(join(tmpdir(), 'codex-viewed-image-'));
    const path = join(folder, 'selected.png');
    writeFileSync(path, Buffer.from('89504e470d0a1a0a', 'hex'));
    try {
      const events: BareEvent[] = [];
      const driver = new CodexDriver() as any;
      driver.emit = (event: BareEvent) => events.push(event);
      driver.itemStarted({ id: 'viewed', type: 'imageView', path });
      driver.itemCompleted({ id: 'viewed', type: 'imageView', path });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'image', messageId: 'viewed:image', image: expect.objectContaining({ alt: 'selected.png' }),
      }));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('gives new and resumed workspace commands access to the local Beads server', () => {
    for (const resume of [undefined, 'existing-thread']) {
      const request = codexThreadOpenRequest({ cwd: '/repo', approvalPolicy: 'on-request', resume });
      expect(request).toMatchObject({
        method: resume ? 'thread/resume' : 'thread/start',
        params: {
          config: { sandbox_workspace_write: { network_access: true } },
        },
      });
    }
  });

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
      type: 'diff', toolCallId: 'edit', path: 'src/a.ts', before: 'const a = 1;', after: 'const a = 2;', line: 1,
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
    driver.itemStarted({
      id: 'activity-helper', type: 'subAgentActivity', kind: 'started',
      agentThreadId: 'helper', agentPath: '/repo/.codex/agents/helper.toml',
    });
    driver.call = async (method: string, params: any) => {
      calls.push([method, params]);
      return method === 'thread/read' ? { thread: { turns: [{ id: 'child-turn', status: 'inProgress' }] } } : {};
    };
    await driver.stopAgent('helper');
    expect(calls.at(-1)).toEqual(['turn/interrupt', { threadId: 'helper', turnId: 'child-turn' }]);
  });
});
