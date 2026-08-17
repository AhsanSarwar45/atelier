/**
 * Claude Code driver — the Agent SDK translated into WBP.
 *
 * The SDK, not the raw stream-json wire, because the permission answer path
 * (`canUseTool`, with allow / allow-always / deny) exists only here. Driving
 * the wire directly would mean inventing its control frames.
 * See docs/agent-workbench.md §1.1 and §3.1.
 *
 * Sign-in is whatever the owner already did in the terminal: no API key is
 * ever set or read here, and `--bare` (which forces API-key auth) is never used.
 */
import { query, type PermissionResult, type PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';

import type { CommandInfo, ImagePayload, ModelChoice, TodoItem } from '../../../src/workbench/protocol.ts';
import { CLAUDE_PERMISSION_MODES } from '../../../src/workbench/protocol.ts';
import type { Driver, DriverEvent, PermissionAnswer, PromptInput, StartOptions } from './types.ts';

/**
 * This build has no `TodoWrite`. Its checklist is the TaskCreate/TaskGet/
 * TaskUpdate/TaskList family, which carries the same
 * pending | in_progress | completed vocabulary and hands back the task id in
 * TaskCreate's result. `TodoWrite` is still read where an install has it.
 */
const CHECKLIST_CREATE = 'TaskCreate';
const CHECKLIST_UPDATE = 'TaskUpdate';
const CHECKLIST_WRITE_ALL = 'TodoWrite';

/** The only picture formats the API accepts as an image block. */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type ImageMediaType = (typeof IMAGE_TYPES)[number];

function mediaType(mime: string): ImageMediaType {
  const found = IMAGE_TYPES.find((t) => t === mime);
  if (!found) throw new Error(`${mime} cannot be sent as a picture; use ${IMAGE_TYPES.join(', ')}`);
  return found;
}

/** A permission card the human has not answered yet. */
interface PendingAsk {
  resolve: (r: PermissionResult) => void;
  /** The SDK's own "so you are not asked again" payload, handed back for allow-always. */
  suggestions: PermissionUpdate[] | undefined;
  input: Record<string, unknown>;
}

/** One line naming what a tool call is about to do, for the feed and the card. */
function toolTitle(name: string, input: Record<string, unknown>): string {
  const p = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
  if (p) return `${name} ${p.split('/').slice(-2).join('/')}`;
  const cmd = input.command as string | undefined;
  if (cmd) return `${name} ${cmd.slice(0, 60)}`;
  const pattern = (input.pattern ?? input.query) as string | undefined;
  if (pattern) return `${name} ${pattern.slice(0, 60)}`;
  return name;
}

export class ClaudeDriver implements Driver {
  private emit!: (e: DriverEvent) => void;
  private q: ReturnType<typeof query> | null = null;
  /** Turns queued by the browser, handed to the SDK as an async iterable. */
  private inbox: PromptInput[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private asks = new Map<string, PendingAsk>();
  /** Tools whose result we are still waiting for, so a completion can name them. */
  private liveTools = new Map<string, string>();
  /** The assistant message currently being streamed. */
  private streamingMessageId = '';
  /** The agent's checklist, in the order the items were created. */
  private todos: TodoItem[] = [];
  /** The skills this install has, kept so a pushed command list can be re-sent with them. */
  private skills: string[] = [];
  /**
   * The models and the terminal-only names from the last full menu.
   *
   * A mid-session push carries commands and nothing else, and the browser
   * replaces the whole menu with what it is sent — so re-sending it without
   * these took the model picker away for the rest of the chat and offered the
   * commands a browser must hide (bw-f1q.13).
   */
  private models: ModelChoice[] = [];
  private terminalOnly = new Set<string>();
  /**
   * True from the moment a turn is handed over until the brand says it is done.
   *
   * A session does not announce itself until the first turn is sent to it
   * (measured 2026-08-17), so `init` — which means "ready" — routinely arrives
   * while that first turn is already running. Saying Ready then puts the whole
   * screen back to rest over a working agent (bw-f1q).
   */
  private awaitingAnswer = false;
  /** When the last thinking-progress line was sent, so a long think is not a flood. */
  private lastThinkingAt = 0;
  /** TaskCreate calls awaiting the result that carries the task's id. */
  private pendingTodo = new Map<string, { text: string }>();

  /** One transcript bubble per text block of one message. */
  private blockId(index: number): string {
    return `${this.streamingMessageId}:${index}`;
  }

  /** Folds one checklist tool call into `todos` and republishes the whole list. */
  private applyChecklistCall(toolCallId: string, name: string, input: Record<string, unknown>): void {
    if (name === CHECKLIST_CREATE) {
      this.pendingTodo.set(toolCallId, { text: String(input.subject ?? input.description ?? '') });
      return;
    }
    if (name === CHECKLIST_UPDATE) {
      const id = String(input.taskId ?? '');
      const item = this.todos.find((t) => t.id === id);
      if (!item) return;
      if (typeof input.subject === 'string') item.text = input.subject;
      const status = input.status as TodoItem['status'] | 'deleted' | undefined;
      if (status === 'deleted') this.todos = this.todos.filter((t) => t.id !== id);
      else if (status) item.status = status;
      this.emit({ type: 'todo', items: this.todos.map((t) => ({ ...t })) });
      return;
    }
    if (name === CHECKLIST_WRITE_ALL && Array.isArray(input.todos)) {
      this.todos = (input.todos as { content: string; status: TodoItem['status'] }[]).map((t, i) => ({
        id: `todo-${i}`,
        text: t.content,
        status: t.status,
      }));
      this.emit({ type: 'todo', items: this.todos.map((t) => ({ ...t })) });
    }
  }

  /**
   * TaskCreate hands the new task's id back in its result, not its input.
   *
   * Two result shapes, because the SDK's declared TaskCreateOutput
   * (`{task:{id,subject}}`) is not what arrives: measured, this build returns
   * the sentence `Task #1 created successfully: <subject>`, and the number is
   * the id TaskUpdate then refers to.
   */
  private absorbChecklistResult(toolCallId: string, output: string): void {
    const pending = this.pendingTodo.get(toolCallId);
    if (!pending) return;
    this.pendingTodo.delete(toolCallId);

    let id = '';
    let text = pending.text;
    try {
      const parsed = JSON.parse(output) as { task?: { id?: string; subject?: string } };
      id = parsed.task?.id ?? '';
      if (parsed.task?.subject) text = parsed.task.subject;
    } catch {
      const m = /task\s*#\s*(\w+)/i.exec(output);
      id = m?.[1] ?? '';
    }
    if (!id) return;

    this.todos.push({ id, text, status: 'pending' });
    this.emit({ type: 'todo', items: this.todos.map((t) => ({ ...t })) });
  }

  /** The before/after a change-viewer needs, taken from the tool's own arguments. */
  private emitDiff(toolCallId: string, name: string, input: Record<string, unknown>): void {
    const path = String(input.file_path ?? '');
    if (!path) return;
    if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      this.emit({ type: 'diff', toolCallId, path, before: input.old_string, after: input.new_string });
    } else if (name === 'Write' && typeof input.content === 'string') {
      this.emit({ type: 'diff', toolCallId, path, before: '', after: input.content });
    }
  }

  async start(opts: StartOptions): Promise<void> {
    this.emit = opts.emit;

    const self = this;
    async function* prompts() {
      while (!self.closed) {
        const next = self.inbox.shift();
        if (next === undefined) {
          await new Promise<void>((r) => (self.wake = r));
          continue;
        }
        // Pictures ride as base64 image blocks; a bare string is the text-only
        // shape the API also accepts.
        const content = next.images.length
          ? [
              ...next.images.map((img) => ({
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: mediaType(img.mime),
                  data: img.dataUrl.replace(/^data:[^,]*,/, ''),
                },
              })),
              { type: 'text' as const, text: next.text },
            ]
          : next.text;

        yield {
          type: 'user' as const,
          session_id: '',
          parent_tool_use_id: null,
          message: { role: 'user' as const, content },
        };
      }
    }

    this.q = query({
      prompt: prompts(),
      options: {
        cwd: opts.cwd,
        model: opts.model,
        // Resuming by id works from any directory, for sessions started
        // anywhere — including ones the owner began in a terminal.
        resume: opts.resume,
        // Keep the id: a fork would strand the transcript we already show.
        forkSession: false,
        // Pinned explicitly every time: the CLI's defaults shift, and plan /
        // bypass are not restored on resume. 'default' is the mode that asks
        // about every tool — measured, see protocol.ts.
        permissionMode: opts.permissionMode as never,
        // Word-by-word text. Without this only whole messages arrive.
        includePartialMessages: true,
        // Decision 6: nothing attaches unless the owner asks for it.
        strictMcpConfig: true,
        // His own machine's commands, skills and settings — the same ones his
        // terminal has. This reverses the first build's `settingSources: []`,
        // which bought a session nothing could surprise and cost him every
        // command and every skill: there was literally nothing for a menu to
        // list (bw-f1q, docs/agent-workbench.md §3.1).
        //
        // Deliberately NOT `skills: 'all'`: measured 2026-08-17, that option
        // makes the kit pass `--allowedTools Skill`, which leaves the agent the
        // Skill tool and nothing else — a turn then ends silently without an
        // answer. Omitting it is not "skills off": the CLI's own defaults still
        // apply, and with the settings above his skills are loaded and listed
        // (77 of them on this machine).
        settingSources: ['user', 'project', 'local'],
        canUseTool: (toolName: string, input: Record<string, unknown>, o: { suggestions?: PermissionUpdate[] }) =>
          this.onPermissionRequest(toolName, input, o),
      },
    });

    void this.pump();
    // Asked now, not when the session announces itself: measured 2026-08-17, a
    // session says nothing at all until the first turn is sent, while
    // supportedCommands/supportedModels answer in 0.7s on a silent one. Waiting
    // for `init` would leave a fresh chat with no menus until he had already
    // typed something (bw-f1q).
    void this.publishMenu(null);
  }

  /** The permission card, and the promise the SDK is blocked on until it is clicked. */
  private onPermissionRequest(
    toolName: string,
    input: Record<string, unknown>,
    o: { suggestions?: PermissionUpdate[] },
  ): Promise<PermissionResult> {
    const askId = randomUUID();
    return new Promise<PermissionResult>((resolve) => {
      this.asks.set(askId, { resolve, suggestions: o.suggestions, input });
      this.emit({
        type: 'ask.permission',
        askId,
        toolName,
        input,
        title: toolTitle(toolName, input),
        options: [
          { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
          { id: 'allow_always', label: 'Allow always', kind: 'allow_always' },
          { id: 'deny', label: 'Deny', kind: 'deny' },
        ],
      });
      this.emit({ type: 'session.state', state: 'waiting_permission', label: `Asking about ${toolName}` });
    });
  }

  /**
   * The menu this session can offer, as the session itself announced it.
   *
   * `system/init` already carries the command names, the skills and which
   * commands belong to a terminal; `supportedCommands()` adds the descriptions
   * and `supportedModels()` the models. Asked once, on the way in, so the
   * writing box has its menus before he opens one.
   */
  private async publishMenu(init: Record<string, any> | null): Promise<void> {
    const terminalOnly = new Set<string>(init?.terminal_slash_commands ?? []);
    if (init) this.skills = (init.skills ?? []) as string[];
    const named: string[] = (init?.slash_commands ?? []) as string[];

    let described: { name: string; description: string; argumentHint?: string }[] = [];
    let models: ModelChoice[] = [];
    try {
      const [commands, offered] = await Promise.all([
        this.q?.supportedCommands() ?? Promise.resolve([]),
        this.q?.supportedModels() ?? Promise.resolve([]),
      ]);
      described = commands as typeof described;
      models = (offered as { value: string; displayName: string; description?: string }[]).map((m) => ({
        value: m.value,
        displayName: m.displayName,
        description: m.description,
      }));
    } catch {
      // An older install answers neither; the names from init still make a menu.
    }

    // Remembered, because a later push carries neither of them.
    if (models.length) this.models = models;
    if (terminalOnly.size) this.terminalOnly = terminalOnly;
    this.emitMenu(described.length ? described : named.map((name) => ({ name, description: '' })));
  }

  /** Folds one list of commands into the menu event, skills and models included. */
  private emitMenu(commands: { name: string; description: string; argumentHint?: string }[]): void {
    const skills = new Set(this.skills);
    const items: CommandInfo[] = commands
      // A command whose whole point is the terminal it was typed in cannot work
      // from a browser, so it is not offered here (§7).
      .filter((c) => !this.terminalOnly.has(c.name))
      .map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
        kind: skills.has(c.name) ? ('skill' as const) : ('command' as const),
      }));
    // A skill the command list did not mention is still typeable.
    for (const skill of this.skills) {
      if (!items.some((i) => i.name === skill)) {
        items.push({ name: skill, description: '', kind: 'skill' });
      }
    }
    this.emit({
      type: 'session.menu',
      commands: items,
      skills: this.skills,
      models: this.models,
      permissionModes: [...CLAUDE_PERMISSION_MODES],
    });
  }

  async setMode(mode: string): Promise<void> {
    await this.q?.setPermissionMode(mode as never);
  }

  async setModel(model: string): Promise<void> {
    await this.q?.setModel(model);
  }

  answer(askId: string, choice: PermissionAnswer): void {
    const ask = this.asks.get(askId);
    if (!ask) return;
    this.asks.delete(askId);

    if (choice === 'deny') {
      ask.resolve({ behavior: 'deny', message: 'The owner denied this from the workbench.' });
    } else if (choice === 'allow_always') {
      // The SDK hands us the exact rule that stops it asking again; handing it
      // straight back is what "always" means. Never a rule of our own invention.
      ask.resolve({ behavior: 'allow', updatedInput: ask.input, updatedPermissions: ask.suggestions });
    } else {
      ask.resolve({ behavior: 'allow', updatedInput: ask.input });
    }

    this.emit({ type: 'ask.resolved', askId, chosen: choice });
    this.emit({ type: 'session.state', state: 'thinking', label: 'Working' });
  }

  async send(input: PromptInput): Promise<void> {
    this.inbox.push(input);
    this.wake?.();
    this.wake = null;
    this.awaitingAnswer = true;
    this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
  }

  async interrupt(): Promise<void> {
    // Any card still on screen must be released first, or interrupt deadlocks
    // behind a promise nobody will resolve.
    for (const [askId, ask] of this.asks) {
      ask.resolve({ behavior: 'deny', message: 'Stopped by the owner.', interrupt: true });
      this.emit({ type: 'ask.resolved', askId, chosen: 'deny' });
    }
    this.asks.clear();
    await this.q?.interrupt();
    this.awaitingAnswer = false;
    this.emit({ type: 'session.state', state: 'stopped', label: 'Stopped' });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wake?.();
    for (const ask of this.asks.values()) ask.resolve({ behavior: 'deny', message: 'Session closed.' });
    this.asks.clear();
    this.q?.close();
  }

  /** Reads the SDK's message stream and translates every message into WBP. */
  private async pump(): Promise<void> {
    if (!this.q) return;
    try {
      for await (const m of this.q as AsyncIterable<Record<string, any>>) {
        switch (m.type) {
          case 'system':
            if (m.subtype === 'init') {
              this.emit({
                type: 'session.started',
                brand: 'claude',
                externalId: m.session_id ?? null,
                model: m.model ?? null,
                cwd: m.cwd ?? '',
                permissionMode: m.permissionMode ?? '',
              });
              // Only when nothing is in flight: see `awaitingAnswer`.
              if (!this.awaitingAnswer) this.emit({ type: 'session.state', state: 'idle', label: 'Ready' });
              void this.publishMenu(m);
            } else if (m.subtype === 'commands_changed') {
              // Skills found as the agent moves around: the kit says to replace
              // the list, not to merge it.
              this.emitMenu(m.commands ?? []);
            } else if (m.subtype === 'thinking_tokens') {
              // Redacted thinking: the API sends pings and nothing else, so this
              // estimate is the only sign the agent is alive. Once every two
              // seconds — the log is the transcript, and a long think would
              // otherwise write hundreds of lines into it (§8.2.2).
              const now = Date.now();
              if (now - this.lastThinkingAt > 2000) {
                this.lastThinkingAt = now;
                this.emit({ type: 'thinking.progress', tokens: Number(m.estimated_tokens ?? 0) });
              }
            } else if (m.subtype === 'local_command_output') {
              // A local command answers by itself and the query loop is bypassed,
              // so no result message will close this turn — the chat is put back
              // to Ready here or it waits forever (docs/agent-workbench.md §7).
              const messageId = randomUUID();
              this.emit({ type: 'message.started', messageId, role: 'assistant' });
              this.emit({ type: 'text.delta', messageId, text: String(m.content ?? '') });
              this.emit({ type: 'message.completed', messageId });
              this.awaitingAnswer = false;
              this.emit({ type: 'session.state', state: 'idle', label: 'Ready' });
            }
            break;

          // How long the call has been running, counted by the kit rather than
          // by us, subagents included (docs/agent-workbench.md §8.2.2).
          case 'tool_progress':
            this.emit({
              type: 'tool.progress',
              toolCallId: String(m.tool_use_id ?? ''),
              seconds: Number(m.elapsed_time_seconds ?? 0),
            });
            break;

          case 'stream_event': {
            const ev = m.event;
            // Every stream_event carries its OWN uuid, so it cannot identify
            // the message being built. The Anthropic message id plus the block
            // index is the identity that stays put across a whole answer.
            if (ev?.type === 'message_start') {
              this.streamingMessageId = ev.message?.id ?? m.uuid;
            } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') {
              this.emit({ type: 'message.started', messageId: this.blockId(ev.index), role: 'assistant' });
              this.emit({ type: 'session.state', state: 'streaming', label: 'Answering' });
            } else if (ev?.type === 'content_block_start' && ev.content_block?.type === 'thinking') {
              // What it is working out, as it works it out. Without this the
              // screen has nothing to show for a long think (bw-f1q).
              this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
            } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              this.emit({ type: 'text.delta', messageId: this.blockId(ev.index), text: ev.delta.text });
            } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta') {
              // Withheld reasoning sends these frames with no words in them.
              // Drawing one anyway leaves a heading with nothing under it; the
              // size on the working line is that turn's sign of life instead
              // (bw-f1q.14).
              const thought = String(ev.delta.thinking ?? '');
              if (thought) this.emit({ type: 'thinking.delta', messageId: this.blockId(ev.index), text: thought });
            } else if (ev?.type === 'content_block_stop') {
              this.emit({ type: 'message.completed', messageId: this.blockId(ev.index) });
            }
            break;
          }

          case 'assistant':
            for (const b of m.message?.content ?? []) {
              if (b.type === 'tool_use') {
                const input = b.input ?? {};
                this.liveTools.set(b.id, b.name);
                this.emit({
                  type: 'tool.started',
                  toolCallId: b.id,
                  name: b.name,
                  input,
                  title: toolTitle(b.name, input),
                  // Subagent attribution rides on the MESSAGE, not the block.
                  parentToolCallId: m.parent_tool_use_id ?? null,
                });
                this.emitDiff(b.id, b.name, input);
                this.applyChecklistCall(b.id, b.name, input);
                this.emit({ type: 'session.state', state: 'running_tool', label: toolTitle(b.name, input) });
              }
            }
            break;

          case 'user':
            // Tool results come back on the user turn.
            for (const b of m.message?.content ?? []) {
              if (b.type === 'tool_result') {
                this.liveTools.delete(b.tool_use_id);
                const output =
                  typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
                this.absorbChecklistResult(b.tool_use_id, output);
                this.emit({
                  type: 'tool.completed',
                  toolCallId: b.tool_use_id,
                  ok: !b.is_error,
                  output: output.slice(0, 4000),
                });
              }
            }
            break;

          case 'result':
            this.awaitingAnswer = false;
            if (typeof m.total_cost_usd === 'number') {
              this.emit({ type: 'cost', cost: { kind: 'usd', usd: m.total_cost_usd } });
            }
            this.emit({
              type: 'session.state',
              state: m.subtype === 'success' ? 'idle' : 'errored',
              label: m.subtype === 'success' ? 'Ready' : String(m.subtype ?? 'error'),
            });
            break;
        }
      }
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err), fatal: true });
      this.emit({ type: 'session.state', state: 'errored', label: 'Failed' });
    }
  }
}
