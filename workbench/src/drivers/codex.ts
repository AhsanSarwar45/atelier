/** Codex app-server (JSON-RPC over stdio) translated into WBP. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

import type { AgentControl, AgentState } from '../../../src/workbench/protocol.ts';
import type { Driver, DriverEvent, PermissionAnswer, PromptInput, StartOptions } from './types.ts';

type Bag = Record<string, any>;
type Pending = { resolve: (value: any) => void; reject: (reason: Error) => void };
type PendingAsk = { answer: (choice: string, value?: string) => void };

const MODES = ['untrusted', 'on-request', 'never'];
const decision = (choice: PermissionAnswer) =>
  choice === 'allow_once' ? 'accept' : choice === 'allow_always' ? 'acceptForSession' : 'decline';

function patchSides(diff: string): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (line.startsWith('-')) before.push(line.slice(1));
    else if (line.startsWith('+')) after.push(line.slice(1));
    else {
      const same = line.startsWith(' ') ? line.slice(1) : line;
      before.push(same); after.push(same);
    }
  }
  return { before: before.join('\n'), after: after.join('\n') };
}

function outputOf(item: Bag): string {
  const value = item.aggregatedOutput ?? item.error?.message ?? item.failure?.message ?? item.result ?? item.results ?? '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function codexAgentDefinitions(cwd: string): { name: string; description: string; source: 'project' | 'user' }[] {
  const found = new Map<string, { name: string; description: string; source: 'project' | 'user' }>();
  for (const [dir, source] of [[join(homedir(), '.codex', 'agents'), 'user'], [join(cwd, '.codex', 'agents'), 'project']] as const) {
    let files: string[];
    try { files = readdirSync(dir).filter((file) => file.endsWith('.toml')); } catch { continue; }
    for (const file of files) {
      let text = '';
      try { text = readFileSync(join(dir, file), 'utf8'); } catch { continue; }
      const quoted = /^\s*description\s*=\s*["']([^"']*)["']/m.exec(text)?.[1];
      const name = basename(file, '.toml');
      found.set(name, { name, description: quoted ?? '', source });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

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
  const threads: Bag[] = [];
  let cursor: string | null = null;
  do {
    const result = await codexRequest('thread/list', {
      limit: 100, cursor, sortKey: 'updated_at', sortDirection: 'desc',
      ...(sourceKinds ? { sourceKinds } : {}),
    }, cwd ?? process.cwd());
    threads.push(...(result.data ?? []));
    cursor = result.nextCursor ?? null;
  } while (cursor);
  if (!cwd) return threads;
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return threads.filter((thread) => thread.cwd === cwd || String(thread.cwd).startsWith(root));
}

export async function readCodexThread(threadId: string, cwd: string): Promise<Bag> {
  return (await codexRequest('thread/read', { threadId, includeTurns: true }, cwd)).thread;
}

export async function readCodexThreadUsage(threadId: string, cwd: string): Promise<{ input: number; output: number; total: number } | null> {
  const result = await codexRequest('account/usage/read', { threadId }, cwd);
  const groups = result.threadUsage?.groups ?? [];
  if (!result.threadUsage) return null;
  return groups.reduce((sum: { input: number; output: number; total: number }, group: Bag) => ({
    input: sum.input + Number(group.inputTokens ?? 0),
    output: sum.output + Number(group.outputTokens ?? 0),
    total: sum.total + Number(group.totalTokens ?? (Number(group.inputTokens ?? 0) + Number(group.outputTokens ?? 0))),
  }), { input: 0, output: 0, total: 0 });
}

/** Translate persisted Codex turns through the same WBP item translator as live traffic. */
export function replayCodexThread(thread: Bag, emit: (event: DriverEvent) => void): void {
  const driver = new CodexDriver();
  driver.emit = (event) => {
    // Replaying a tool must not make a dormant session look live.
    if (event.type !== 'session.state') emit(event);
  };
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') {
        driver.emit({ type: 'message.started', messageId: item.id, role: 'user' });
        const text = (item.content ?? []).filter((part: Bag) => part.type === 'text').map((part: Bag) => part.text).join('\n');
        if (text) driver.emit({ type: 'text.delta', messageId: item.id, text });
        for (const part of item.content ?? []) {
          if (part.type === 'image' && part.url) driver.emit({
            type: 'image', messageId: item.id,
            image: { dataUrl: part.url, mime: /^data:([^;,]+)/.exec(part.url)?.[1] ?? 'image/*', alt: 'Attached image' },
          });
          else if (part.type !== 'text') driver.emit({
            type: 'note', noteId: randomUUID(), rank: 'detail', kind: `attachment/${part.type}`,
            text: part.path || part.url || `A ${part.type} attachment was part of this turn.`, body: null,
          });
        }
        driver.emit({ type: 'message.completed', messageId: item.id });
      } else if (item.type === 'reasoning') {
        const text = [...(item.summary ?? []), ...(item.content ?? [])].join('\n');
        if (text) driver.emit({ type: 'thinking.delta', messageId: item.id, text });
      } else if (item.type === 'plan') {
        driver.emit({ type: 'note', noteId: item.id, rank: 'note', kind: 'plan', text: item.text, body: null });
      } else {
        driver.itemStarted(item);
        if (item.status !== 'inProgress') driver.itemCompleted(item);
      }
    }
  }
}

