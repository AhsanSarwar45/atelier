/** Codex app-server (JSON-RPC over stdio) translated into WBP. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

import type { AgentControl, AgentState } from '../../../src/workbench/protocol.ts';
import type { Driver, DriverEvent, PermissionAnswer, PromptInput, StartOptions } from './types.ts';

type Bag = Record<string, any>;
type Pending = { resolve: (value: any) => void; reject: (reason: Error) => void };

const MODES = ['untrusted', 'on-request', 'never'];
const decision = (choice: PermissionAnswer) =>
  choice === 'allow_once' ? 'accept' : choice === 'allow_always' ? 'acceptForSession' : 'decline';

/** A short-lived app-server request for discovery and read-only history. */
export function codexRequest(method: string, params: Bag, cwd = process.cwd()): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CODEX_PATH || 'codex', ['app-server', '--stdio'], {
      cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let initialized = false;
    const timer = setTimeout(() => finish(new Error(`Codex ${method} timed out`)), 15_000);
    const finish = (error: Error | null, value?: any) => {
      clearTimeout(timer);
      child.kill('SIGTERM');
      error ? reject(error) : resolve(value);
    };
    child.once('error', finish);
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: Bag;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1 && !initialized) {
        if (message.error) return finish(new Error(message.error.message || 'Codex initialization failed'));
        initialized = true;
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method, params })}\n`);
      } else if (message.id === 2) {
        finish(message.error ? new Error(message.error.message || `Codex ${method} failed`) : null, message.result);
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { clientInfo: { name: 'beads-workbench', title: 'Beads Workbench', version: '0.1.0' }, capabilities: { experimentalApi: true } },
    })}\n`);
  });
}

export async function listCodexThreads(cwd: string | null, everything = false): Promise<Bag[]> {
  const sourceKinds = everything
    ? ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown']
    : undefined;
  const result = await codexRequest('thread/list', {
    limit: 1000, sortKey: 'updated_at', sortDirection: 'desc',
    ...(sourceKinds ? { sourceKinds } : {}),
  }, cwd ?? process.cwd());
  const threads: Bag[] = result.data ?? [];
  if (!cwd) return threads;
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return threads.filter((thread) => thread.cwd === cwd || String(thread.cwd).startsWith(root));
}

export async function readCodexThread(threadId: string, cwd: string): Promise<Bag> {
  return (await codexRequest('thread/read', { threadId, includeTurns: true }, cwd)).thread;
}

export class CodexDriver implements Driver {
  private child: ChildProcessWithoutNullStreams | null = null;
  private emit: (event: DriverEvent) => void = () => {};
  private pending = new Map<number, Pending>();
  private asks = new Map<string, { rpcId: string | number; method: string }>();
  private messages = new Set<string>();
  private tools = new Map<string, string>();
  private agents = new Map<string, { since: number; model: string | null; calls: number }>();
  private nextId = 1;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private model: string | undefined;
  private mode = 'on-request';
  private cwd = process.cwd();

