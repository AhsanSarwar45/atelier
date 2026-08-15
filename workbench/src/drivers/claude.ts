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

import type { Driver, DriverEvent, PermissionAnswer, StartOptions } from './types.ts';

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
  private inbox: string[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private asks = new Map<string, PendingAsk>();
  /** Tools whose result we are still waiting for, so a completion can name them. */
  private liveTools = new Map<string, string>();
  /** The assistant message currently being streamed. */
  private streamingMessageId = '';

  /** One transcript bubble per text block of one message. */
  private blockId(index: number): string {
    return `${this.streamingMessageId}:${index}`;
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
        yield {
          type: 'user' as const,
          session_id: '',
          parent_tool_use_id: null,
          message: { role: 'user' as const, content: next },
        };
      }
    }

    this.q = query({
      prompt: prompts(),
      options: {
        cwd: opts.cwd,
        model: opts.model,
        // Pinned explicitly every time: the CLI's defaults shift, and plan /
        // bypass are not restored on resume. 'default' is the mode that asks
        // about every tool — measured, see protocol.ts.
        permissionMode: opts.permissionMode as never,
        // Word-by-word text. Without this only whole messages arrive.
        includePartialMessages: true,
        // Decision 6: nothing attaches unless the owner asks for it.
        strictMcpConfig: true,
        // The workbench composes its own session; it does not inherit the
        // owner's terminal settings, so what runs here is predictable.
        settingSources: [],
        canUseTool: (toolName: string, input: Record<string, unknown>, o: { suggestions?: PermissionUpdate[] }) =>
          this.onPermissionRequest(toolName, input, o),
      },
    });

    void this.pump();
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

  async send(text: string): Promise<void> {
    this.inbox.push(text);
    this.wake?.();
    this.wake = null;
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
              this.emit({ type: 'session.state', state: 'idle', label: 'Ready' });
            }
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
            } else if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              this.emit({ type: 'text.delta', messageId: this.blockId(ev.index), text: ev.delta.text });
            } else if (ev?.type === 'content_block_stop') {
              this.emit({ type: 'message.completed', messageId: this.blockId(ev.index) });
            }
            break;
          }

          case 'assistant':
            for (const b of m.message?.content ?? []) {
              if (b.type === 'tool_use') {
                this.liveTools.set(b.id, b.name);
                this.emit({
                  type: 'tool.started',
                  toolCallId: b.id,
                  name: b.name,
                  input: b.input ?? {},
                  title: toolTitle(b.name, b.input ?? {}),
                });
                this.emit({ type: 'session.state', state: 'running_tool', label: toolTitle(b.name, b.input ?? {}) });
              }
            }
            break;

          case 'user':
            // Tool results come back on the user turn.
            for (const b of m.message?.content ?? []) {
              if (b.type === 'tool_result') {
                this.liveTools.delete(b.tool_use_id);
                this.emit({
                  type: 'tool.completed',
                  toolCallId: b.tool_use_id,
                  ok: !b.is_error,
                  output: typeof b.content === 'string' ? b.content.slice(0, 4000) : JSON.stringify(b.content).slice(0, 4000),
                });
              }
            }
            break;

          case 'result':
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