export class CodexDriver implements Driver {
  private child: ChildProcessWithoutNullStreams | null = null;
  emit: (event: DriverEvent) => void = () => {};
  private pending = new Map<number, Pending>();
  private asks = new Map<string, PendingAsk>();
  private messages = new Set<string>();
  private tools = new Map<string, string>();
  private toolOutput = new Map<string, string>();
  private agents = new Map<string, { since: number; model: string | null; calls: number; agentType?: string | null }>();
  private nextId = 1;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private model: string | undefined;
  private mode = 'on-request';
  private cwd = process.cwd();
  private skills = new Map<string, string>();
  private lastUsage: Bag | null = null;
  private contextWindow: number | null = null;

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
          threadId: opts.resume, cwd: opts.cwd, model: this.model ?? null,
          approvalPolicy: this.mode, excludeTurns: true,
        })
      : await this.call('thread/start', {
          cwd: opts.cwd, model: this.model ?? null, approvalPolicy: this.mode,
          sandbox: 'workspace-write', ephemeral: false,
        });
    this.threadId = opened.thread.id;
    this.model = opened.model || this.model;
    this.emit({
      type: 'session.started', brand: 'codex', externalId: this.threadId,
      model: this.model ?? null, cwd: opened.cwd || opts.cwd, permissionMode: this.mode,
    });
    await this.menu();
    await this.backgroundTerminals();
    this.emit({ type: 'session.state', state: 'idle', label: 'Ready' });
  }

  async send(input: PromptInput): Promise<void> {
    if (!this.threadId) throw new Error('Codex thread is not open');
    const special = /^\/(compact|review|status|usage|model|permissions)(?:\s+(.*))?$/s.exec(input.text.trim());
    if (special) return await this.special(special[1], special[2]?.trim() ?? '');
    const skill = /^\/(\S+)(.*)$/s.exec(input.text);
    const skillPath = skill ? this.skills.get(skill[1]) : undefined;
    const content: Bag[] = skillPath
      ? [{ type: 'skill', name: skill![1], path: skillPath }, ...(skill![2].trim() ? [{ type: 'text', text: skill![2].trim(), text_elements: [] }] : [])]
      : [{ type: 'text', text: input.text, text_elements: [] }];
    for (const image of input.images) content.push({ type: 'image', url: image.dataUrl });
    this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
    if (this.turnId) {
      await this.call('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: content });
    } else {
      const result = await this.call('turn/start', {
        threadId: this.threadId, input: content, model: this.model ?? null, approvalPolicy: this.mode,
      });
      this.turnId = result.turn.id;
    }
  }

  answer(askId: string, choice: PermissionAnswer, value?: string): void {
    const ask = this.asks.get(askId);
    if (!ask) return;
    this.asks.delete(askId);
    ask.answer(choice, value);
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

  async windowNow(): Promise<unknown | null> {
    if (!this.threadId) return null;
    const usage = this.lastUsage;
    const window = this.contextWindow;
    if (!usage || !window) return null;
    return {
      model: this.model ?? null, totalTokens: usage.totalTokens, maxTokens: window, rawMaxTokens: window,
      percentage: Math.round((usage.totalTokens / window) * 100),
      categories: [{ name: 'Conversation', tokens: usage.totalTokens }],
    };
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
    this.skills = new Map(skills.map((skill) => [skill.name, skill.path]));
    const commands = [
      { name: 'compact', description: 'Compact this conversation now', kind: 'command' as const },
      { name: 'review', description: 'Review uncommitted changes, or follow the supplied instructions', argumentHint: '[instructions]', kind: 'command' as const },
      { name: 'status', description: 'Show this Codex thread and its background commands', kind: 'command' as const },
      { name: 'usage', description: 'Show Codex account allowance and reset times', kind: 'command' as const },
      { name: 'model', description: 'Use the model picker below', kind: 'command' as const },
      { name: 'permissions', description: 'Use the permission picker below', kind: 'command' as const },
      ...skills.map((skill) => ({ name: skill.name, description: skill.description || skill.shortDescription || '', kind: 'skill' as const })),
    ];
    this.emit({
      type: 'session.menu',
      commands,
      skills: skills.map((skill) => skill.name),
      models: [
        { value: 'default', displayName: 'Default', description: 'Use the Codex default model' },
        ...models.map((m) => ({ value: m.model, displayName: m.displayName, description: m.description })),
      ],
      permissionModes: MODES, agentControls: this.agentControls(),
      agentDefinitions: codexAgentDefinitions(this.cwd),
    });
  }

  /** Codex exposes subagent threads; an active child turn can be interrupted exactly. */
  agentControls(): AgentControl[] { return ['stop', 'say']; }

  async stopAgent(agentId: string): Promise<void> {
    if (!this.agents.has(agentId)) throw new Error(`Codex agent ${agentId} is not running`);
    const result = await this.call('thread/read', { threadId: agentId, includeTurns: true });
    const turns: Bag[] = result.thread?.turns ?? [];
    const active = [...turns].reverse().find((turn) => turn.status === 'inProgress');
    if (!active) throw new Error(`Codex agent ${agentId} has no active turn to stop`);
    await this.call('turn/interrupt', { threadId: agentId, turnId: active.id });
  }

  private async backgroundTerminals(): Promise<void> {
    if (!this.threadId) return;
    try {
      const result = await this.call('thread/backgroundTerminals/list', { threadId: this.threadId, limit: 100 });
      for (const terminal of result.data ?? []) {
        if (this.tools.has(terminal.itemId)) continue;
        this.tools.set(terminal.itemId, 'Shell');
        this.emit({
          type: 'tool.started', toolCallId: terminal.itemId, name: 'Shell',
          input: { command: terminal.command, cwd: terminal.cwd, pid: terminal.osPid },
          title: terminal.command, parentToolCallId: null,
        });
      }
      if ((result.data ?? []).length) this.emit({ type: 'session.state', state: 'running_tool', label: 'Background command' });
    } catch {
      // Older app-server builds have no background terminal inventory.
    }
  }

  private async special(name: string, argument: string): Promise<void> {
    if (!this.threadId) return;
    if (name === 'compact') {
      this.emit({ type: 'session.state', state: 'thinking', label: 'Compacting' });
      await this.call('thread/compact/start', { threadId: this.threadId });
      this.note('compact', 'Compaction started.', 'note');
      return;
    }
    if (name === 'review') {
      const target = argument ? { type: 'custom', instructions: argument } : { type: 'uncommittedChanges' };
      this.emit({ type: 'session.state', state: 'thinking', label: 'Reviewing changes' });
      await this.call('review/start', { threadId: this.threadId, target, delivery: 'inline' });
      return;
    }
    if (name === 'model' || name === 'permissions') {
      this.note(name, `Use the ${name === 'model' ? 'model' : 'permission'} picker below the composer.`, 'note');
      return;
    }
    if (name === 'usage') {
      const raw = await this.call('account/rateLimits/read', {});
      const limits = raw.rateLimits ?? {};
      const snapshots = [limits, ...Object.values(raw.rateLimitsByLimitId ?? {})] as Bag[];
      const seen = new Set<string>();
      const says = snapshots.flatMap((snapshot) => [snapshot.primary, snapshot.secondary]).filter(Boolean).flatMap((window: Bag) => {
        const span = window.windowDurationMins ? `${window.windowDurationMins}m` : 'window';
        const key = `${span}:${window.usedPercent}:${window.resetsAt}`;
        if (seen.has(key)) return [];
        seen.add(key);
        const reset = window.resetsAt ? `, resets ${new Date(window.resetsAt * 1000).toLocaleString()}` : '';
        return [`${span}: ${window.usedPercent}% used${reset}`];
      });
      this.note('usage', says.join(' · ') || 'Codex did not report account limits.', 'note');
      return;
    }
    const thread = await this.call('thread/read', { threadId: this.threadId, includeTurns: false });
    const terminals = await this.call('thread/backgroundTerminals/list', { threadId: this.threadId, limit: 100 });
    const running = (terminals.data ?? []).map((terminal: Bag) => terminal.command);
    this.note('status', `Codex is ${thread.thread?.status?.type ?? 'unknown'}${running.length ? `. Running: ${running.join('; ')}` : '. No background commands.'}`, 'note');
  }

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
    if (message.method === 'currentTime/read') {
      this.write({ jsonrpc: '2.0', id: message.id, result: { currentTimeAt: Math.floor(Date.now() / 1000) } });
      return;
    }
    if (message.method === 'applyPatchApproval' || message.method === 'execCommandApproval') {
      const askId = p.id || p.callId || String(message.id);
      this.asks.set(askId, { answer: (choice) => {
        this.write({ jsonrpc: '2.0', id: message.id, result: {
          decision: choice === 'allow_once' ? 'approved' : choice === 'allow_always' ? 'approved_for_session' : 'denied',
        } });
        this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
      } });
      this.emit({
        type: 'ask.permission', askId, toolName: message.method === 'applyPatchApproval' ? 'File change' : 'Shell',
        input: p, title: p.reason || p.command || p.changes || 'Codex requested approval',
        options: [
          { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
          { id: 'allow_always', label: 'Allow for session', kind: 'allow_always' },
          { id: 'deny', label: 'Deny', kind: 'deny' },
        ],
      });
      this.emit({ type: 'session.state', state: 'waiting_permission', label: 'Waiting for permission' });
      return;
    }
    if (message.method === 'item/tool/requestUserInput') return this.askQuestions(message, p.questions ?? []);
    if (message.method === 'mcpServer/elicitation/request') return this.askElicitation(message);
    if (!message.method.endsWith('/requestApproval')) {
      this.write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported request ${message.method}` } });
      return;
    }
    const askId = p.approvalId || p.itemId || String(message.id);
    this.asks.set(askId, { answer: (choice) => {
      const result = message.method === 'item/permissions/requestApproval'
        ? { permissions: choice === 'deny' ? {} : p.permissions, scope: choice === 'allow_always' ? 'session' : 'turn' }
        : { decision: decision(choice) };
      this.write({ jsonrpc: '2.0', id: message.id, result });
      this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
    } });
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

  /** Present Codex's ordinary user questions without pretending they are permissions. */
  private askQuestions(message: Bag, questions: Bag[]): void {
    if (!questions.length) {
      this.write({ jsonrpc: '2.0', id: message.id, result: { answers: {} } });
      return;
    }
    const answers: Bag = {};
    let left = questions.length;
    for (const question of questions) {
      const askId = `${String(message.id)}:${question.id}`;
      this.asks.set(askId, { answer: (choice, value) => {
        answers[question.id] = { answers: [value ?? choice] };
        if (--left === 0) {
          this.write({ jsonrpc: '2.0', id: message.id, result: { answers } });
          this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
        }
      } });
      this.emit({
        type: 'ask.permission', askId, toolName: question.header || 'Question',
        input: { question: question.question }, title: question.question,
        options: (question.options ?? []).map((option: Bag) => ({ id: option.label, label: option.label, kind: 'answer' as const })),
        question: true, allowText: question.options == null || question.isOther === true, secret: question.isSecret === true,
      });
    }
    if (message.params?.isBlocking !== false) this.emit({ type: 'session.state', state: 'waiting_permission', label: 'Waiting for your answer' });
  }

  /** Turn the useful subset of MCP elicitation JSON Schema into ordinary WBP questions. */
  private askElicitation(message: Bag): void {
    const p = message.params ?? {};
    if (p.mode === 'url') {
      const askId = `${String(message.id)}:url`;
      this.asks.set(askId, { answer: (choice) => {
        this.write({ jsonrpc: '2.0', id: message.id, result: { action: choice === 'deny' ? 'decline' : 'accept' } });
        this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
      } });
      this.emit({
        type: 'ask.permission', askId, toolName: `${p.serverName} needs you`, input: { url: p.url },
        title: p.message, question: true, href: p.url,
        options: [{ id: 'continue', label: 'Continue', kind: 'answer' }, { id: 'deny', label: 'Decline', kind: 'deny' }],
      });
      this.emit({ type: 'session.state', state: 'waiting_permission', label: 'Waiting for your answer' });
      return;
    }
    const schema = p.requestedSchema ?? {};
    const properties = schema.properties ?? {};
    const questions = Object.entries(properties).map(([id, field]: [string, any]) => ({
      id, header: field.title || id, question: field.description || field.title || id,
      options: Array.isArray(field.enum) ? field.enum.map((label: unknown) => ({ label: String(label) })) : null,
      isOther: !Array.isArray(field.enum), isSecret: field.format === 'password',
    }));
    if (!questions.length) {
      this.write({ jsonrpc: '2.0', id: message.id, result: { action: 'decline' } });
      return;
    }
    const proxy = { ...message, id: `mcp:${String(message.id)}` };
    const answers: Bag = {};
    let left = questions.length;
    let finished = false;
    const askIds = questions.map((question) => `${String(proxy.id)}:${question.id}`);
    for (const question of questions) {
      const askId = `${String(proxy.id)}:${question.id}`;
      this.asks.set(askId, { answer: (choice, value) => {
        if (finished) return;
        if (choice === 'deny') {
          finished = true;
          this.write({ jsonrpc: '2.0', id: message.id, result: { action: 'decline' } });
          for (const other of askIds) {
            if (other !== askId && this.asks.delete(other)) this.emit({ type: 'ask.resolved', askId: other, chosen: 'deny' });
          }
          this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
          return;
        }
        const raw = value ?? choice;
        const field = properties[question.id] ?? {};
        answers[question.id] = field.type === 'boolean' ? raw === 'true' : field.type === 'number' || field.type === 'integer' ? Number(raw) : raw;
        if (--left === 0) {
          finished = true;
          this.write({ jsonrpc: '2.0', id: message.id, result: { action: 'accept', content: answers } });
          this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
        }
      } });
      this.emit({
        type: 'ask.permission', askId, toolName: question.header, input: { question: question.question },
        title: question.question, options: [
          ...(question.options ?? []).map((o: Bag) => ({ id: o.label, label: o.label, kind: 'answer' as const })),
          { id: 'deny', label: 'Decline', kind: 'deny' as const },
        ],
        question: true, allowText: question.isOther, secret: question.isSecret,
      });
    }
    this.emit({ type: 'session.state', state: 'waiting_permission', label: 'Waiting for your answer' });
  }

  private event(method: string, p: Bag): void {
    if (method === 'thread/status/changed') {
      const status = p.status ?? p.thread?.status ?? {};
      const waiting = status.activeFlags?.includes('waitingOnApproval') || status.activeFlags?.includes('waitingOnUserInput');
      const state = status.type === 'active' ? (waiting ? 'waiting_permission' : 'thinking') : status.type === 'systemError' ? 'errored' : 'idle';
      this.emit({ type: 'session.state', state, label: waiting ? 'Waiting for you' : status.type === 'active' ? 'Working' : status.type === 'systemError' ? 'Failed' : 'Ready' });
    } else if (method === 'skills/changed') {
      void this.menu();
    } else if (method === 'item/agentMessage/delta') {
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
      const total = p.tokenUsage?.total;
      this.lastUsage = u ?? this.lastUsage;
      if (total) this.emit({ type: 'cost', cost: { kind: 'tokens', input: total.inputTokens, output: total.outputTokens, total: total.totalTokens } });
      const window = p.tokenUsage?.modelContextWindow;
      if (typeof window === 'number') this.contextWindow = window;
      if (u && window) this.emit({ type: 'context', used: u.totalTokens, window });
    } else if (method === 'turn/started') {
      this.turnId = p.turn?.id ?? this.turnId;
      this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
    } else if (method === 'turn/completed') {
      this.turnId = null;
      const failed = p.turn?.status === 'failed';
      const interrupted = p.turn?.status === 'interrupted';
      if (failed) this.emit({ type: 'error', message: p.turn?.error?.message || 'Codex turn failed', fatal: false });
      this.emit({ type: 'session.state', state: failed ? 'errored' : interrupted ? 'stopped' : 'idle', label: failed ? 'Failed' : interrupted ? 'Stopped' : 'Ready' });
    } else if (method === 'error') {
      this.emit({ type: 'error', message: p.error?.message || p.message || 'Codex error', fatal: false });
    } else if (method === 'item/fileChange/patchUpdated') {
      for (const change of p.changes ?? []) this.emit({ type: 'diff', toolCallId: p.itemId, path: change.path, ...patchSides(change.diff ?? '') });
    } else if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
      const output = `${this.toolOutput.get(p.itemId) ?? ''}${p.delta ?? ''}`;
      this.toolOutput.set(p.itemId, output);
      this.emit({ type: 'tool.progress', toolCallId: p.itemId, seconds: 0, summary: output.slice(-2_000) });
    } else if (method === 'thread/compacted') {
      this.note(method, p.message || 'Conversation compacted.', 'note');
      this.emit({ type: 'session.state', state: 'idle', label: 'Ready' });
    } else if (method === 'warning' || method === 'model/rerouted') {
      this.note(method, p.message || JSON.stringify(p), 'note');
    } else if (!method.endsWith('/delta') && !method.endsWith('/outputDelta')) {
      this.note(method, p.message || JSON.stringify(p), 'detail');
    }
  }

  private openMessage(id: string): void {
    if (this.messages.has(id)) return;
    this.messages.add(id);
    this.emit({ type: 'message.started', messageId: id, role: 'assistant' });
    this.emit({ type: 'session.state', state: 'streaming', label: 'Answering' });
  }

  itemStarted(item: Bag): void {
    if (!item) return;
    if (item.type === 'agentMessage') return this.openMessage(item.id);
    if (item.type === 'reasoning') {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].join('\n');
      if (text) this.emit({ type: 'thinking.delta', messageId: item.id, text });
      return;
    }
    if (item.type === 'plan') {
      this.note('plan', item.text, 'note');
      return;
    }
    if (item.type === 'hookPrompt') {
      this.note('hook', (item.fragments ?? []).map((fragment: Bag) => fragment.text ?? fragment.content ?? '').filter(Boolean).join('\n') || 'A hook added instructions.', 'detail');
      return;
    }
    if (item.type === 'subAgentActivity') {
      const agentType = basename(item.agentPath || '', '.toml') || null;
      let known = this.agents.get(item.agentThreadId);
      if (item.kind === 'started' && !known) {
        known = { since: Date.now(), model: null, calls: 0, agentType };
        this.agents.set(item.agentThreadId, known);
        this.emit({ type: 'agent.started', agentId: item.agentThreadId, toolCallId: item.id, kind: 'helper', what: agentType || 'Subagent', agentType, model: null });
      } else if (item.kind === 'started' && known && agentType && known.agentType !== agentType) {
        known.agentType = agentType;
        this.emit({ type: 'agent.identified', agentId: item.agentThreadId, agentType });
      } else if (item.kind === 'interacted' && known) {
        this.emit({ type: 'agent.progress', agentId: item.agentThreadId, seconds: Math.round((Date.now() - known.since) / 1000), tokens: 0, calls: ++known.calls, state: 'running' });
      } else if (item.kind === 'interrupted' && known) {
        this.emit({ type: 'agent.finished', agentId: item.agentThreadId, state: 'stopped', seconds: Math.round((Date.now() - known.since) / 1000), tokens: 0, calls: known.calls, model: known.model, result: null });
        this.agents.delete(item.agentThreadId);
      }
      return;
    }
    if (item.type === 'collabAgentToolCall') {
      this.collab(item, false);
      return;
    }
    const names: Bag = {
      commandExecution: 'Shell', fileChange: 'Edit', mcpToolCall: `${item.server}/${item.tool}`,
      dynamicToolCall: item.tool, webSearch: 'Web search', imageView: 'View image', sleep: 'Wait', imageGeneration: 'Generate image',
    };
    const name = names[item.type];
    if (!name) {
      if (!['contextCompaction', 'enteredReviewMode', 'exitedReviewMode'].includes(item.type)) this.note(`item/${item.type}`, JSON.stringify(item), 'detail');
      return;
    }
    this.tools.set(item.id, name);
    this.emit({
      type: 'tool.started', toolCallId: item.id, name,
      input: item.arguments ?? { command: item.command, changes: item.changes, query: item.query, path: item.path, durationMs: item.durationMs },
      title: item.command || item.query || item.path || name, parentToolCallId: null,
    });
    this.emit({ type: 'session.state', state: 'running_tool', label: name });
    if (item.type === 'fileChange') {
      for (const change of item.changes ?? []) this.emit({ type: 'diff', toolCallId: item.id, path: change.path, ...patchSides(change.diff ?? '') });
    }
  }

  itemCompleted(item: Bag): void {
    if (!item) return;
    if (item.type === 'agentMessage') {
      const opened = this.messages.has(item.id);
      this.openMessage(item.id);
      if (!opened && item.text) this.emit({ type: 'text.delta', messageId: item.id, text: item.text });
      this.emit({ type: 'message.completed', messageId: item.id });
      return;
    }
    if (['reasoning', 'plan', 'hookPrompt', 'subAgentActivity', 'contextCompaction', 'enteredReviewMode', 'exitedReviewMode'].includes(item.type)) return;
    if (item.type === 'collabAgentToolCall') {
      this.collab(item, true);
      return;
    }
    if (!this.tools.has(item.id)) return;
    const ok = !['failed', 'declined'].includes(item.status) && (item.exitCode === null || item.exitCode === undefined || item.exitCode === 0);
    this.emit({ type: 'tool.completed', toolCallId: item.id, ok, output: outputOf(item) || this.toolOutput.get(item.id) || '' });
    this.tools.delete(item.id);
    this.toolOutput.delete(item.id);
  }

  /** Translate Codex's native subagent item into the workbench's agent row. */
  private collab(item: Bag, completed: boolean): void {
    const states = item.agentsStates ?? {};
    for (const agentId of item.receiverThreadIds ?? Object.keys(states)) {
      const state = states[agentId] ?? {};
      let known = this.agents.get(agentId);
      if (!known && item.tool === 'spawnAgent') {
        known = { since: Date.now(), model: item.model ?? null, calls: 0, agentType: null };
        this.agents.set(agentId, known);
        this.emit({
          type: 'agent.started', agentId, toolCallId: item.id, kind: 'helper',
          what: item.prompt || 'Subagent', agentType: known.agentType ?? null, model: known.model,
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
        void this.call('account/usage/read', { threadId: agentId }).then((usage) => {
          const tokens = (usage.threadUsage?.groups ?? []).reduce((sum: number, group: Bag) => sum + Number(group.totalTokens ?? 0), 0);
          if (tokens > 0) this.emit({
            type: 'agent.finished', agentId, state: final, seconds, tokens,
            calls: known!.calls, model: known!.model, result: state.message ?? null,
          });
        }).catch(() => {});
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
