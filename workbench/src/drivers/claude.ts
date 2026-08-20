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

import type { AgentKind, AgentState, CommandInfo, ImagePayload, ModelChoice, NoteRank, TodoItem } from '../../../src/workbench/protocol.ts';
import { CLAUDE_PERMISSION_MODES } from '../../../src/workbench/protocol.ts';
import { cut, diffOf, KEPT, resultText, trimInput } from '../../../src/workbench/imported-history.ts';
import { fullness, WINDOW, windowNamed } from '../../../src/workbench/context-window.ts';
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

/** A line for the transcript, and the whole message behind it. */
interface Note {
  rank: NoteRank;
  kind: string;
  text: string;
  body?: string;
  /**
   * Drawn even when the same sentence just went past.
   *
   * For a line that reports a DECISION rather than echoes one of the kit's: the
   * same permission mode picked twice is two changes and reads as two, where
   * the kit saying one thing in two shapes is one thing (bw-1u1.32).
   */
  always?: boolean;
}

/** The kit's own ranking of an `informational`, which already names our treatment. */
const INFORMATIONAL_RANK: Record<string, NoteRank> = {
  // "'info' shows only in transcript mode; 'notice' renders in inactive gray"
  // — the kit's own words about these levels (sdk.d.ts, SDKInformationalMessage).
  info: 'detail',
  notice: 'note',
  suggestion: 'note',
  warning: 'note',
};

/** The fields a message the app has never seen might keep a human sentence in. */
const SPOKEN_FIELDS = ['content', 'text', 'message', 'error', 'summary', 'reason', 'result'];


/** The kit's name for one message, as the branches below spell it. */
function kindOf(m: Record<string, any>): string {
  return m.type === 'system' ? `system/${m.subtype}` : String(m.type ?? 'unknown');
}

