/** Codex app-server (JSON-RPC over stdio) translated into WBP. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

import type { AgentControl, AgentState, CommandInfo, ExecutionContext, PlanResponse, QuestionResponse } from '../../../src/workbench/protocol.ts';
import { toolTitle } from '../../../src/workbench/said-what-it-ran.ts';
import { widgetSpecs } from '../../../src/workbench/chat-widgets.ts';
import { proposedPlanSpecs } from '../../../src/workbench/proposed-plan.ts';
import { materializeComparisons } from '../materialize-chat-media.ts';
import { effortInWords } from '../../../src/workbench/machine-words.ts';
import type { Driver, DriverEvent, PermissionAnswer, PromptInput, StartOptions } from './types.ts';
import { AgentLifecycle, type ProviderAgentAdapter } from './agent-lifecycle.ts';
import { commandExecution, offeredSlashCommand } from './slash-commands.ts';

type Bag = Record<string, any>;
type Pending = { resolve: (value: any) => void; reject: (reason: Error) => void };
type PendingAsk = { answer: (choice: string, value?: string) => void };
type PendingQuestions = { messageId: string | number; questions: Bag[] };

// Narrow projections of the installed app-server schema (`codex app-server
// generate-ts`). Provider-specific wire types stop here; the lifecycle ledger
// below never needs to know which app-server item supplied a fact.
type CodexCollabStatus = 'pendingInit' | 'running' | 'interrupted' | 'completed' | 'errored' | 'shutdown' | 'notFound';
interface CodexCollabAgentToolCall {
  id: string;
  type: 'collabAgentToolCall';
  tool: 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent';
  receiverThreadIds: string[];
  prompt: string | null;
  model: string | null;
  agentsStates: Record<string, { status: CodexCollabStatus; message: string | null }>;
}
interface CodexSubAgentActivity {
  id: string;
  type: 'subAgentActivity';
  agentThreadId: string;
  kind: 'started' | 'interacted' | 'interrupted';
  agentPath?: string;
}
type CodexAgentSignal =
  | { type: 'thread/status/changed'; threadId: string; status: { type: 'active' | 'idle' | 'systemError' }; result?: string | null }
  | { type: 'item/subAgentActivity'; item: CodexSubAgentActivity; actorAgentId: string | null }
  | { type: 'item/collabAgentToolCall'; item: CodexCollabAgentToolCall; completed: boolean; actorAgentId: string | null };

const MODES = ['untrusted', 'on-request', 'never'];
const BEADS_SANDBOX_CONFIG = { sandbox_workspace_write: { network_access: true } };
export const CODEX_SLASH_COMMANDS: CommandInfo[] = [
  { name: 'compact', description: 'Compact this conversation now', kind: 'command', execution: 'native' },
  { name: 'review', description: 'Review uncommitted changes, or follow the supplied instructions', argumentHint: '[instructions]', kind: 'command', execution: 'native' },
  { name: 'status', description: 'Show this Codex thread and its background commands', kind: 'command', execution: 'native' },
  { name: 'usage', description: 'Show Codex account allowance and reset times', kind: 'command', execution: 'native' },
  { name: 'model', description: 'Show or change the model', argumentHint: '[model]', kind: 'command', execution: 'native' },
  { name: 'permissions', description: 'Show or change the permission mode', argumentHint: '[mode]', kind: 'command', execution: 'native' },
];
const decision = (choice: PermissionAnswer) =>
  choice === 'allow_once' ? 'accept' : choice === 'allow_always' ? 'acceptForSession' : 'decline';

export function codexThreadOpenRequest(opts: {
  resume?: string; cwd: string; model?: string; approvalPolicy: string; effort?: string;
}): { method: 'thread/start' | 'thread/resume'; params: Bag } {
  const common = {
    cwd: opts.cwd, model: opts.model ?? null, approvalPolicy: opts.approvalPolicy,
    effort: opts.effort ?? null, config: BEADS_SANDBOX_CONFIG,
  };
  return opts.resume
    ? { method: 'thread/resume', params: { threadId: opts.resume, ...common, excludeTurns: true } }
    : { method: 'thread/start', params: { ...common, sandbox: 'workspace-write', ephemeral: false } };
}

function patchSides(diff: string): { before: string; after: string; line?: number } {
  const before: string[] = [];
  const after: string[] = [];
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(diff);
  for (const line of diff.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (line.startsWith('-')) before.push(line.slice(1));
    else if (line.startsWith('+')) after.push(line.slice(1));
    else {
      const same = line.startsWith(' ') ? line.slice(1) : line;
      before.push(same); after.push(same);
    }
  }
  return {
    before: before.join('\n'),
    after: after.join('\n'),
    ...(hunk ? { line: Number(hunk[1]) } : {}),
  };
}

function outputOf(item: Bag): string {
  const value = item.aggregatedOutput ?? item.error?.message ?? item.failure?.message ?? item.result ?? item.results ?? '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
};

/** Codex app-server accepts a native localImage. Materialising the shared
 * browser payload avoids handing its JSON-RPC line a multi-megabyte data URL. */
function localCodexImage(image: { dataUrl: string; mime: string }, dir: string, at: number): Bag {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(image.dataUrl);
  if (!match) return { type: 'image', url: image.dataUrl };
  const mime = match[1] || image.mime;
  const path = join(dir, `image-${at}.${IMAGE_EXT[mime] ?? 'img'}`);
  writeFileSync(path, Buffer.from(match[2]!, 'base64'));
  return { type: 'localImage', path };
}