  async start(opts: StartOptions): Promise<void> {
    this.emit = opts.emit;
    this.cwd = opts.cwd;
    this.model = opts.model === 'default' ? undefined : opts.model;
    this.mode = MODES.includes(opts.permissionMode) ? opts.permissionMode : 'on-request';
    const executable = process.env.CODEX_PATH || 'codex';
    this.child = spawn(executable, ['app-server', '--stdio'], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.once('error', (error) => this.fail(error));
    this.child.once('exit', (code, signal) => {
      if (this.child) this.fail(new Error(`app-server exited (${signal ?? code ?? 'unknown'})`));
    });
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) this.note('stderr', text, 'detail');
    });
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
    await this.call('initialize', {
      clientInfo: { name: 'beads-workbench', title: 'Beads Workbench', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify('initialized', {});

    const opened = opts.resume
      ? await this.call('thread/resume', {
          threadId: opts.resume, cwd: opts.cwd, model: opts.model ?? null,
          approvalPolicy: this.mode, excludeTurns: true,
        })
      : await this.call('thread/start', {
          cwd: opts.cwd, model: opts.model ?? null, approvalPolicy: this.mode,
          sandbox: 'workspace-write', ephemeral: false,
        });
    this.threadId = opened.thread.id;
    this.model = opened.model || this.model;
    this.emit({
      type: 'session.started', brand: 'codex', externalId: this.threadId,
      model: this.model ?? null, cwd: opened.cwd || opts.cwd, permissionMode: this.mode,
    });
    await this.menu();
    this.emit({ type: 'session.state', state: 'idle', label: 'Ready' });
  }

  async send(input: PromptInput): Promise<void> {
    if (!this.threadId) throw new Error('Codex thread is not open');
    const content: Bag[] = [{ type: 'text', text: input.text, text_elements: [] }];
    for (const image of input.images) content.push({ type: 'image', url: image.dataUrl });
    this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
    const result = await this.call('turn/start', {
      threadId: this.threadId,
      input: content,
      model: this.model ?? null,
      approvalPolicy: this.mode,
    });
    this.turnId = result.turn.id;
  }

  answer(askId: string, choice: PermissionAnswer): void {
    const ask = this.asks.get(askId);
    if (!ask) return;
    this.asks.delete(askId);
    this.write({ jsonrpc: '2.0', id: ask.rpcId, result: { decision: decision(choice) } });
    this.emit({ type: 'ask.resolved', askId, chosen: choice });
  }

  async setMode(mode: string): Promise<void> {
    if (!MODES.includes(mode)) throw new Error(`Codex does not support approval policy "${mode}"`);
    this.mode = mode;
    this.emit({ type: 'session.pinned', permissionMode: mode, model: null });
  }

  async setModel(model: string): Promise<void> {
    this.model = model === 'default' ? undefined : model;
    this.emit({ type: 'session.pinned', permissionMode: null, model: this.model ?? model });
  }

  async interrupt(): Promise<void> {
    if (this.threadId && this.turnId) await this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }

  async close(): Promise<void> {
    this.child?.kill('SIGTERM');
    this.child = null;
    for (const pending of this.pending.values()) pending.reject(new Error('Codex app-server closed'));
    this.pending.clear();
  }

  private async menu(): Promise<void> {
    let models: Bag[] = [];
    let skills: Bag[] = [];
    try { models = (await this.call('model/list', { includeHidden: false })).data ?? []; } catch {}
    try {
      const entries = (await this.call('skills/list', { cwds: [this.cwd], forceReload: false })).data ?? [];
      skills = entries.flatMap((entry: Bag) => entry.skills ?? []).filter((skill: Bag) => skill.enabled !== false);
    } catch {}
    this.emit({
      type: 'session.menu',
      commands: skills.map((skill) => ({ name: skill.name, description: skill.description || skill.shortDescription || '', kind: 'skill' as const })),
      skills: skills.map((skill) => skill.name),
      models: models.map((m) => ({ value: m.model, displayName: m.displayName, description: m.description })),
      permissionModes: MODES, agentControls: this.agentControls(),
    });
  }

  /** Codex exposes subagents natively; messages are relayed through their owner. */
  agentControls(): AgentControl[] { return ['say']; }

  private call(method: string, params: Bag): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: Bag): void { this.write({ jsonrpc: '2.0', method, params }); }
  private write(message: Bag): void { this.child?.stdin.write(`${JSON.stringify(message)}\n`); }

  private receive(line: string): void {
    let message: Bag;
    try { message = JSON.parse(line); } catch { return this.note('protocol', line, 'detail'); }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      return message.error ? pending.reject(new Error(message.error.message || 'Codex request failed')) : pending.resolve(message.result);
    }
    if (message.method && message.id !== undefined) return this.ask(message);
    if (message.method) this.event(message.method, message.params ?? {});
  }

  private ask(message: Bag): void {
    const p = message.params ?? {};
    if (!message.method.endsWith('/requestApproval')) {
      this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported request ${message.method}` } });
      return;
    }
    const askId = p.approvalId || p.itemId || String(message.id);
    this.asks.set(askId, { rpcId: message.id, method: message.method });
    const toolName = message.method.includes('fileChange') ? 'File change' : 'Shell';
    this.emit({
      type: 'ask.permission', askId, toolName,
      input: { command: p.command, cwd: p.cwd, reason: p.reason, grantRoot: p.grantRoot },
      title: p.reason || (p.command ? `Run ${p.command}` : `Allow ${toolName.toLowerCase()}`),
      options: [
        { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
        { id: 'allow_always', label: 'Allow for session', kind: 'allow_always' },
        { id: 'deny', label: 'Deny', kind: 'deny' },
      ],
    });
    this.emit({ type: 'session.state', state: 'waiting_permission', label: 'Waiting for permission' });
  }

  private event(method: string, p: Bag): void {
    if (method === 'item/agentMessage/delta') {
      this.openMessage(p.itemId);
      this.emit({ type: 'text.delta', messageId: p.itemId, text: p.delta });
    } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      this.emit({ type: 'thinking.delta', messageId: p.itemId, text: p.delta });
    } else if (method === 'turn/plan/updated') {
      this.emit({ type: 'todo', items: (p.plan ?? []).map((x: Bag, i: number) => ({ id: String(i), text: x.step, status: x.status })) });
    } else if (method === 'item/started') {
      this.itemStarted(p.item);
    } else if (method === 'item/completed') {
      this.itemCompleted(p.item);
    } else if (method === 'thread/tokenUsage/updated') {
      const u = p.tokenUsage?.last;
      if (u) this.emit({ type: 'cost', cost: { kind: 'tokens', input: u.inputTokens, output: u.outputTokens, total: u.totalTokens } });
      const total = p.tokenUsage?.total;
      const window = p.tokenUsage?.modelContextWindow;
      if (total && window) this.emit({ type: 'context', used: total.totalTokens, window });
    } else if (method === 'turn/started') {
      this.turnId = p.turn?.id ?? this.turnId;
      this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
    } else if (method === 'turn/completed') {
      this.turnId = null;
      const failed = p.turn?.status === 'failed';
      if (failed) this.emit({ type: 'error', message: p.turn?.error?.message || 'Codex turn failed', fatal: false });
      this.emit({ type: 'session.state', state: failed ? 'errored' : 'idle', label: failed ? 'Failed' : 'Ready' });
    } else if (method === 'error') {
      this.emit({ type: 'error', message: p.error?.message || p.message || 'Codex error', fatal: false });
    } else if (method === 'warning' || method === 'thread/compacted' || method === 'model/rerouted') {
      this.note(method, p.message || JSON.stringify(p), 'note');
    }
  }

  private openMessage(id: string): void {
    if (this.messages.has(id)) return;
    this.messages.add(id);
    this.emit({ type: 'message.started', messageId: id, role: 'assistant' });
    this.emit({ type: 'session.state', state: 'streaming', label: 'Answering' });
  }

  private itemStarted(item: Bag): void {
    if (!item) return;
    if (item.type === 'agentMessage') return this.openMessage(item.id);
    if (item.type === 'collabAgentToolCall') {
      this.collab(item, false);
      return;
    }
    const names: Bag = { commandExecution: 'Shell', fileChange: 'Edit', mcpToolCall: `${item.server}/${item.tool}`, dynamicToolCall: item.tool, webSearch: 'Web search' };
    const name = names[item.type];
    if (!name) return;
    this.tools.set(item.id, name);
    this.emit({ type: 'tool.started', toolCallId: item.id, name, input: item.arguments ?? { command: item.command, changes: item.changes }, title: item.command || name, parentToolCallId: null });
    this.emit({ type: 'session.state', state: 'running_tool', label: name });
  }

  private itemCompleted(item: Bag): void {
    if (!item) return;
    if (item.type === 'agentMessage') {
      this.openMessage(item.id);
      this.emit({ type: 'message.completed', messageId: item.id });
      return;
    }
    if (item.type === 'collabAgentToolCall') {
      this.collab(item, true);
      return;
    }
    if (!this.tools.has(item.id)) return;
    const ok = !['failed', 'declined'].includes(item.status) && (item.exitCode === null || item.exitCode === undefined || item.exitCode === 0);
    this.emit({ type: 'tool.completed', toolCallId: item.id, ok, output: item.aggregatedOutput || item.error?.message || '' });
    this.tools.delete(item.id);
  }

  /** Translate Codex's native subagent item into the workbench's agent row. */
  private collab(item: Bag, completed: boolean): void {
    const states = item.agentsStates ?? {};
    for (const agentId of item.receiverThreadIds ?? Object.keys(states)) {
      const state = states[agentId] ?? {};
      let known = this.agents.get(agentId);
      if (!known && item.tool === 'spawnAgent') {
        known = { since: Date.now(), model: item.model ?? null, calls: 0 };
        this.agents.set(agentId, known);
        this.emit({
          type: 'agent.started', agentId, toolCallId: item.id, kind: 'helper',
          what: item.prompt || 'Subagent', agentType: null, model: known.model,
        });
      }
      if (!known) continue;
      known.calls += completed ? 1 : 0;
      const seconds = Math.max(0, Math.round((Date.now() - known.since) / 1000));
      const status = String(state.status ?? (completed ? 'completed' : 'running'));
      const over = ['completed', 'errored', 'interrupted', 'shutdown', 'notFound'].includes(status);
      if (over) {
        const final: 'done' | 'failed' | 'stopped' = status === 'completed'
          ? 'done'
          : status === 'interrupted' || status === 'shutdown' ? 'stopped' : 'failed';
        this.emit({
          type: 'agent.finished', agentId, state: final, seconds, tokens: 0,
          calls: known.calls, model: known.model, result: state.message ?? null,
        });
        this.agents.delete(agentId);
      } else {
        const rowState: AgentState = status === 'running' || status === 'pendingInit' ? 'running' : 'parked';
        this.emit({
          type: 'agent.progress', agentId, seconds, tokens: 0, calls: known.calls,
          ...(state.message ? { doing: state.message } : {}), state: rowState,
        });
      }
    }
  }

  private note(kind: string, text: string, rank: 'note' | 'detail'): void {
    this.emit({ type: 'note', noteId: randomUUID(), rank, kind, text, body: null });
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emit({ type: 'error', message: `Could not start Codex: ${error.message}`, fatal: true });
  }
}