/** One line, whatever it was given: a long value is cut and the whole of it kept in the body. */
function oneLine(value: unknown, limit = 200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * What a helper actually answered.
 *
 * The text a finished helper hands back is written for the model, not for a
 * reader: the kit appends the helper's own id and a sentence about how to send
 * it another message, and on a row about eighty characters wide that trailer is
 * most of what there is room for (measured 2026-08-20 — a helper that answered
 * DONE drew `DONE agentId: ac8d…3 (use SendMessage with to: …`).
 *
 * The structured output beside it carries the report on its own, so the answer
 * is read from there and the model-directed text is only the fallback for a
 * kit that did not send one.
 */
export function answerOf(result: unknown, output: string): string {
  const said = (result as { content?: { type?: string; text?: string }[] } | null | undefined)?.content;
  if (!Array.isArray(said)) return output;
  const words = said
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
    .trim();
  return words || output;
}

/**
 * Everything the machine says about itself, as one line and a body.
 *
 * Reached only from the last arm of `draw()`, so everything translated properly
 * has already been dealt with by the time this runs. Every OTHER message —
 * named below or not — comes back as a note, because a driver with a list of
 * kinds it is willing to hear is what silently lost the manager's `/compact`
 * answer (docs/agent-workbench.md §8.2.4).
 *
 * There used to be a table of the translated kinds here as well, checked on the
 * way in. Nothing outside this file read it, the check could never be true, and
 * its comment promised a cross-check that no longer existed — a safety net made
 * of a sentence (bw-1u1.34).
 */
/**
 * Which kind of sent-off work this is (docs/agent-workbench.md §8.2.7).
 *
 * The kit names its own kinds and is free to invent more, so this reads the
 * name rather than matching a closed list: anything it has no word for is a
 * helper, which is what most of them are and what the row then says.
 */
function kindOfTask(taskType: unknown, agentType: unknown): AgentKind {
  const said = `${String(taskType ?? '')} ${String(agentType ?? '')}`.toLowerCase();
  if (said.includes('workflow')) return 'run';
  if (said.includes('bash') || said.includes('command') || said.includes('shell')) return 'command';
  if (said.includes('watch') || said.includes('monitor')) return 'watch';
  return 'helper';
}

/** What the kit's own word for a task's state means on a row. */
const TASK_STATE: Record<string, AgentState> = {
  pending: 'running',
  running: 'running',
  paused: 'parked',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
  stopped: 'stopped',
};

function noteFor(m: Record<string, any>): Note | null {
  const note = noteBody(m);
  // A line cut at two hundred characters with nothing behind it is a line whose
  // rest is reachable nowhere: the row's own toggle is disabled when there is no
  // body, and §8.2.4 promises that the body of anything sits behind a click.
  // Held here rather than in each branch, so the next branch cannot forget
  // (bw-1u1.39).
  if (note && note.body === undefined && note.text.endsWith('…')) {
    note.body = oneLine(JSON.stringify(m), KEPT);
  }
  return note;
}

/** A moment as a clock reading, for a line a reader has to act on. */
function clockOf(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function noteBody(m: Record<string, any>): Note | null {
  const kind = kindOf(m);
  const whole = () => oneLine(JSON.stringify(m), KEPT);

  switch (kind) {
    // The answer to /compact, and the only place the reason lives.
    case 'system/status': {
      if (m.compact_result === 'failed') {
        return { rank: 'note', kind, text: `Could not compact: ${oneLine(m.compact_error ?? 'no reason given')}` };
      }
      if (m.compact_result === 'success') return { rank: 'note', kind, text: 'Compacted this chat.' };
      // 'requesting' on every single request, 'compacting' while it works: the
      // machine breathing, not something it is telling him.
      return { rank: 'detail', kind, text: `Status: ${oneLine(m.status ?? 'none')}`, body: String(m.status ?? '') };
    }

    case 'system/compact_boundary': {
      const meta = m.compact_metadata ?? {};
      const size = meta.post_tokens ? `${meta.pre_tokens} → ${meta.post_tokens} tokens` : `${meta.pre_tokens} tokens`;
      return { rank: 'note', kind, text: `Compacted (${meta.trigger ?? 'manual'}): ${size}` };
    }

    case 'system/informational':
      return {
        rank: INFORMATIONAL_RANK[String(m.level)] ?? 'note',
        kind,
        text: oneLine(m.content),
        body: String(m.content ?? ''),
      };

    case 'system/notification':
      return { rank: m.priority === 'low' ? 'detail' : 'note', kind, text: oneLine(m.text), body: String(m.text ?? '') };

    case 'system/api_retry':
      return {
        rank: 'note',
        kind,
        text: `Retrying (${m.attempt} of ${m.max_retries})${m.error_status ? ` after HTTP ${m.error_status}` : ''}`,
        body: whole(),
      };

    case 'system/permission_denied':
      return {
        rank: 'note',
        kind,
        text: `${m.tool_name} was not allowed: ${oneLine(m.decision_reason ?? m.message)}`,
        body: String(m.message ?? ''),
      };

    case 'system/model_refusal_no_fallback':
      return { rank: 'note', kind, text: oneLine(m.content), body: String(m.content ?? '') };

    case 'system/model_refusal_fallback':
      return { rank: 'note', kind, text: `${m.original_model} refused; ${m.direction} to ${m.fallback_model}` };

    // A hook that worked is the machine breathing; one that did not is his to
    // see. Neither keeps a body it has nothing to put in: a rule starting says
    // only which rule and which moment, and its line already says both. With
    // every hook event now asked for (§3.1), that body was two thirds of what
    // an install with hooks stored (bw-1u1.38, §8.2.5).
    case 'system/hook_started':
    case 'system/hook_progress':
      return { rank: 'detail', kind, text: `Hook ${m.hook_name} (${m.hook_event})` };

    case 'system/hook_response': {
      const ok = m.outcome === 'success';
      const trouble = oneLine(m.stderr || m.output || '');
      const said = [m.output, m.stdout, m.stderr].filter(Boolean).join('\n');
      return {
        rank: ok ? 'detail' : 'note',
        kind,
        text: ok ? `Hook ${m.hook_name} ran` : `Hook ${m.hook_name} ${m.outcome}${trouble ? `: ${trouble}` : ''}`,
        // What it printed, when it printed anything. A rule that succeeded in
        // silence has nothing behind its line, and says so by not opening.
        body: said || (ok ? undefined : whole()),
      };
    }

    case 'system/task_started':
      return { rank: 'detail', kind, text: `Sent off: ${oneLine(m.description)}`, body: String(m.description ?? '') };

    case 'system/task_notification':
      return { rank: 'note', kind, text: `${oneLine(m.summary)} (${m.status})`, body: whole() };

    case 'system/memory_recall':
      return {
        rank: 'detail',
        kind,
        text: `Recalled ${(m.memories ?? []).length} memories`,
        body: (m.memories ?? []).map((mem: { path: string }) => mem.path).join('\n'),
      };

    case 'system/worker_shutting_down':
      return { rank: 'note', kind, text: `Shutting down: ${oneLine(m.reason)}`, body: String(m.reason ?? '') };

    case 'system/plugin_install':
      return {
        rank: m.status === 'failed' ? 'note' : 'detail',
        kind,
        text: `Plugin ${m.name ?? ''} ${m.status}${m.error ? `: ${oneLine(m.error)}` : ''}`,
      };

    case 'system/mirror_error':
      return { rank: 'note', kind, text: `Could not mirror this chat: ${oneLine(m.error)}`, body: whole() };

    case 'tool_use_summary':
      return { rank: 'detail', kind, text: oneLine(m.summary), body: String(m.summary ?? '') };

    case 'auth_status':
      return {
        rank: m.error ? 'note' : 'detail',
        kind,
        text: m.error ? `Sign-in trouble: ${oneLine(m.error)}` : 'Checking sign-in',
        body: whole(),
      };

    case 'conversation_reset':
      return { rank: 'note', kind, text: 'This chat was started over.' };

    // What his allowance is doing. It arrived with no wording of its own, so
    // the row read `rate_limit_event` — the kind's name where the sentence
    // should be (bw-jkh2.19). It is news either way and not the machine's own
    // breathing: it is about HIM, and he asked to be told.
    case 'rate_limit_event': {
      const info = m.rate_limit_info ?? {};
      const window = String(info.rateLimitType ?? 'allowance').replace(/_/g, '-');
      const allowed = info.status === 'allowed';
      const resets = typeof info.resetsAt === 'number' ? ` until ${clockOf(info.resetsAt)}` : '';
      return {
        rank: 'note',
        kind,
        text: allowed
          ? `Allowance: the ${window} window is open${resets}`
          : `Allowance: the ${window} window is ${oneLine(info.status ?? 'closed')}${resets}`,
        body: whole(),
      };
    }

    default: {
      // A kind this build has never seen. If it carries a sentence it is drawn
      // like anything else that speaks; if it is only structure it waits behind
      // "show everything". Either way it is never nothing.
      const spoken = SPOKEN_FIELDS.map((f) => m[f]).find((v) => typeof v === 'string' && v.trim());
      return spoken
        ? { rank: 'note', kind, text: oneLine(spoken), body: String(spoken) }
        : { rank: 'detail', kind, text: kind, body: whole() };
    }
  }
}

/** One line naming what a tool call is about to do, for the feed and the card. */
export function toolTitle(name: string, input: Record<string, unknown>): string {
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
   * The window the conversation is measured against, which the kit states only
   * when it was asked for its own context report (bw-4wcd.15).
   */
  private window = WINDOW;
  /**
   * True from the moment a turn is handed over until the brand says it is done.
   *
   * A session does not announce itself until the first turn is sent to it
   * (measured 2026-08-17), so `init` — which means "ready" — routinely arrives
   * while that first turn is already running. Saying Ready then puts the whole
   * screen back to rest over a working agent (bw-f1q).
   */
  private awaitingAnswer = false;
  /**
   * Every piece of work this chat has sent away, by the kit's own task id
   * (docs/agent-workbench.md §8.2.7).
   *
   * Kept because the kit's later messages about a task each carry only part of
   * the picture — a status change carries no numbers, a result carries no
   * elapsed — and a row that blanked what it was not told again would flicker
   * every time one arrived.
   */
  private sentAway = new Map<
    string,
    { seconds: number; tokens: number; calls: number; model: string | null; state: AgentState }
  >();
  /** Which task a call sent off, so a helper's own words can find its row. */
  private taskOfCall = new Map<string, string>();
  /** When the last thinking-progress line was sent, so a long think is not a flood. */
  private lastThinkingAt = 0;
  /**
   * The permission mode this session is actually in, as far as anything here
   * knows: what it was pinned to, or the last change either side made.
   *
   * The tool changes it by itself — approving a plan ends plan mode — and that
   * left the picker claiming the old mode with nothing said, which is the trap
   * this job exists to close, on the one road the first fix did not cover. Every
   * `system/status` carries the mode in force, so this is what it is compared
   * against (bw-1u1.43).
   */
  private mode = '';
  /** TaskCreate calls awaiting the result that carries the task's id. */
  private pendingTodo = new Map<string, { text: string }>();
  /**
   * Messages whose words already arrived word-by-word.
   *
   * Text has only ever been read off the stream, so a message the kit writes
   * ITSELF — a compaction refusal, an abort notice — carried its words in
   * `message.content` and was drawn nowhere (bw-1u1). Anything not in here when
   * the whole message lands is drawn from its content instead.
   */
  private streamed = new Set<string>();
  /**
   * The last few lines put on the page, so the same sentence is not said twice.
   *
   * The kit reports one thing in two shapes — `/compact`'s refusal arrives as a
   * status carrying `compact_error` AND as a message it wrote itself with that
   * same sentence in it. Both are kept in the log; only the first is drawn.
   */
  private recentlySaid: string[] = [];

  /** True when a line just went past saying this already, either way round. */
  private saidAlready(text: string): boolean {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) return false;
    const twice = this.recentlySaid.some((seen) => seen.includes(flat) || flat.includes(seen));
    this.recentlySaid = [...this.recentlySaid, flat].slice(-4);
    return twice;
  }

  /** One transcript bubble per text block of one message. */
  private blockId(index: number): string {
    return `${this.streamingMessageId}:${index}`;
  }

  /** A line about the chat's own machinery, and the whole message behind it. */
  /**
   * Everything the kit says about work this chat handed to something else,
   * translated into the three lines the panel is drawn from
   * (docs/agent-workbench.md §8.2.7).
   *
   * Read before the rest of the `system` arm and never instead of it: the grey
   * lines those subtypes already draw are the record of what happened, and the
   * panel is a reading of it. One does not replace the other.
   *
   * Nothing here is a delta. The kit's messages each carry a different corner
   * of the picture — a status change with no numbers, a result with no elapsed
   * — so what it does not say this time is what it said last time, kept in
   * `sentAway` rather than blanked.
   */
  private sawTask(m: Record<string, any>): void {
    const numbers = (id: string) =>
      this.sentAway.get(id) ?? { seconds: 0, tokens: 0, calls: 0, model: null, state: 'running' as AgentState };

    switch (m.subtype) {
      case 'task_started': {
        const id = String(m.task_id ?? '');
        if (!id) return;
        const call = typeof m.tool_use_id === 'string' && m.tool_use_id ? m.tool_use_id : null;
        if (call) this.taskOfCall.set(call, id);
        if (!this.sentAway.has(id)) this.sentAway.set(id, numbers(id));
        this.emit({
          type: 'agent.started',
          agentId: id,
          toolCallId: call,
          kind: kindOfTask(m.task_type, m.subagent_type),
          what: oneLine(m.description ?? m.workflow_name ?? m.prompt ?? ''),
          agentType: typeof m.subagent_type === 'string' ? m.subagent_type : null,
          // The kit names no model here. It arrives with the helper's first
          // words, or with its result — both fill this row in later.
          model: null,
        });
        return;
      }

      case 'task_progress': {
        const id = String(m.task_id ?? '');
        if (!id) return;
        const was = numbers(id);
        const now = {
          ...was,
          seconds: Math.round(Number(m.usage?.duration_ms ?? 0) / 1000) || was.seconds,
          tokens: Number(m.usage?.total_tokens ?? 0) || was.tokens,
          calls: Number(m.usage?.tool_uses ?? 0) || was.calls,
        };
        this.sentAway.set(id, now);
        const doing = oneLine(m.summary ?? m.last_tool_name ?? m.description ?? '');
        this.emit({
          type: 'agent.progress',
          agentId: id,
          seconds: now.seconds,
          tokens: now.tokens,
          calls: now.calls,
          ...(doing ? { doing } : {}),
          ...(now.model ? { model: now.model } : {}),
        });
        return;
      }

      case 'task_updated': {
        // A status change and nothing else: the numbers on the row are the ones
        // it already had, which is why they are kept here at all.
        const id = String(m.task_id ?? '');
        const patch = (m.patch ?? {}) as { status?: string; is_backgrounded?: boolean };
        if (!id || (!patch.status && patch.is_backgrounded === undefined)) return;
        const was = numbers(id);
        // Parked beats the status it is still running under: a helper left to
        // run in the background is exactly a running one nobody is waiting at.
        const state: AgentState = patch.is_backgrounded
          ? 'parked'
          : (patch.status && TASK_STATE[patch.status]) || was.state;
        this.sentAway.set(id, { ...was, state });
        this.emit({
          type: 'agent.progress',
          agentId: id,
          seconds: was.seconds,
          tokens: was.tokens,
          calls: was.calls,
          state,
        });
        return;
      }

      case 'task_notification': {
        const id = String(m.task_id ?? '');
        if (!id) return;
        const was = numbers(id);
        const state = TASK_STATE[String(m.status ?? '')] ?? 'done';
        this.emit({
          type: 'agent.finished',
          agentId: id,
          state: state === 'failed' ? 'failed' : state === 'stopped' ? 'stopped' : 'done',
          seconds: Math.round(Number(m.usage?.duration_ms ?? 0) / 1000) || was.seconds,
          tokens: Number(m.usage?.total_tokens ?? 0) || was.tokens,
          calls: Number(m.usage?.tool_uses ?? 0) || was.calls,
          model: was.model,
          // Its last word, kept on the row. A finished row that throws the
          // answer away is a row the reader has to go looking for it.
          result: oneLine(m.summary ?? '') || null,
        });
        return;
      }

      case 'background_tasks_changed': {
        // The level list, which is the only place a command left running ever
        // appears: it was never a call of this chat's own, so no row would be
        // drawn for it from the edges alone. REPLACE semantics on the kit's
        // side; here it only ever opens rows, because what closes one is the
        // edge that says how it ended.
        for (const task of (m.tasks ?? []) as { task_id: string; task_type: string; description: string }[]) {
          const id = String(task.task_id ?? '');
          if (!id || this.sentAway.has(id)) continue;
          this.sentAway.set(id, numbers(id));
          this.emit({
            type: 'agent.started',
            agentId: id,
            toolCallId: null,
            kind: kindOfTask(task.task_type, null),
            what: oneLine(task.description ?? ''),
            agentType: null,
            model: null,
          });
        }
        return;
      }

      default:
        return;
    }
  }

  /**
   * The model a helper is actually running, which the kit states nowhere except
   * on the helper's own messages. Sent up once, when it is first seen: the row
   * has an empty model column until then, and a row per message would be a
   * hundred events saying the same word.
   */
  private helperModel(callId: string, model: unknown): void {
    const id = this.taskOfCall.get(callId);
    if (!id || typeof model !== 'string' || !model) return;
    const was = this.sentAway.get(id);
    if (!was || was.model === model) return;
    this.sentAway.set(id, { ...was, model });
    this.emit({
      type: 'agent.progress',
      agentId: id,
      seconds: was.seconds,
      tokens: was.tokens,
      calls: was.calls,
      model,
    });
  }

  /**
   * What a helper's own result says about the run, when the kit sends it.
   *
   * `tool_use_result` is the structured Agent output — the report without the
   * model-directed trailer, plus totals — and is the only place the model a
   * helper actually resolved to is stated outright. Read from the result rather
   * than parsed out of the text it hands the model, which is what the kit's own
   * documentation says to do.
   */
  private helperFinished(callId: string, ok: boolean, result: unknown, output: string): void {
    const id = this.taskOfCall.get(callId);
    if (!id) return;
    const was = this.sentAway.get(id) ?? { seconds: 0, tokens: 0, calls: 0, model: null, state: 'running' as AgentState };
    const totals = (result ?? {}) as {
      resolvedModel?: string;
      totalTokens?: number;
      totalToolUseCount?: number;
      totalDurationMs?: number;
    };
    const model = totals.resolvedModel ?? was.model;

    // A launch is not an answer. Work the kit runs in the background — a
    // command, a workflow, a helper started asynchronously — answers its own
    // call IMMEDIATELY with an acknowledgement carrying an id and no usage at
    // all, and the thing itself goes on running for minutes. Read as a finish,
    // every row on the panel went grey seconds after it opened and wore the
    // acknowledgement as its result (measured 2026-08-20, all three kinds).
    // What ends such a row is the kit's own notification, which arrives when
    // the work actually ends. An error is still an ending: a call that came
    // back red is over however little it spent.
    const spent = Number(totals.totalDurationMs ?? 0) + Number(totals.totalTokens ?? 0) + Number(totals.totalToolUseCount ?? 0);
    if (ok && !spent) {
      if (model && model !== was.model) {
        this.sentAway.set(id, { ...was, model });
        this.emit({
          type: 'agent.progress',
          agentId: id,
          seconds: was.seconds,
          tokens: was.tokens,
          calls: was.calls,
          model,
        });
      }
      return;
    }

    this.sentAway.set(id, { ...was, model, state: ok ? 'done' : 'failed' });
    this.emit({
      type: 'agent.finished',
      agentId: id,
      state: ok ? 'done' : 'failed',
      seconds: Math.round(Number(totals.totalDurationMs ?? 0) / 1000) || was.seconds,
      tokens: Number(totals.totalTokens ?? 0) || was.tokens,
      calls: Number(totals.totalToolUseCount ?? 0) || was.calls,
      model,
      result: oneLine(answerOf(result, output)) || null,
    });
  }

  private note(note: Note): void {
    // A quiet line is skipped when the same sentence has just been drawn; a
    // `detail` is not, because it is the record rather than the reading.
    if (note.rank === 'note' && !note.always && this.saidAlready(note.text)) return;
    const body = note.body ?? null;
    this.emit({
      type: 'note',
      noteId: randomUUID(),
      rank: note.rank,
      kind: note.kind,
      text: note.text,
      // Cut where a command's output is cut, and for the same reason.
      // Cut where a command's arguments and its output are cut, and for the
      // same reason: the body is there to be read, and the whole of it is
      // already on disk in the kit's own record.
      body: body === null ? null : cut(body),
    });
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

  /**
   * The before/after a change-viewer needs, taken from the tool's own arguments.
   *
   * The rule itself is shared with the reading of a past chat, so an edit made
   * while this app watched and the same edit read back out of the kit's record
   * draw the identical change (src/workbench/imported-history.ts, `diffOf`).
   */
  private emitDiff(toolCallId: string, name: string, input: Record<string, unknown>): void {
    const change = diffOf(name, input);
    if (change) this.emit({ type: 'diff', toolCallId, ...change });
  }

  async start(opts: StartOptions): Promise<void> {
    this.emit = opts.emit;
    this.mode = opts.permissionMode ?? '';

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
        // Permission to SWITCH to bypass later, not a switch to it: the mode
        // above is still what the session runs in, and every tool is still
        // asked about until he picks otherwise. Without this the kit refuses
        // the switch and the picker offers a mode it cannot take — "Cannot set
        // permission mode to bypassPermissions because the session was not
        // launched with --dangerously-skip-permissions" (bw-1u1, §3.1).
        allowDangerouslySkipPermissions: true,
        // Word-by-word text. Without this only whole messages arrive.
        includePartialMessages: true,
        // What a sent-off agent SAYS, not only what it runs. The kit's default
        // forwards a helper's tool calls and nothing else — which is why a chat
        // that delegated its work showed a column of commands with no reasoning
        // anywhere near them, and why the manager could not tell a stuck helper
        // from a thinking one (bw-7ks.22.2, §8.2.2). Its words and its thinking
        // arrive as ordinary assistant messages carrying `parent_tool_use_id`,
        // and every one of them is drawn under the call that sent it.
        forwardSubagentText: true,
        // A short present-tense line about what each helper is doing now, asked
        // of the helper's own conversation about twice a minute. It reuses that
        // conversation's model and prompt cache, so it costs a fork of something
        // already warm rather than a new session.
        agentProgressSummaries: true,
        // His own rules, when they fire and when they fail. The kit's default
        // is false, and only SessionStart and Setup arrive without it — so the
        // grey line this app promises for "a hook that failed" could not fire
        // for a PreToolUse or PostToolUse rule at all, which is exactly the
        // kind that fails while the agent is working (bw-1u1.38, §8.2.4).
        // They are `detail` lines, so they cost a row and no attention.
        includeHookEvents: true,
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

  /**
   * The permission card, and the promise the SDK is blocked on until it is
   * clicked. Public for the same reason `draw` is: the standing check drives
   * THIS rather than a copy of it (scripts/README.md).
   */
  onPermissionRequest(
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
        // Cut where the call's own arguments and its output are cut. The card
        // for a Write carries the whole file, one method away from the cap
        // bw-1u1.33 put on the same bytes — and every chat in the asking mode
        // is the ones that pays it. The kit is still ANSWERED with the whole
        // input: `this.asks` above keeps it (bw-1u1.42).
        input: trimInput(input),
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
    this.modeIsNow(mode);
  }

  /**
   * The mode is now this — said once, however it got there.
   *
   * A change made from the picker and one the tool made by itself end here
   * alike: the line is said, and the pinned mode is republished so the picker
   * and the header stop claiming the old one. Saying it out loud is the point —
   * a chat that quietly stopped asking about tools is a trap (§8.2.4) — and so
   * is saying it every time, including the same mode picked twice, which is why
   * it opts out of the rule that skips a sentence just said (bw-1u1.32).
   *
   * Nothing is said when nothing changed: a status arrives on every single API
   * request and carries the mode each time (bw-1u1.43).
   */
  private modeIsNow(mode: string): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // `model: null` is "this message says nothing about the model" — see
    // protocol.ts. The sidecar stores the mode off this event, so a chat that
    // goes to sleep does not wake up back in the old one (§3.1).
    this.emit({ type: 'session.pinned', permissionMode: mode, model: null });
    this.note({ rank: 'note', kind: 'mode', text: `Permission mode is now ${mode}.`, always: true });
  }

  async setModel(model: string): Promise<void> {
    await this.q?.setModel(model);
    this.note({ rank: 'note', kind: 'model', text: `Model is now ${model}.`, always: true });
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

  /**
   * The account's plan allowance, as the kit's own `/usage` reports it.
   *
   * Answered by any live session at no cost — the kit fetches it from the
   * claude.ai usage endpoint and scans this machine's own records; no turn is
   * taken and no tokens are spent (measured 2026-08-20: 1.6s cold, 0 tokens).
   * The method name is the SDK's, shouting that the shape may change; it is
   * quarantined here so exactly one line moves when it does (bw-malh).
   */
  async usage(): Promise<unknown | null> {
    const q = this.q as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown> } | null;
    if (!q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET) return null;
    return await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wake?.();
    for (const ask of this.asks.values()) ask.resolve({ behavior: 'deny', message: 'Session closed.' });
    this.asks.clear();
    this.q?.close();
  }

  /** Reads the SDK’s message stream and hands every message to `draw`. */
  private async pump(): Promise<void> {
    if (!this.q) return;
    try {
      for await (const m of this.q as AsyncIterable<Record<string, any>>) this.draw(m);
    } catch (err) {
      this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err), fatal: true });
      this.emit({ type: 'session.state', state: 'errored', label: 'Failed' });
    }
  }

  /**
   * Turns one of the kit’s messages into what the chat draws.
   *
   * A method of its own, and public, so the standing check can drive THIS
   * rather than a copy of the tables it reads: a check that asks the tables
   * whether a kind has a name still passes when the loop that draws it is
   * gone, which is the shape of fault this whole job is about (bw-1u1.28,
   * scripts/README.md).
   */
  draw(m: Record<string, any>): void {
    switch (m.type) {
      case 'system':
        // Every status carries the mode in force, and the tool changes it by
        // itself (bw-1u1.43). Read before anything else in this arm, because
        // the same message is then drawn as an ordinary quiet line below.
        if (m.subtype === 'status' && typeof m.permissionMode === 'string' && m.permissionMode) {
          this.modeIsNow(m.permissionMode);
        }
        // What the chat has sent away, read from the same messages the lines
        // below are drawn from rather than instead of them (§8.2.7).
        this.sawTask(m);
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
        } else if (m.subtype === 'task_progress' && typeof m.tool_use_id === 'string' && m.tool_use_id) {
          // What a sent-off agent is doing now, in its own words, asked of its
          // own conversation about twice a minute. It belongs on the row that
          // sent it — a helper working for ten minutes would otherwise write
          // twenty grey lines into the middle of the conversation, and the
          // reader would still have to guess which helper each one was about
          // (bw-7ks.22.2, §8.2.2).
          const doing = oneLine(m.summary ?? m.last_tool_name ?? m.description ?? '');
          this.emit({
            type: 'tool.progress',
            toolCallId: m.tool_use_id,
            seconds: Math.round(Number(m.usage?.duration_ms ?? 0) / 1000),
            // Left out rather than sent empty: an absent line means "still
            // whatever it last said", and a blank one would erase it.
            ...(doing ? { summary: doing } : {}),
          });
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
        } else {
          // Every other thing the session says about itself.
          const note = noteFor(m);
          if (note) this.note(note);
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
          this.streamed.add(this.streamingMessageId);
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

      case 'assistant': {
        // Whose words these are. A sent-off agent's arrive on this arm and
        // nowhere else — the stream carries only the agent you are talking to —
        // and every event below is stamped with the call that sent them, so the
        // rows nest instead of interleaving (bw-7ks.22.2).
        const sentBy: string | undefined = m.parent_tool_use_id ?? undefined;
        // Which model this helper is on. Nothing else in the stream says it.
        if (sentBy) this.helperModel(sentBy, m.message?.model);

        // Words that never came down the stream — the kit wrote this message
        // itself, so there was no `message_start` and nothing was drawn
        // (bw-1u1). His own turns are unaffected: those always stream.
        const messageId = String(m.message?.id ?? m.uuid ?? '');
        if (messageId && !this.streamed.has(messageId)) {
          this.streamed.add(messageId);
          (m.message?.content ?? []).forEach((b: Record<string, any>, index: number) => {
            const id = `${messageId}:${index}`;
            // A helper's reasoning, which no stream ever carries. Drawn the same
            // way the main agent's is, dim and under its own heading.
            if (b.type === 'thinking' && String(b.thinking ?? '').trim()) {
              this.emit({
                type: 'thinking.delta',
                messageId: id,
                text: String(b.thinking),
                parentToolCallId: sentBy,
              });
              this.emit({ type: 'message.completed', messageId: id });
              return;
            }
            if (b.type !== 'text' || !String(b.text ?? '').trim()) return;
            // The status that came just before may already have said this.
            if (this.saidAlready(String(b.text))) return;
            this.emit({ type: 'message.started', messageId: id, role: 'assistant', parentToolCallId: sentBy });
            this.emit({ type: 'text.delta', messageId: id, text: String(b.text) });
            this.emit({ type: 'message.completed', messageId: id });
          });
        }
        // How full the conversation now is, which only the kit knows and only
        // says here (bw-4wcd.4). A helper's own usage is not this conversation's:
        // reading it here would make the gauge jump to whatever the last
        // delegated turn happened to be holding (bw-7ks.22.2).
        if (sentBy === undefined) {
          const named = windowNamed(m);
          if (named !== null) this.window = named;
          const used = fullness(m.message?.usage);
          if (used !== null) {
            this.emit({ type: 'context', used, window: this.window });
          }
        }
        for (const b of m.message?.content ?? []) {
          if (b.type === 'tool_use') {
            const input = b.input ?? {};
            this.liveTools.set(b.id, b.name);
            this.emit({
              type: 'tool.started',
              toolCallId: b.id,
              name: b.name,
              // Trimmed for the row and for the log; the whole of it still goes
              // to the diff, the checklist and the title below (bw-1u1.33).
              input: trimInput(input),
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
      }

      case 'user':
        // A turn the kit wrote in his name — an interrupt notice, a queued
        // message — says something he should read. A turn HE typed is
        // already in the log from the moment he sent it, and `isSynthetic`
        // is the flag that tells the two apart (§8.2.4).
        if (m.isSynthetic) {
          for (const b of m.message?.content ?? []) {
            if (b.type === 'text' && String(b.text ?? '').trim()) {
              this.note({ rank: 'note', kind: 'user/synthetic', text: oneLine(b.text), body: String(b.text) });
            }
          }
        }
        // Tool results come back on the user turn.
        for (const b of m.message?.content ?? []) {
          if (b.type === 'tool_result') {
            this.liveTools.delete(b.tool_use_id);
            // Named and measured rather than pasted in: a result carrying a
            // picture is thousands of characters of encoding (bw-1u1.30).
            const output = resultText(b.content);
            this.absorbChecklistResult(b.tool_use_id, output);
            this.emit({
              type: 'tool.completed',
              toolCallId: b.tool_use_id,
              ok: !b.is_error,
              output: cut(output),
            });
            // A helper's run totals, which the kit sends structured rather than
            // in the words it hands the model: the model it settled on, what it
            // spent and how many calls it made. The row's own edge message says
            // it finished; this says what it finished having done (§8.2.7).
            this.helperFinished(b.tool_use_id, !b.is_error, m.tool_use_result, output);
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
        // An error result carries the sentence saying what went wrong, and
        // the state label alone is one word.
        if (m.is_error && typeof m.result === 'string' && m.result.trim()) {
          this.note({ rank: 'note', kind: 'result', text: oneLine(m.result), body: m.result });
        }
        break;

      // No list of kinds this driver is willing to hear: whatever else the
      // kit sends is drawn, because a whitelist is exactly what dropped the
      // manager's /compact answer (§8.2.4).
      default: {
        const note = noteFor(m);
        if (note) this.note(note);
      }
    }
  }
}