function localImagePayload(path: string): { dataUrl: string; mime: string; alt: string } | null {
  const ext = /\.([^.]+)$/.exec(path)?.[1]?.toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/*';
  try {
    return { dataUrl: `data:${mime};base64,${readFileSync(path).toString('base64')}`, mime, alt: basename(path) };
  } catch { return null; }
}

/** Put a tool-produced picture into the transcript as an assistant message.
 * Codex reports imageView/imageGeneration as tool items, not agentMessage
 * content, so without this translation the browser receives only the tool's
 * text receipt and PictureGrid has no image event to draw. */
function emitToolImage(driver: CodexDriver, item: Bag): void {
  const path = item.type === 'imageGeneration' ? item.savedPath : item.type === 'imageView' ? item.path : null;
  if (typeof path !== 'string' || !path) return;
  const image = localImagePayload(path);
  if (!image) return;
  const messageId = `${item.id}:image`;
  driver.emit({ type: 'message.started', messageId, role: 'assistant' });
  driver.emit({ type: 'image', messageId, image });
  driver.emit({ type: 'message.completed', messageId });
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

/** One shared read-only app-server per working directory. Starting Codex is
 * expensive; opening one chat used to start it once for history and again for
 * usage, while the registry started a third copy. */
class CodexReader {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 2;
  private ready: Promise<void>;

  constructor(cwd: string) {
    this.child = spawn(process.env.CODEX_PATH || 'codex', ['app-server', '--stdio'], { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    // The helper owns this cache, but test/CLI consumers must still be able to
    // exit naturally after their request has settled.
    this.child.unref();
    (this.child.stdin as any).unref?.();
    (this.child.stdout as any).unref?.();
    (this.child.stderr as any).unref?.();
    this.child.once('error', (error) => this.fail(error));
    this.child.once('exit', () => this.fail(new Error('Codex app-server exited')));
    createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
    this.ready = new Promise((resolve, reject) => {
      this.pending.set(1, { resolve: () => { this.write({ jsonrpc: '2.0', method: 'initialized', params: {} }); resolve(); }, reject });
      this.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        clientInfo: { name: 'beads-workbench-reader', title: 'Beads Workbench', version: '0.1.0' }, capabilities: { experimentalApi: true },
      } });
    });
  }

  async call(method: string, params: Bag): Promise<any> {
    await this.ready;
    return await new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, 15_000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private write(message: Bag): void { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  private receive(line: string): void {
    let message: Bag;
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    message.error ? pending.reject(new Error(message.error.message || 'Codex request failed')) : pending.resolve(message.result);
  }
  close(): void {
    this.child.kill('SIGTERM');
    this.fail(new Error('Codex reader closed'));
  }
  private fail(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
}

const readers = new Map<string, CodexReader>();
const rolloutPaths = new Map<string, string>();
export function codexRolloutPath(threadId: string): string | null { return rolloutPaths.get(threadId) ?? null; }
export function codexRequest(method: string, params: Bag, cwd = process.cwd()): Promise<any> {
  let reader = readers.get(cwd);
  if (!reader) { reader = new CodexReader(cwd); readers.set(cwd, reader); }
  return reader.call(method, params).catch((error) => {
    if (readers.get(cwd) === reader) readers.delete(cwd);
    reader.close();
    throw error;
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
    for (const thread of result.data ?? []) if (thread.id && thread.path) rolloutPaths.set(thread.id, thread.path);
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

/** Latest turn settings are persisted in the rollout even though thread/read
 * omits them. Tail only: large chats must still open promptly. */
export function codexThreadSettings(thread: Bag): { model: string; permissionMode: string; collaborationMode: string | null } {
  const fallback = { model: 'default', permissionMode: 'on-request', collaborationMode: null };
  if (typeof thread.path !== 'string') return fallback;
  let fd: number | null = null;
  try {
    fd = openSync(thread.path, 'r');
    const size = fstatSync(fd).size;
    // A single command result can be several megabytes; the turn_context just
    // before it still owns the badges for the current turn.
    const length = Math.min(size, 8 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let row: Bag;
      try { row = JSON.parse(lines[i]); } catch { continue; }
      const payload = row.payload ?? row;
      const settings = (row.type ?? payload.type) === 'turn_context'
        ? payload
        : row.type === 'event_msg' && payload.type === 'thread_settings_applied'
          ? payload.thread_settings
          : null;
      if (!settings) continue;
      return {
        model: settings.model || fallback.model,
        permissionMode: MODES.includes(settings.approval_policy) ? settings.approval_policy : fallback.permissionMode,
        collaborationMode: typeof settings.collaboration_mode?.mode === 'string'
          ? settings.collaboration_mode.mode
          : fallback.collaborationMode,
      };
    }
  } catch {} finally { if (fd !== null) closeSync(fd); }
  return fallback;
}

export function codexThreadUsageFromRollout(thread: Bag): { input: number; output: number; total: number; contextUsed: number; contextWindow: number } | null {
  if (typeof thread.path !== 'string') return null;
  let fd: number | null = null;
  try {
    fd = openSync(thread.path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let row: Bag;
      try { row = JSON.parse(lines[i]); } catch { continue; }
      const payload = row.payload ?? row;
      if (payload.type !== 'token_count' || !payload.info?.total_token_usage) continue;
      const total = payload.info.total_token_usage;
      const last = payload.info.last_token_usage ?? {};
      return {
        input: Number(total.input_tokens ?? 0), output: Number(total.output_tokens ?? 0), total: Number(total.total_tokens ?? 0),
        contextUsed: Number(last.total_tokens ?? 0), contextWindow: Number(payload.info.model_context_window ?? 0),
      };
    }
  } catch {} finally { if (fd !== null) closeSync(fd); }
  return null;
}

export function codexEffortMenu(models: Bag[], activeModel?: string): { efforts: Bag[]; defaultEffort: string | null } {
  const selected = models.find((model) => model.model === activeModel)
    ?? models.find((model) => model.isDefault === true)
    ?? models[0];
  const offered = selected?.supportedReasoningEfforts ?? [];
  const efforts = offered.flatMap((choice: Bag) => {
    const value = choice.reasoningEffort ?? choice.effort;
    return typeof value === 'string' && value ? [{
      value,
      displayName: effortInWords(value),
      description: choice.description,
    }] : [];
  });
  const stated = selected?.defaultReasoningEffort ?? selected?.defaultEffort;
  const defaultEffort = typeof stated === 'string' && efforts.some((choice: Bag) => choice.value === stated)
    ? stated
    : (efforts[0]?.value ?? null);
  return { efforts, defaultEffort };
}

export function codexResolvedEffort(current: string | undefined, fallback: string | null): string | undefined {
  return current || fallback || undefined;
}

/**
 * The level a chat is on once the model in use has said which it offers.
 *
 * A level the model does not offer is not the level this chat is on, whatever
 * was stored, so the model's own default takes over. An app-server that
 * announces no levels at all is not read as a model that has none, and what is
 * stored stands (bw-uxzk.2).
 */
export function codexEffortForModel(
  stored: string | undefined, offered: Bag[], defaultEffort: string | null,
): string | undefined {
  const stillOffered = offered.length === 0 || offered.some((choice) => choice.value === stored);
  return codexResolvedEffort(stillOffered ? stored : undefined, defaultEffort);
}

export async function codexMenu(cwd: string, activeModel?: string): Promise<Bag> {
  const [modelResult, skillResult, collaborationResult] = await Promise.allSettled([
    codexRequest('model/list', { includeHidden: false }, cwd),
    codexRequest('skills/list', { cwds: [cwd], forceReload: false }, cwd),
    codexRequest('collaborationMode/list', {}, cwd),
  ]);
  const models = modelResult.status === 'fulfilled' ? modelResult.value.data ?? [] : [];
  const entries = skillResult.status === 'fulfilled' ? skillResult.value.data ?? [] : [];
  const skills = entries.flatMap((entry: Bag) => entry.skills ?? []).filter((skill: Bag) => skill.enabled !== false);
  const effortMenu = codexEffortMenu(models, activeModel);
  const collaborationPresets = collaborationResult.status === 'fulfilled'
    ? (collaborationResult.value.data ?? []).filter((preset: Bag) => typeof preset.mode === 'string')
    : [];
  const collaborationModes = collaborationPresets.map((preset: Bag) => ({
    value: preset.mode,
    displayName: preset.name || preset.mode.replace(/(^|[-_])\w/g, (part: string) => part.replace(/[-_]/, '').toUpperCase()),
  }));
  return {
    commands: [...CODEX_SLASH_COMMANDS, ...skills.map((skill: Bag) => ({
      name: skill.name, description: skill.description || skill.shortDescription || '', kind: 'skill', execution: 'skill',
    }))],
    skills: skills.map((skill: Bag) => skill.name),
    models: [{ value: 'default', displayName: 'Default', description: 'Use the Codex default model' }, ...models.map((m: Bag) => ({ value: m.model, displayName: m.displayName, description: m.description }))],
    permissionModes: MODES, collaborationModes, collaborationPresets, ...effortMenu,
    agentControls: ['stop', 'say'], agentDefinitions: codexAgentDefinitions(cwd),
    skillPaths: Object.fromEntries(skills.map((skill: Bag) => [skill.name, skill.path])),
  };
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
          else if (part.type === 'localImage' && part.path) {
            const image = localImagePayload(part.path);
            if (image) driver.emit({ type: 'image', messageId: item.id, image });
          }
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
      } else if (item.type === 'agentMessage') {
        // Persisted messages are complete already. Opening first would turn a
        // genuinely empty app-server item into a blank transcript row.
        driver.itemCompleted(item);
      } else {
        driver.itemStarted(item);
        if (item.status !== 'inProgress') driver.itemCompleted(item, null, true);
      }
    }
  }
}

/**
 * `thread/read` is a whole Codex snapshot, not a tail. It can seed a transcript
 * when discovery cannot find the rollout, but it must never be appended below
 * rows already drawn from either the rollout or a live driver. Snapshot item
 * ids are not stable aliases of rollout ids, so row-level deduplication cannot
 * repair that merge after the fact (bw-jknr.1).
 */
export function seedCodexSnapshot(
  thread: Bag,
  state: { importedBy: number | null; drawn: number; drivenHere: boolean },
  emit: (event: DriverEvent) => void,
): boolean {
  if (state.importedBy !== null || state.drawn > 0 || state.drivenHere) return false;
  replayCodexThread(thread, emit);
  return true;
}

/** Stateful diff of thread/read snapshots. External Codex sessions do not
 * expose a subscribable app-server thread, so polling is unavoidable; replaying
 * the snapshots is not. */
function rolloutText(item: Bag): string {
  return (item.content ?? []).map((part: Bag) => part.text ?? '').filter(Boolean).join('\n');
}

function commandFromToolInput(input: unknown): string {
  if (typeof input !== 'string') return '';
  const found = /(?:\bcmd|"cmd")\s*:\s*("(?:[^"\\]|\\.)*")/.exec(input);
  if (!found) return input.slice(0, 500);
  try { return JSON.parse(found[1]!); } catch { return input.slice(0, 500); }
}

function rolloutTool(name: string, input: unknown): { name: string; arguments: Bag } {
  const text = typeof input === 'string' ? input : JSON.stringify(input ?? {});
  if (name === 'apply_patch' || /tools\.apply_patch\s*\(|\*\*\* Begin Patch/.test(text)) {
    const patch = text.replaceAll('\\n', '\n');
    const paths = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((hit) => hit[1]);
    return { name: 'Edit', arguments: paths.length ? { file_path: paths[0], files: paths } : {} };
  }
  if (/tools\.view_image\s*\(/.test(text)) {
    const path = /path\s*:\s*"([^"]+)"/.exec(text)?.[1];
    return { name: 'Read', arguments: path ? { file_path: path } : {} };
  }
  if (name === 'exec' || name === 'exec_command') {
    if (/tools\.write_stdin\s*\(/.test(text)) return { name: 'Wait', arguments: {} };
    if (/tools\.web__run\s*\(/.test(text)) {
      const query = /(?:"q"|q)\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
      return { name: /\b(?:open|click|find|screenshot)\s*:/.test(text) ? 'WebFetch' : 'WebSearch', arguments: query ? { query } : {} };
    }
    return { name: 'Bash', arguments: { command: commandFromToolInput(input) } };
  }
  if (name === 'wait') return { name: 'Wait', arguments: {} };
  return { name, arguments: typeof input === 'object' && input ? input as Bag : { input } };
}

/** Translate one newly appended Codex rollout row. This is deliberately a
 * line-level API: callers own byte offsets and never ask app-server for prior
 * turns. */
export function codexRolloutLine(line: string, driver: CodexDriver, emit: (event: DriverEvent) => void): void {
  let row: Bag;
  try { row = JSON.parse(line); } catch { return; }
  driver.emit = emit;
  const payload = row.payload ?? {};
  if (row.type === 'event_msg' && payload.type === 'sub_agent_activity') {
    driver.itemStarted({
      id: payload.event_id, type: 'subAgentActivity', kind: payload.kind,
      agentThreadId: payload.agent_thread_id, agentPath: payload.agent_path,
    });
    return;
  }
  if (row.type === 'event_msg' && payload.type === 'user_message') {
    const messageId = String(payload.id ?? `codex-user:${row.timestamp ?? randomUUID()}`);
    emit({ type: 'message.started', messageId, role: 'user' });
    if (typeof payload.message === 'string' && payload.message) {
      emit({ type: 'text.delta', messageId, text: payload.message });
    }
    for (const source of payload.images ?? []) {
      const url = typeof source === 'string' ? source : source?.url;
      if (typeof url !== 'string' || !url) continue;
      emit({
        type: 'image', messageId,
        image: {
          dataUrl: url,
          mime: /^data:([^;,]+)/.exec(url)?.[1] ?? 'image/*',
          alt: 'Attached image',
        },
      });
    }
    for (const source of payload.local_images ?? []) {
      const path = typeof source === 'string' ? source : source?.path;
      if (typeof path !== 'string' || !path) continue;
      const image = localImagePayload(path);
      if (image) emit({ type: 'image', messageId, image });
    }
    emit({ type: 'message.completed', messageId });
    return;
  }
  if (row.type === 'world_state' && Object.prototype.hasOwnProperty.call(payload.state?.environments ?? {}, 'subagents')) {
    driver.reconcileRolloutAgents(payload.state.environments.subagents);
    return;
  }
  if (row.type === 'event_msg' && payload.type === 'task_started') {
    emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
    return;
  }
  if (row.type === 'event_msg' && (payload.type === 'task_complete' || payload.type === 'turn_aborted')) {
    emit({ type: 'session.state', state: 'dormant', label: 'Asleep' });
    return;
  }
  if (row.type === 'turn_context') {
    emit({
      type: 'session.pinned',
      model: payload.model ?? 'default',
      permissionMode: MODES.includes(payload.approval_policy) ? payload.approval_policy : 'on-request',
      collaborationMode: typeof payload.collaboration_mode?.mode === 'string' ? payload.collaboration_mode.mode : null,
    });
    return;
  }
  if (row.type === 'event_msg' && payload.type === 'token_count' && payload.info) {
    const total = payload.info.total_token_usage ?? {};
    const last = payload.info.last_token_usage ?? {};
    emit({ type: 'cost', cost: { kind: 'tokens', input: Number(total.input_tokens ?? 0), output: Number(total.output_tokens ?? 0), total: Number(total.total_tokens ?? 0) } });
    if (payload.info.model_context_window) emit({ type: 'context', used: Number(last.total_tokens ?? 0), window: Number(payload.info.model_context_window) });
    return;
  }
  if (row.type === 'event_msg' && payload.type === 'mcp_tool_call_end') {
    const invocation = payload.invocation ?? {};
    const id = payload.call_id ?? `mcp:${invocation.server ?? 'service'}/${invocation.tool ?? 'call'}`;
    const input = {
      ...(invocation.arguments ?? {}),
      readOnlyHint: payload.read_only_hint === true,
      destructiveHint: payload.destructive_hint === true,
    };
    // Newer rollouts can carry only the native end record. When a matching
    // app-server begin already opened the row, `itemStarted` is deliberately
    // skipped so one logical call still draws once.
    if (!(driver as any).tools.has(id)) driver.itemStarted({
      id, type: 'mcpToolCall', server: invocation.server, tool: invocation.tool,
      arguments: input,
    });
    driver.itemCompleted({
      id, type: 'mcpToolCall',
      status: payload.result?.Err ? 'failed' : 'completed',
      result: payload.result,
    }, null, true);
    return;
  }
  if (row.type === 'event_msg' && payload.type === 'item_completed') {
    const item = payload.item ?? {};
    if (item.type === 'UserMessage') {
      emit({ type: 'message.started', messageId: item.id, role: 'user' });
      const text = rolloutText(item);
      if (text) emit({ type: 'text.delta', messageId: item.id, text });
      emit({ type: 'message.completed', messageId: item.id });
    } else if (item.type === 'AgentMessage') {
      driver.itemCompleted({ id: item.id, type: 'agentMessage', text: rolloutText(item) });
    } else if (item.type === 'Reasoning') {
      const text = [...(item.summary_text ?? []), ...(item.raw_content ?? [])].join('\n');
      if (text) emit({ type: 'thinking.delta', messageId: item.id, text });
    } else if (item.type === 'FileChange') {
      const toolCallId = (driver as any).__rolloutApply ?? item.id;
      for (const [path, change] of Object.entries(item.changes ?? {}) as [string, Bag][]) {
        if (change.unified_diff) emit({ type: 'diff', toolCallId, path, ...patchSides(change.unified_diff) });
      }
    }
    return;
  }
  if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
    driver.itemCompleted({ id: payload.id, type: 'agentMessage', text: rolloutText(payload) });
    return;
  }
  if (row.type === 'response_item' && (payload.type === 'custom_tool_call' || payload.type === 'function_call')) {
    const id = payload.call_id ?? payload.id;
    const tool = rolloutTool(payload.name, payload.input);
    if (tool.name === 'Edit') (driver as any).__rolloutApply = id;
    driver.itemStarted({ id, type: 'dynamicToolCall', tool: tool.name, arguments: tool.arguments });
    return;
  }
  if (row.type === 'response_item' && (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output')) {
    driver.itemCompleted({ id: payload.call_id, type: 'dynamicToolCall', status: 'completed', result: payload.output });
    if ((driver as any).__rolloutApply === payload.call_id) (driver as any).__rolloutApply = null;
  }
}

/** Replay one complete rollout through the same line translator used by the
 * incremental follower. This is the path an old Codex chat takes when opened. */
export function replayCodexRollout(text: string, emit: (event: DriverEvent) => void): void {
  const driver = new CodexDriver();
  for (const line of text.split('\n')) codexRolloutLine(line, driver, emit);
}

class CodexAgentAdapter implements ProviderAgentAdapter<CodexAgentSignal> {
  private readonly agents: AgentLifecycle;
  private readonly readUsage: (agentId: string) => Promise<number>;
  private readonly activeThreads = new Set<string>();

  constructor(
    agents: AgentLifecycle,
    readUsage: (agentId: string) => Promise<number>,
  ) {
    this.agents = agents;
    this.readUsage = readUsage;
  }

  accept(signal: CodexAgentSignal): boolean {
    if (signal.type === 'thread/status/changed') {
      const row = this.agents.get(signal.threadId);
      const seconds = row ? Math.max(0, Math.round((Date.now() - row.since) / 1000)) : undefined;
      if (signal.status.type === 'active') {
        this.activeThreads.add(signal.threadId);
        this.agents.progress(signal.threadId, { seconds, state: 'running' });
      } else if (signal.status.type === 'systemError') {
        this.activeThreads.delete(signal.threadId);
        this.agents.finish(signal.threadId, { state: 'failed', seconds, result: signal.result ?? null });
      } else if (this.activeThreads.delete(signal.threadId)) {
        // A newly spawned thread may report idle before its first turn starts.
        // Only an idle edge after native activity is a completion edge.
        this.agents.finish(signal.threadId, { state: 'done', seconds, result: signal.result ?? null });
      }
      return true;
    }

    if (signal.type === 'item/subAgentActivity') {
      const item = signal.item;
      const agentType = basename(item.agentPath || '', '.toml') || null;
      if (item.kind === 'started') {
        this.agents.start({
          agentId: item.agentThreadId,
          toolCallId: item.id,
          kind: 'helper',
          what: agentType || 'Subagent',
          agentType,
          model: null,
          execution: this.execution(item.agentThreadId, signal.actorAgentId, item.id, agentType),
        });
        if (agentType) this.agents.identify(item.agentThreadId, agentType);
      } else if (item.kind === 'interacted') {
        const row = this.agents.get(item.agentThreadId);
        this.agents.progress(item.agentThreadId, { calls: (row?.calls ?? 0) + 1, state: 'running' });
      } else {
        this.agents.finish(item.agentThreadId, { state: 'stopped', result: null });
      }
      return true;
    }

    const { item, completed } = signal;
    const states = item.agentsStates ?? {};
    for (const agentId of item.receiverThreadIds ?? Object.keys(states)) {
      if (item.tool === 'spawnAgent') {
        this.agents.start({
          agentId,
          toolCallId: item.id,
          kind: 'helper',
          what: item.prompt || 'Subagent',
          agentType: null,
          model: item.model,
          execution: this.execution(agentId, signal.actorAgentId, item.id, null),
        });
        const row = this.agents.get(agentId);
        this.agents.progress(agentId, {
          calls: (row?.calls ?? 0) + (completed ? 1 : 0),
          doing: states[agentId]?.message ?? undefined,
          state: 'running',
        });
        // Completion here means the spawn CALL returned, not that the child
        // thread finished. Native thread status or a completed wait says that.
        continue;
      }
      const row = this.agents.get(agentId);
      const native = states[agentId];
      const status = native?.status ?? (completed ? 'completed' : 'running');
      const calls = (row?.calls ?? 0) + (completed ? 1 : 0);
      if (['completed', 'errored', 'interrupted', 'shutdown', 'notFound'].includes(status)) {
        const state = status === 'completed' ? 'done'
          : status === 'interrupted' || status === 'shutdown' ? 'stopped' : 'failed';
        this.agents.finish(agentId, { state, calls, result: native?.message ?? null });
        void this.readUsage(agentId).then((tokens) => {
          if (tokens > 0) this.agents.finalUsage(agentId, { tokens, calls });
        }).catch(() => {});
      } else {
        this.agents.progress(agentId, {
          calls,
          doing: native?.message ?? undefined,
          state: status === 'running' || status === 'pendingInit' ? 'running' : 'parked',
        });
      }
    }
    return true;
  }

  private execution(
    agentId: string,
    parentAgentId: string | null,
    operationId: string,
    actorName: string | null,
  ): ExecutionContext {
    return {
      conversationId: agentId,
      actorId: agentId,
      actorName,
      parentActorId: parentAgentId,
      operationId,
      parentOperationId: parentAgentId ? this.agents.get(parentAgentId)?.toolCallId ?? null : null,
    };
  }
}

export class CodexDriver implements Driver {
  private child: ChildProcessWithoutNullStreams | null = null;
  emit: (event: DriverEvent) => void = () => {};
  private pending = new Map<number, Pending>();
  private asks = new Map<string, PendingAsk>();
  private questions = new Map<string, PendingQuestions>();
  private messages = new Set<string>();
  private completedMessages = new Set<string>();
  private plans = new Set<string>();
  private messageParents = new Map<string, string>();
  private childResults = new Map<string, string>();
  private tools = new Map<string, string>();
  private completedCollabTools = new Set<string>();
  private toolOutput = new Map<string, string>();
  private agents = new AgentLifecycle((event) => this.emit(event));
  private agentAdapter = new CodexAgentAdapter(this.agents, (agentId) => this.agentUsage(agentId));
  private nextId = 1;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private model: string | undefined;
  private effort: string | undefined;
  private collaborationMode: string | null = null;
  private collaborationPresets = new Map<string, Bag>();
  private mode = 'on-request';
  private cwd = process.cwd();
  private skills = new Map<string, string>();
  private commands: CommandInfo[] = [...CODEX_SLASH_COMMANDS];
  private lastUsage: Bag | null = null;
  private contextWindow: number | null = null;
  private imageDirs = new Set<string>();

  processId(): number | null {
    return this.child?.pid ?? null;
  }

  async start(opts: StartOptions): Promise<void> {
    this.emit = opts.emit;
    this.cwd = opts.cwd;
    this.model = opts.model === 'default' ? undefined : opts.model;
    this.effort = opts.effort;
    this.collaborationMode = null;
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

    const request = codexThreadOpenRequest({
      resume: opts.resume, cwd: opts.cwd, model: this.model,
      approvalPolicy: this.mode, effort: this.effort,
    });
    const opened = await this.call(request.method, request.params);
    this.threadId = opened.thread.id;
    // Codex owns this setting. On resume, recover it from Codex's persisted
    // turn context instead of accepting an Atelier-side copy.
    if (opts.resume) this.collaborationMode = codexThreadSettings(opened.thread).collaborationMode;
    this.model = opened.model || this.model;
    const openedEffort = opened.reasoningEffort ?? opened.effort
      ?? opened.thread?.reasoningEffort ?? opened.thread?.effort;
    if (typeof openedEffort === 'string' && openedEffort) this.effort = openedEffort;
    this.emit({
      type: 'session.started', brand: 'codex', externalId: this.threadId,
      model: this.model ?? null, cwd: opened.cwd || opts.cwd, permissionMode: this.mode, effort: this.effort ?? null,
      collaborationMode: this.collaborationMode,
    });
    await this.menu();
    await this.backgroundTerminals();
    this.emit({ type: 'session.state', state: 'idle', label: 'Ready' });
  }

  async send(input: PromptInput): Promise<void> {
    if (!this.threadId) throw new Error('Codex thread is not open');
    const offered = this.offered(input);
    if (offered && commandExecution(offered.command) !== 'skill') {
      return await this.special(offered.invocation.name, offered.invocation.argument);
    }
    const skillPath = offered ? this.skills.get(offered.invocation.name) : undefined;
    const content: Bag[] = skillPath
      ? [{ type: 'skill', name: offered!.invocation.name, path: skillPath }, ...(offered!.invocation.argument ? [{ type: 'text', text: offered!.invocation.argument, text_elements: [] }] : [])]
      : [{ type: 'text', text: input.text, text_elements: [] }];
    let imageDir: string | null = null;
    if (input.images.length) {
      imageDir = mkdtempSync(join(tmpdir(), 'atelier-codex-images-'));
      this.imageDirs.add(imageDir);
      input.images.forEach((image, at) => content.push(localCodexImage(image, imageDir!, at)));
    }
    this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
    try {
      if (this.turnId) {
        await this.call('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: content });
      } else {
        const result = await this.call('turn/start', {
          threadId: this.threadId, input: content, model: this.model ?? null, approvalPolicy: this.mode, effort: this.effort ?? null,
          ...(this.collaborationMode ? { collaborationMode: this.collaborationModePayload(this.collaborationMode) } : {}),
        });
        this.turnId = result.turn.id;
      }
    } catch (error) {
      if (imageDir) this.dropImageDir(imageDir);
      throw error;
    }
  }

  async validate(input: PromptInput): Promise<void> {
    if (!this.threadId) throw new Error('Codex thread is not open');
    const offered = this.offered(input);
    if (offered?.invocation.name === 'permissions' && offered.invocation.argument
      && !MODES.includes(offered.invocation.argument)) {
      throw new Error(`Codex does not support approval policy "${offered.invocation.argument}"`);
    }
  }

  /** One resolution path shared by pre-persistence validation and dispatch. */
  private offered(input: PromptInput) {
    // `skills/changed` may refresh executable paths before the next menu event.
    // Resolve both stores once so validation and dispatch cannot disagree.
    const commands = [...this.commands];
    for (const name of this.skills.keys()) {
      if (!commands.some((command) => command.name === name)) {
        commands.push({ name, description: '', kind: 'skill', execution: 'skill' });
      }
    }
    return offeredSlashCommand(input.text, commands);
  }

  answer(askId: string, choice: PermissionAnswer, value?: string): void {
    const ask = this.asks.get(askId);
    if (!ask) return;
    this.asks.delete(askId);
    ask.answer(choice, value);
    this.emit({ type: 'ask.resolved', askId, chosen: choice });
  }

  answerQuestions(requestId: string, response: QuestionResponse): void {
    const pending = this.questions.get(requestId);
    if (!pending) throw new Error('This Codex question is no longer awaiting an answer');
    const byId = new Map(response.answers.map((answer) => [answer.questionId, answer]));
    const answers: Bag = {};
    for (const question of pending.questions) {
      const answer = byId.get(String(question.id));
      if (!answer) throw new Error(`No answer was supplied for Codex question "${String(question.id)}"`);
      const options = new Map((question.options ?? []).map((option: Bag, index: number) => [
        `${String(question.id)}:option:${index}`, String(option.label),
      ]));
      const values = answer.optionIds.map((id) => options.get(id) ?? id);
      if (answer.customText?.trim()) values.push(answer.customText.trim());
      if (answer.note?.trim()) values.push(`Additional note: ${answer.note.trim()}`);
      answers[question.id] = { answers: values };
    }
    this.write({ jsonrpc: '2.0', id: pending.messageId, result: { answers } });
    this.questions.delete(requestId);
    this.emit({ type: 'question.resolved', requestId, answers: response.answers });
    this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
  }

  async setMode(mode: string): Promise<void> {
    if (!MODES.includes(mode)) throw new Error(`Codex does not support approval policy "${mode}"`);
    this.mode = mode;
    this.emit({ type: 'session.pinned', permissionMode: mode, model: null });
  }

  async setModel(model: string): Promise<void> {
    this.model = model === 'default' ? undefined : model;
    this.emit({ type: 'session.pinned', permissionMode: null, model: this.model ?? model });
    // The levels belong to the model, so they are asked for again for the one
    // just chosen rather than left as the last model's (bw-uxzk.2).
    await this.menu();
  }

  async setEffort(effort: string): Promise<void> {
    this.effort = effort;
    this.emit({ type: 'session.pinned', permissionMode: null, model: null, effort });
  }

  async setCollaborationMode(mode: string): Promise<void> {
    if (!this.collaborationPresets.has(mode)) throw new Error(`Codex does not support collaboration mode "${mode}"`);
    this.collaborationMode = mode;
    if (this.threadId) {
      await this.call('thread/settings/update', {
        threadId: this.threadId,
        collaborationMode: this.collaborationModePayload(mode),
      });
    }
    this.emit({ type: 'session.pinned', permissionMode: null, model: null, collaborationMode: mode });
  }

  private collaborationModePayload(mode: string): Bag {
    const preset = this.collaborationPresets.get(mode) ?? { mode };
    return {
      mode,
      settings: {
        model: preset.model ?? this.model ?? 'default',
        reasoning_effort: preset.reasoning_effort ?? this.effort ?? null,
        developer_instructions: null,
      },
    };
  }

  async interrupt(): Promise<void> {
    this.resolveAsks('deny');
    this.questions.clear();
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
    this.resolveAsks('deny');
    this.questions.clear();
    this.child?.kill('SIGTERM');
    this.child = null;
    for (const pending of this.pending.values()) pending.reject(new Error('Codex app-server closed'));
    this.pending.clear();
    this.dropImageDirs();
  }

  private resolveAsks(choice: PermissionAnswer): void {
    for (const [askId, ask] of this.asks) {
      ask.answer(choice);
      this.emit({ type: 'ask.resolved', askId, chosen: choice });
    }
    this.asks.clear();
  }

  private async menu(): Promise<void> {
    const menu = await codexMenu(this.cwd, this.model);
    this.collaborationPresets = new Map((menu.collaborationPresets ?? []).map((preset: Bag) => [preset.mode, preset]));
    if (this.collaborationPresets.size > 0 && (!this.collaborationMode || !this.collaborationPresets.has(this.collaborationMode))) {
      this.collaborationMode = this.collaborationPresets.has('default') ? 'default' : menu.collaborationModes[0]!.value;
      this.emit({ type: 'session.pinned', permissionMode: null, model: null, collaborationMode: this.collaborationMode });
    } else if (this.collaborationPresets.size === 0) {
      // Older app-servers reject collaborationMode/list. Keep their turns on
      // the old request shape even if this chat was last opened by a newer one.
      this.collaborationMode = null;
    }
    this.skills = new Map(Object.entries(menu.skillPaths ?? {}));
    const resolvedEffort = codexEffortForModel(this.effort, (menu.efforts ?? []) as Bag[], menu.defaultEffort);
    if (resolvedEffort !== this.effort) {
      this.effort = resolvedEffort;
      this.emit({ type: 'session.pinned', permissionMode: null, model: null, effort: this.effort });
    }
    const { skillPaths: _skillPaths, defaultEffort: _defaultEffort, collaborationPresets: _collaborationPresets, ...shown } = menu;
    this.commands = shown.commands;
    this.emit({ type: 'session.menu', ...shown } as DriverEvent);
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
    if (name === 'model') {
      if (argument) await this.setModel(argument);
      this.note(name, argument ? `Model changed to ${argument}.` : 'Use the model picker below the composer, or type /model followed by a model name.', 'note');
      return;
    }
    if (name === 'permissions') {
      if (argument) await this.setMode(argument);
      this.note(name, argument ? `Permission mode changed to ${argument}.` : 'Use the permission picker below the composer, or type /permissions followed by a mode.', 'note');
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
    const requestId = String(message.id);
    this.questions.set(requestId, { messageId: message.id, questions });
    this.emit({
      type: 'question.requested', requestId,
      blocking: message.params?.isBlocking !== false,
      questions: questions.map((question) => ({
        id: String(question.id), header: String(question.header || 'Question'), prompt: String(question.question || ''),
        selection: question.options == null ? 'text' as const : 'single' as const,
        options: (question.options ?? []).map((option: Bag, index: number) => ({
          id: `${String(question.id)}:option:${index}`,
          label: String(option.label),
          ...(typeof option.description === 'string' && option.description ? { description: option.description } : {}),
        })),
        allowCustom: question.options == null || question.isOther === true,
        secret: question.isSecret === true,
      })),
    });
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
      const changedThread = p.threadId ?? p.thread?.id;
      if (changedThread && changedThread !== this.threadId) {
        if (['active', 'idle', 'systemError'].includes(String(status.type))) this.agentAdapter.accept({
          type: 'thread/status/changed',
          threadId: changedThread,
          status: { type: status.type },
          result: this.childResults.get(changedThread) ?? null,
        } as CodexAgentSignal);
        return;
      }
      const waiting = status.activeFlags?.includes('waitingOnApproval') || status.activeFlags?.includes('waitingOnUserInput');
      const state = status.type === 'active' ? (waiting ? 'waiting_permission' : 'thinking') : status.type === 'systemError' ? 'errored' : 'idle';
      this.emit({ type: 'session.state', state, label: waiting ? 'Waiting for you' : status.type === 'active' ? 'Working' : status.type === 'systemError' ? 'Failed' : 'Ready' });
    } else if (method === 'skills/changed') {
      void this.menu();
    } else if (method === 'item/agentMessage/delta') {
      const actorAgentId = this.actorOf(p.threadId);
      const parentToolCallId = this.sentBy(p.threadId);
      this.openMessage(p.itemId, parentToolCallId, actorAgentId);
      this.emit({
        type: 'text.delta', messageId: p.itemId, text: p.delta,
        ...(this.execution(actorAgentId, p.itemId, parentToolCallId)
          ? { execution: this.execution(actorAgentId, p.itemId, parentToolCallId)! }
          : {}),
      });
    } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const parentToolCallId = this.sentBy(p.threadId);
      const actorAgentId = this.actorOf(p.threadId);
      this.emit({
        type: 'thinking.delta', messageId: p.itemId, text: p.delta,
        ...(parentToolCallId ? { parentToolCallId } : {}),
        ...(this.execution(actorAgentId, p.itemId, parentToolCallId)
          ? { execution: this.execution(actorAgentId, p.itemId, parentToolCallId)! }
          : {}),
      });
    } else if (method === 'turn/plan/updated') {
      this.emit({ type: 'todo', items: (p.plan ?? []).map((x: Bag, i: number) => ({ id: String(i), text: x.step, status: x.status })) });
    } else if (method === 'item/started') {
      this.itemStarted(p.item, this.sentBy(p.threadId), this.actorOf(p.threadId));
    } else if (method === 'item/completed') {
      if (p.threadId && p.threadId !== this.threadId && p.item?.type === 'agentMessage') {
        const result = String(p.item.text ?? '').trim();
        if (result) this.childResults.set(p.threadId, result);
      }
      this.itemCompleted(p.item, this.sentBy(p.threadId), false, this.actorOf(p.threadId));
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
      this.dropImageDirs();
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

  private sentBy(threadId: string | undefined): string | null {
    if (!threadId || threadId === this.threadId) return null;
    return this.agents.get(threadId)?.toolCallId ?? null;
  }

  private actorOf(threadId: string | undefined): string | null {
    if (!threadId || threadId === this.threadId) return null;
    return threadId;
  }

  private execution(
    actorAgentId: string | null,
    operationId: string | null,
    parentOperationId: string | null,
  ): ExecutionContext | null {
    if (!actorAgentId) return null;
    const actor = this.agents.get(actorAgentId);
    return {
      conversationId: actorAgentId,
      actorId: actorAgentId,
      actorName: actor?.agentType || actor?.what || null,
      parentActorId: actor?.execution?.parentActorId ?? null,
      operationId,
      parentOperationId,
    };
  }

  private openMessage(
    id: string,
    parentToolCallId: string | null = null,
    actorAgentId: string | null = null,
  ): void {
    if (this.messages.has(id)) return;
    this.messages.add(id);
    if (parentToolCallId) this.messageParents.set(id, parentToolCallId);
    this.emit({
      type: 'message.started', messageId: id, role: 'assistant',
      ...(parentToolCallId ? { parentToolCallId } : {}),
      ...(this.execution(actorAgentId, id, parentToolCallId)
        ? { execution: this.execution(actorAgentId, id, parentToolCallId)! }
        : {}),
    });
    if (!parentToolCallId) this.emit({ type: 'session.state', state: 'streaming', label: 'Answering' });
  }

  private dropImageDir(dir: string): void {
    rmSync(dir, { recursive: true, force: true });
    this.imageDirs.delete(dir);
  }

  private dropImageDirs(): void {
    for (const dir of [...this.imageDirs]) this.dropImageDir(dir);
  }

  itemStarted(
    item: Bag,
    parentToolCallId: string | null = null,
    actorAgentId: string | null = null,
  ): void {
    if (!item) return;
    if (item.type === 'agentMessage') return this.openMessage(item.id, parentToolCallId, actorAgentId);
    if (item.type === 'reasoning') {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].join('\n');
      if (text) this.emit({
        type: 'thinking.delta', messageId: item.id, text,
        ...(parentToolCallId ? { parentToolCallId } : {}),
        ...(this.execution(actorAgentId, item.id, parentToolCallId)
          ? { execution: this.execution(actorAgentId, item.id, parentToolCallId)! }
          : {}),
      });
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
      this.agentAdapter.accept({ type: 'item/subAgentActivity', item, actorAgentId } as CodexAgentSignal);
      if (item.kind === 'started') {
        this.collabTool({
          id: item.id,
          type: 'collabAgentToolCall',
          tool: 'spawnAgent',
          prompt: '',
          model: null,
          receiverThreadIds: [item.agentThreadId],
          agentsStates: { [item.agentThreadId]: { status: 'running', message: null } },
        }, true, actorAgentId);
      }
      return;
    }
    if (item.type === 'collabAgentToolCall') {
      this.agentAdapter.accept({ type: 'item/collabAgentToolCall', item, completed: false, actorAgentId } as CodexAgentSignal);
      this.collabTool(item as unknown as CodexCollabAgentToolCall, false, actorAgentId);
      return;
    }
    const action = (item.commandActions ?? [])[0] ?? {};
    const commandName = action.type === 'read' ? 'Read' : action.type === 'listFiles' ? 'Glob' : action.type === 'search' ? 'Grep' : 'Bash';
    const names: Bag = {
      commandExecution: commandName, fileChange: 'Edit', mcpToolCall: `${item.server}/${item.tool}`,
      dynamicToolCall: item.tool, webSearch: 'Web search', imageView: 'View image', sleep: 'Wait', imageGeneration: 'Generate image',
    };
    const name = names[item.type];
    if (!name) {
      if (!['contextCompaction', 'enteredReviewMode', 'exitedReviewMode'].includes(item.type)) this.note(`item/${item.type}`, JSON.stringify(item), 'detail');
      return;
    }
    this.tools.set(item.id, name);
    const input = item.arguments ?? {
      command: item.command, changes: item.changes, query: action.query ?? item.query,
      pattern: action.query, path: action.path ?? item.path, file_path: action.path,
      durationMs: item.durationMs,
    };
    if (item.type === 'mcpToolCall') {
      input.readOnlyHint = item.readOnlyHint ?? item.read_only_hint ?? input.readOnlyHint;
      input.destructiveHint = item.destructiveHint ?? item.destructive_hint ?? input.destructiveHint;
    }
    this.emit({
      type: 'tool.started', toolCallId: item.id, name,
      input,
      title: toolTitle(name, input), parentToolCallId,
      ...(this.execution(actorAgentId, item.id, parentToolCallId)
        ? { execution: this.execution(actorAgentId, item.id, parentToolCallId)! }
        : {}),
    });
    this.emit({ type: 'session.state', state: 'running_tool', label: name });
    if (item.type === 'fileChange') {
      for (const change of item.changes ?? []) this.emit({ type: 'diff', toolCallId: item.id, path: change.path, ...patchSides(change.diff ?? '') });
    }
  }

  /**
   * A persisted Codex rollout has no "completed" sub-agent activity. Its
   * world-state snapshot is the authoritative active set: an omitted helper,
   * or `null` when the last one leaves, is the terminal signal.
   */
  reconcileRolloutAgents(list: string | null): void {
    const active = new Set((list ?? '').split('\n').map((line) =>
      /^\s*-\s*([^:]+)(?::|$)/.exec(line)?.[1]?.trim(),
    ).filter((name): name is string => Boolean(name)));
    for (const known of this.agents.active()) {
      const agentId = known.agentId;
      if (list !== null && known.agentType && active.has(known.agentType)) continue;
      this.agents.finish(agentId, { state: 'done', result: null });
    }
  }

  itemCompleted(
    item: Bag,
    parentToolCallId: string | null = null,
    replayed = false,
    actorAgentId: string | null = null,
  ): void {
    if (!item) return;
    if (item.type === 'plan') {
      const markdown = String(item.text ?? '').trim();
      if (!markdown) return;
      this.proposePlan(`${item.id}:plan:0`, markdown);
      return;
    }
    if (item.type === 'agentMessage') {
      if (this.completedMessages.has(item.id)) return;
      const opened = this.messages.has(item.id);
      if (!opened && !String(item.text ?? '').trim()) return;
      const parent = parentToolCallId ?? this.messageParents.get(item.id) ?? null;
      const execution = this.execution(actorAgentId, item.id, parent);
      this.openMessage(item.id, parent, actorAgentId);
      if (!opened && item.text) this.emit({
        type: 'text.delta', messageId: item.id, text: item.text,
        ...(execution ? { execution } : {}),
      });
      this.emit({ type: 'message.completed', messageId: item.id, ...(execution ? { execution } : {}) });
      for (const comparison of materializeComparisons(String(item.text ?? ''), this.cwd)) {
        this.emit({ type: 'image.compare', messageId: item.id, comparison });
      }
      for (const widget of widgetSpecs(String(item.text ?? ''))) this.emit({ type: 'widget', messageId: item.id, widget });
      proposedPlanSpecs(String(item.text ?? '')).forEach((plan, index) => {
        this.proposePlan(`${item.id}:plan:${index}`, plan.markdown);
      });
      this.completedMessages.add(item.id);
      return;
    }
    if (['reasoning', 'plan', 'hookPrompt', 'subAgentActivity', 'contextCompaction', 'enteredReviewMode', 'exitedReviewMode'].includes(item.type)) return;
    if (item.type === 'collabAgentToolCall') {
      this.agentAdapter.accept({ type: 'item/collabAgentToolCall', item, completed: true, actorAgentId } as CodexAgentSignal);
      const collab = item as unknown as CodexCollabAgentToolCall;
      this.collabTool(collab, true, actorAgentId);
      if (replayed && collab.tool === 'spawnAgent') {
        for (const [agentId, native] of Object.entries(collab.agentsStates ?? {})) {
          if (!['completed', 'errored', 'interrupted', 'shutdown', 'notFound'].includes(native.status)) continue;
          const state = native.status === 'completed' ? 'done'
            : native.status === 'interrupted' || native.status === 'shutdown' ? 'stopped' : 'failed';
          this.agents.finish(agentId, { state, result: native.message ?? null });
        }
      }
      return;
    }
    if (!this.tools.has(item.id)) return;
    const ok = !['failed', 'declined'].includes(item.status) && (item.exitCode === null || item.exitCode === undefined || item.exitCode === 0);
    const execution = this.execution(actorAgentId, item.id, parentToolCallId);
    this.emit({
      type: 'tool.completed', toolCallId: item.id, ok,
      output: outputOf(item) || this.toolOutput.get(item.id) || '',
      ...(execution ? { execution } : {}),
    });
    if (ok) emitToolImage(this, item);
    this.tools.delete(item.id);
    this.toolOutput.delete(item.id);
  }

  private proposePlan(proposalId: string, markdown: string): void {
    if (this.plans.has(proposalId)) return;
    this.plans.add(proposalId);
    this.emit({
      type: 'plan.proposed', proposalId, markdown, actions: [
        {
          id: 'implement', kind: 'implement', label: 'Implement plan',
          description: 'Leave Plan mode and ask Codex to implement this plan.',
        },
        {
          id: 'request_changes', kind: 'request_changes', label: 'Request changes', acceptsFeedback: true,
          description: 'Keep planning and tell Codex what should change.',
        },
      ],
    });
  }

  async respondToPlan(proposalId: string, response: PlanResponse): Promise<void> {
    if (!this.plans.has(proposalId)) throw new Error('This Codex plan is no longer awaiting a response');
    if (response.actionId === 'implement') {
      if (this.collaborationPresets.has('default') && this.collaborationMode !== 'default') {
        await this.setCollaborationMode('default');
      }
      await this.send({ text: 'Implement the approved proposed plan.', images: [] });
      this.plans.delete(proposalId);
      this.emit({ type: 'plan.resolved', proposalId, status: 'approved', actionId: response.actionId });
      return;
    }
    if (response.actionId === 'request_changes') {
      const feedback = response.feedback?.trim();
      if (!feedback) throw new Error('Plan feedback is required');
      await this.send({ text: `Revise the proposed plan with this feedback:\n\n${feedback}`, images: [] });
      this.plans.delete(proposalId);
      this.emit({ type: 'plan.resolved', proposalId, status: 'changes_requested', actionId: response.actionId, feedback });
      return;
    }
    throw new Error(`Unknown Codex plan action "${response.actionId}"`);
  }

  private collabTool(
    item: CodexCollabAgentToolCall,
    completed: boolean,
    actorAgentId: string | null = null,
  ): void {
    if (this.completedCollabTools.has(item.id)) return;
    const names: Record<CodexCollabAgentToolCall['tool'], string> = {
      spawnAgent: 'spawn_agent', sendInput: 'send_message', resumeAgent: 'resume_agent',
      wait: 'wait_agent', closeAgent: 'close_agent',
    };
    const name = names[item.tool];
    const nativeIds = item.receiverThreadIds?.length
      ? item.receiverThreadIds
      : Object.keys(item.agentsStates ?? {}).length
        ? Object.keys(item.agentsStates ?? {})
        : item.tool === 'wait'
          ? this.agents.active().map((row) => row.agentId)
          : [];
    const target = nativeIds.map((agentId) => {
      const row = this.agents.get(agentId);
      return row?.agentType || `helper ${agentId.slice(0, 8)}`;
    }).join(', ');
    const spawnedAs = nativeIds.map((agentId) =>
      this.agents.get(agentId)?.agentType || `helper ${agentId.slice(0, 8)}`,
    ).join(', ');
    const input = item.tool === 'spawnAgent'
      ? { task_name: spawnedAs || 'helper', prompt: item.prompt ?? '' }
      : { target: target || 'a helper' };
    if (!this.tools.has(item.id)) {
      this.tools.set(item.id, name);
      const parentOperationId = actorAgentId ? this.agents.get(actorAgentId)?.toolCallId ?? null : null;
      const execution = this.execution(actorAgentId, item.id, parentOperationId);
      this.emit({
        type: 'tool.started', toolCallId: item.id, name, input,
        title: toolTitle(name, input), parentToolCallId: parentOperationId,
        ...(execution ? { execution } : {}),
      });
    }
    if (!completed) return;
    const states = Object.entries(item.agentsStates ?? {}).map(([agentId, state]) =>
      `${this.agents.get(agentId)?.agentType || this.agents.get(agentId)?.what || agentId}: ${state.status}`,
    ).join('\n');
    const nativeStates = Object.values(item.agentsStates ?? {}).map((state) => state.status);
    const completionTitle = item.tool === 'wait' && nativeStates.length > 0
      ? nativeStates.every((state) => state === 'completed')
        ? `${target || 'helper'} finished`
        : nativeStates.some((state) => state === 'errored' || state === 'notFound')
          ? `${target || 'helper'} failed`
          : nativeStates.some((state) => state === 'interrupted' || state === 'shutdown')
            ? `${target || 'helper'} stopped`
            : toolTitle(name, input)
      : undefined;
    const parentOperationId = actorAgentId ? this.agents.get(actorAgentId)?.toolCallId ?? null : null;
    const execution = this.execution(actorAgentId, item.id, parentOperationId);
    this.emit({
      type: 'tool.completed', toolCallId: item.id, ok: true, output: states,
      ...(completionTitle ? { title: completionTitle } : {}),
      ...(execution ? { execution } : {}),
    });
    this.tools.delete(item.id);
    this.completedCollabTools.add(item.id);
  }

  private async agentUsage(agentId: string): Promise<number> {
    const usage = await this.call('account/usage/read', { threadId: agentId });
    return (usage.threadUsage?.groups ?? []).reduce(
      (sum: number, group: Bag) => sum + Number(group.totalTokens ?? 0),
      0,
    );
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
