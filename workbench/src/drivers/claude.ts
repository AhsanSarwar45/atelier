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
import {
  query,
  type EffortLevel,
  type PermissionResult,
  type PermissionUpdate,
  type SDKBackgroundTasksChangedMessage,
  type SDKTaskNotificationMessage,
  type SDKTaskProgressMessage,
  type SDKTaskStartedMessage,
  type SDKTaskUpdatedMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { claudeProgram } from '../claude-program.ts';

import {
  ALLOWANCE_WINDOW,
  effortInWords,
  extraUsage,
  inWords,
  PERMISSION_MODE,
  ruleFinished,
  ruleIsRunning,
  saidOf,
  TURN_ENDED,
  whenItComesBack,
  whoFor,
  workerStopped,
} from '../../../src/workbench/machine-words.ts';
import type { Audience, AgentControl, AgentKind, AgentState, CommandInfo, ExecutionContext, EffortChoice, ImagePayload, ModelChoice, NoteRank, PlanResponse, QuestionResponse, TodoItem } from '../../../src/workbench/protocol.ts';
import { materializeComparisons } from '../materialize-chat-media.ts';
import { widgetSpecs } from '../../../src/workbench/chat-widgets.ts';

/**
 * One model as the kit announced it, its thinking included.
 *
 * `supportedModels()` states per model whether it thinks at all and which
 * levels it offers. Four levels used to be written out here instead, so the
 * picker offered `max` to models that cannot think, never offered `xhigh` at
 * all, and the pick itself was sent to a method the kit has never had — every
 * effort pick in a Claude chat failed (bw-1jfs).
 */
export type ClaudeModelRow = {
  value: string;
  /** The real model an alias row stands for, e.g. `sonnet` -> `claude-sonnet-5`. */
  resolvedModel?: string;
  displayName: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
};

/**
 * The levels the model now in use announces, in the order it announced them.
 *
 * Nothing is offered for a model that states it does not think, or for one an
 * older kit describes without saying: an empty picker is honest, where a list
 * written here is a promise the chat cannot keep.
 */
export function claudeEffortMenu(models: ClaudeModelRow[], activeModel: string | null): EffortChoice[] {
  const selected = models.find((model) => model.value === activeModel || model.resolvedModel === activeModel)
    ?? models[0];
  if (!selected || selected.supportsEffort === false) return [];
  return (selected.supportedEffortLevels ?? []).map((value) => ({
    value,
    displayName: effortInWords(value),
  }));
}
import { CLAUDE_PERMISSION_MODES } from '../../../src/workbench/protocol.ts';
import { cut, diffOf, KEPT, resultText, trimInput } from '../../../src/workbench/imported-history.ts';
import { rawTitle, toolTitle, whileItRuns } from '../../../src/workbench/said-what-it-ran.ts';
import { fullness, WINDOW, windowNamed } from '../../../src/workbench/context-window.ts';
import type { Driver, DriverEvent, PermissionAnswer, PromptInput, StartOptions } from './types.ts';
import { AgentLifecycle, type ProviderAgentAdapter } from './agent-lifecycle.ts';
import { advertisedSlashCommands, offeredSlashCommand } from './slash-commands.ts';

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

interface PendingPlan {
  resolve: (r: PermissionResult) => void;
  input: Record<string, unknown>;
}

interface PendingQuestions {
  resolve: (r: PermissionResult) => void;
  input: Record<string, unknown>;
  questions: Record<string, any>[];
  agentId?: string;
}

/** A line for the transcript, and the whole message behind it. */
interface Note {
  rank: NoteRank;
  kind: string;
  text: string;
  body?: string;
  /**
   * Who this exact line is for, when the STATE decides it rather than the kind.
   *
   * An allowance filling up and an allowance that has stopped his work are one
   * kind and two different readers, and the screen cannot tell them apart — it
   * has the kind and how loud the line is, and that is two values where the kit
   * declares four states. So the part of the app that HAS the state answers,
   * and the answer rides on the note. Left off where the whole kind has one
   * reader: that ruling lives once, in `machine-lines.ts` (bw-iiv6).
   */
  audience?: Audience;
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
const SPOKEN_FIELDS = ['content', 'text', 'message', 'error', 'summary', 'reason', 'result', 'description'];

/**
 * A human sentence somewhere in a message this build has never seen.
 *
 * One level down as well as at the top. The kit keeps a task's new state under
 * `patch` and a background list's descriptions under `tasks`, and a search that
 * only looked at the top of the message found neither — so both printed their
 * own wire name where their sentence should be, on the manager's own screen
 * (bw-6jq5.3, bw-wasy).
 */
function spokenIn(m: Record<string, any>): string | null {
  const here = SPOKEN_FIELDS.map((f) => m[f]).find((v) => typeof v === 'string' && v.trim());
  if (here) return here as string;
  for (const value of Object.values(m)) {
    // The first of a list stands for the list: a message that carries ten of
    // something says what it is about with one of them, and a line that read
    // all ten would be a paragraph.
    const nested = Array.isArray(value) ? value[0] : value;
    if (!nested || typeof nested !== 'object') continue;
    const found = SPOKEN_FIELDS.map((f) => (nested as Record<string, any>)[f]).find(
      (v) => typeof v === 'string' && v.trim(),
    );
    if (found) return found as string;
  }
  return null;
}

/** The kit's name for one message, as the branches below spell it. */
function kindOf(m: Record<string, any>): string {
  return m.type === 'system' ? `system/${m.subtype}` : String(m.type ?? 'unknown');
}

/** One line, whatever it was given: a long value is cut and the whole of it kept in the body. */
function oneLine(value: unknown, limit = 200): string {
  // A field that is not there is nothing, not the two quote marks JSON writes
  // for it — `A sent-off agent finished: ""` was that, on his screen
  // (bw-iiv6.15). Anything else keeps its JSON, which is how a shape gets read.
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * Whether a task the kit reported was sent away by a HELPER rather than by this
 * chat.
 *
 * The kit reports both on one channel, so a command a helper ran drew a row of
 * its own beside the helper running it — owned by nobody, counting zero seconds
 * for a command that took forty-five, and saying its own description twice
 * (measured 2026-08-20). It is already drawn where it belongs: inside that
 * helper's own conversation.
 *
 * Two signals, because one of them is undeclared. The kit stamps such a task
 * `owned_by_subagent`, which is on the wire and not in its published types; and
 * the call that started it is a call this driver already watched a helper make.
 * Either is enough.
 */
export function sentAwayByAHelper(m: Record<string, any>, callsOfHelpers: ReadonlySet<string>): boolean {
  if (m.owned_by_subagent === true) return true;
  const call = typeof m.tool_use_id === 'string' ? m.tool_use_id : '';
  return call !== '' && callsOfHelpers.has(call);
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

/** A picture returned by a Claude tool result, translated into the browser's
 * shared inline-image payload. */
function resultImage(part: Record<string, any>): ImagePayload | null {
  if (part.type !== 'image' || !part.source) return null;
  const source = part.source as Record<string, unknown>;
  if (source.type === 'base64' && typeof source.data === 'string') {
    const mime = typeof source.media_type === 'string' ? source.media_type : 'image/*';
    return { mime, dataUrl: `data:${mime};base64,${source.data}`, alt: 'Agent-produced image' };
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    const mime = typeof source.media_type === 'string' ? source.media_type : 'image/*';
    return { mime, dataUrl: source.url, alt: 'Agent-produced image' };
  }
  return null;
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

/**
 * A row for sent-off work nothing has been heard about yet.
 *
 * One copy, because there were two and they drifted: a field added to the map's
 * shape reached one of them and the other went on building a row without it
 * (bw-6jq5.3).
 */
/** The states a row never leaves: the work is over, however it went. */
const OVER = new Set<AgentState>(['done', 'failed', 'stopped']);

/** The three words a finished line has, which are not every word a row has. */
type FinishedState = Extract<AgentState, 'done' | 'failed' | 'stopped'>;

/**
 * Is this row over? Asked as a question that narrows, so nothing can hand a
 * finished line a state it has no word for — which is what the typechecker
 * found here the moment it was let into this folder (bw-sxzv.3).
 */
function isOver(state: AgentState): state is FinishedState {
  return OVER.has(state);
}

/** What the kit's own word for a task's state means on a row. */
const TASK_STATE: Record<string, AgentState> = {
  pending: 'running',
  running: 'running',
  in_progress: 'running',
  paused: 'parked',
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
  stopped: 'stopped',
};

function noteFor(m: Record<string, any>, nameOf: (id: string) => string): Note | null {
  const note = noteBody(m, nameOf);
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

/**
 * @param nameOf what a sent-off agent is called, by the id the kit uses for it.
 *   The lines about sent-off work are the panel's record and are read behind
 *   the switch that gives the machine's own side back (bw-6jq5) — so they name
 *   the agent, which is the one thing a wire id cannot tell a reader.
 */
function noteBody(m: Record<string, any>, nameOf: (id: string) => string): Note | null {
  const kind = kindOf(m);
  const whole = () => oneLine(JSON.stringify(m), KEPT);
  const agent = () => nameOf(String(m.task_id ?? '')) || 'A sent-off agent';

  switch (kind) {
    // The answer to /compact, and the only place the reason lives.
    case 'system/status': {
      const state =
        m.compact_result === 'failed'
          ? 'compact_failed'
          : m.compact_result === 'success'
            ? 'compacted'
            : m.status === null || m.status === undefined
              ? 'idle'
              : String(m.status);
      const said = saidOf(kind, state);
      const who = whoFor(kind, state) ?? 'machine';
      if (state === 'compact_failed') {
        return { rank: 'note', kind, audience: who, text: `${said}: ${oneLine(m.compact_error ?? 'no reason given')}` };
      }
      if (state === 'compacted') return { rank: 'note', kind, audience: who, text: String(said) };
      // A ping on every single request, and the work of folding up: the machine
      // breathing, not something it is telling him.
      return {
        rank: 'detail',
        kind,
        audience: who,
        text: said ?? 'The chat is in a state this build has no words for.',
        body: whole(),
      };
    }

    case 'system/compact_boundary': {
      const meta = m.compact_metadata ?? {};
      const size = meta.post_tokens
        ? `${meta.pre_tokens} → ${meta.post_tokens} tokens`
        : meta.pre_tokens
          ? `${meta.pre_tokens} tokens`
          : null;
      const state = String(meta.trigger ?? 'manual');
      const said = saidOf(kind, state) ?? 'This chat folded itself up';
      return { rank: 'note', kind, audience: whoFor(kind, state) ?? 'you', text: size ? `${said}: ${size}.` : `${said}.` };
    }

    case 'system/informational':
      return {
        rank: INFORMATIONAL_RANK[String(m.level)] ?? 'note',
        kind,
        audience: whoFor(kind, String(m.level)) ?? 'machine',
        text: oneLine(m.content) || 'Something worth saying, with nothing said.',
        body: String(m.content ?? ''),
      };

    case 'system/notification':
      return {
        rank: m.priority === 'low' ? 'detail' : 'note',
        kind,
        audience: whoFor(kind, String(m.priority)) ?? 'machine',
        text: oneLine(m.text),
        body: String(m.text ?? ''),
      };

    case 'system/api_retry':
      return {
        rank: 'note',
        kind,
        // Which attempt this is, when the message says. A retry that arrives
        // without its count still has to read as a sentence: printing the
        // missing field put the word `undefined` in front of him, which is a
        // wire word by another road (bw-iiv6.15).
        text: `Retrying${m.attempt && m.max_retries ? ` (${m.attempt} of ${m.max_retries})` : ''}${m.error_status ? ` after HTTP ${m.error_status}` : ''}`,
        body: whole(),
      };

    case 'system/permission_denied':
      return {
        rank: 'note',
        kind,
        text: `${oneLine(m.tool_name ?? 'A tool')} was not allowed: ${oneLine(m.decision_reason ?? m.message ?? 'no reason given')}`,
        body: String(m.message ?? ''),
      };

    // The refusal nobody retried. The kit puts a human sentence on `content`
    // when it has one, and sends the message with that field empty when it does
    // not — which drew a machine line with no text in it at all, the fault
    // bw-iiv6.15 removed from its neighbours and left standing here
    // (bw-iiv6.17). So the sentence is built from what the message always
    // carries: which model refused, and why, when the kit says why.
    case 'system/model_refusal_no_fallback': {
      const why = oneLine(m.api_refusal_explanation ?? '');
      const said = oneLine(m.content);
      return {
        rank: 'note',
        kind,
        text:
          said ||
          `${oneLine(m.original_model ?? 'The model')} would not answer, and there was nothing else to try${why ? `: ${why}` : ''}.`,
        body: String(m.content ?? '') || whole(),
      };
    }

    case 'system/model_refusal_fallback': {
      const state = String(m.direction ?? 'retry');
      const said = saidOf(kind, state) ?? 'and the chat carried on with';
      return {
        rank: 'note',
        kind,
        audience: whoFor(kind, state) ?? 'you',
        text: `${oneLine(m.original_model ?? 'The model')} would not answer, ${said} ${oneLine(m.fallback_model ?? 'another model')}.`,
      };
    }

    // A hook that worked is the machine breathing; one that did not is his to
    // see. Neither keeps a body it has nothing to put in: a rule starting says
    // only which rule and which moment, and its line already says both. With
    // every hook event now asked for (§3.1), that body was two thirds of what
    // an install with hooks stored (bw-1u1.38, §8.2.5).
    case 'system/hook_started':
    case 'system/hook_progress': {
      // The moment a rule runs at is the kit's own word — `PreToolUse` — and it
      // went straight into the sentence twice over: once as the moment, and
      // again inside the rule's own name, which the kit writes as
      // `PreToolUse:Bash`. A moment this build has no English for is left
      // unsaid rather than spelled out in the wire's spelling (bw-iiv6).
      return {
        rank: 'detail',
        kind,
        text: ruleIsRunning(oneLine(m.hook_name ?? ''), String(m.hook_event ?? '')),
      };
    }

    case 'system/hook_response': {
      const state = String(m.outcome ?? 'success');
      const ok = state === 'success';
      const said = saidOf(kind, state) ?? 'finished in a way this build has no words for';
      const trouble = oneLine(m.stderr || m.output || '');
      const printed = [m.output, m.stdout, m.stderr].filter(Boolean).join('\n');
      return {
        rank: ok ? 'detail' : 'note',
        kind,
        audience: whoFor(kind, state) ?? 'machine',
        text: ruleFinished(oneLine(m.hook_name ?? ''), said, ok ? '' : trouble),
        // What it printed, when it printed anything. A rule that succeeded in
        // silence has nothing behind its line, and says so by not opening.
        body: printed || (ok ? undefined : whole()),
      };
    }

    // An agent leaving and an agent coming home. The panel is the list of
    // agents — what each one is, what it is doing, what it has spent — so the
    // chat says nothing about either unless one FAILED, which is the manager's
    // own ruling of 2026-08-20 and the reason the pair is split by outcome
    // rather than drawn alike (bw-6jq5).
    case 'system/task_started':
      return {
        rank: 'detail',
        kind,
        audience: 'machine',
        text: m.description ? `Sent off: ${oneLine(m.description)}` : 'Sent off a piece of work.',
        body: String(m.description ?? ''),
      };

    case 'system/task_notification': {
      const state = String(m.status ?? 'completed');
      const said = saidOf(kind, state) ?? 'ended in a way this build has no words for';
      const who = whoFor(kind, state) ?? 'machine';
      const summary = oneLine(m.summary);
      return {
        rank: who === 'you' ? 'note' : 'detail',
        kind,
        audience: who,
        text: summary ? `${agent()} ${said}: ${summary}` : `${agent()} ${said}.`,
        body: whole(),
      };
    }

    case 'system/memory_recall':
      return {
        rank: 'detail',
        kind,
        audience: whoFor(kind, String(m.mode)) ?? 'machine',
        text: `Recalled ${(m.memories ?? []).length} ${(m.memories ?? []).length === 1 ? 'memory' : 'memories'}`,
        body: (m.memories ?? []).map((mem: { path: string }) => mem.path).join('\n'),
      };

    case 'system/worker_shutting_down':
      return { rank: 'note', kind, text: workerStopped(oneLine(m.reason)), body: whole() };

    case 'system/plugin_install': {
      const state = String(m.status ?? 'started');
      const said = saidOf(kind, state) ?? 'is in a state this build has no words for';
      return {
        rank: state === 'failed' ? 'note' : 'detail',
        kind,
        audience: whoFor(kind, state) ?? 'machine',
        text: `Plugin ${oneLine(m.name ?? 'with no name')} ${said}${m.error ? `: ${oneLine(m.error)}` : ''}.`,
      };
    }

    case 'system/mirror_error':
      return { rank: 'note', kind, text: `Could not mirror this chat: ${oneLine(m.error)}`, body: whole() };

    case 'tool_use_summary':
      return {
        rank: 'detail',
        kind,
        text: m.summary ? oneLine(m.summary) : 'A tool call, summarised.',
        body: String(m.summary ?? ''),
      };

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
    // should be (bw-jkh2.19).
    //
    // A window that is OPEN is the machine reporting that nothing is wrong, and
    // it says so again every few minutes — one of the two biggest things the
    // reader was shown for nothing (docs/agent-workbench.md §8.2.4, where the
    // count lives). A window that has closed or is closing is
    // about HIM — it is why his work is about to stop — so only that one is
    // loud, and the pair is what the chat sorts on (bw-6jq5).
    case 'rate_limit_event': {
      const info = m.rate_limit_info ?? {};
      const stopped = info.errorCode === 'credits_required' ? 'credits_required' : String(info.status ?? 'allowed');
      // The kit carries a SECOND window behind this one — paid overflow — with
      // its own three-word status and its own thirteen reasons for being shut,
      // and none of it was read: a window that was fine with nothing behind it
      // said only "is fine" (bw-iiv6.16). The window that has actually turned
      // work away is still the sentence; the overflow is a clause on the end of
      // it, and only names the state when the window itself has room left.
      const overage = String(info.overageStatus ?? '');
      const behind = extraUsage(overage, String(info.overageDisabledReason ?? ''), Boolean(info.isUsingOverage ?? info.overageInUse));
      const state =
        stopped === 'allowed' && overage === 'rejected'
          ? 'overage_blocked'
          : stopped === 'allowed' && overage === 'allowed_warning'
            ? 'overage_low'
            : stopped;
      const window = ALLOWANCE_WINDOW[String(info.rateLimitType ?? '')] ?? 'usage';
      const said = saidOf(kind, state) ?? 'is in a state this build has no words for';
      const who = whoFor(kind, state) ?? 'machine';
      const back = typeof info.resetsAt === 'number' ? clockOf(info.resetsAt) : null;
      // The time matters differently on the two sides. To him it is when his
      // work starts again; to the machine's own books it is only when the
      // counter turns over. The rule lives beside the words, because a line
      // restated from an old record has to end the same way (bw-iiv6.11).
      const tail = whenItComesBack(who, back);
      return {
        rank: who === 'you' ? 'note' : 'detail',
        kind,
        audience: who,
        text: `Your ${window} allowance ${said}${tail}${behind}`,
        body: whole(),
      };
    }

    // The three below are the record of sent-off work, and the panel is where
    // that work is READ (bw-6jq5) — so they sit on the machine's own side and
    // nothing here is loud. Behind that switch is still a conversation though,
    // and all three used to print their own wire name into it, because the only
    // words they carry are a level down (bw-6jq5.3).
    case 'system/task_updated': {
      const patch = (m.patch ?? {}) as { status?: string; is_backgrounded?: boolean };
      const state = String(patch.status ?? '');
      const said = patch.is_backgrounded
        ? 'was left running in the background'
        : (saidOf(kind, state) ?? 'is in a state this build has no words for');
      return {
        rank: 'detail',
        kind,
        audience: whoFor(kind, state) ?? 'machine',
        text: `${agent()} ${said}.`,
        body: whole(),
      };
    }

    case 'system/task_progress': {
      // Only ever seen here when the work belongs to no call of this chat's:
      // one that does is drawn on its own row instead, and never reaches a line.
      const doing = oneLine(m.summary ?? m.last_tool_name ?? m.description ?? '');
      return { rank: 'detail', kind, text: doing ? `${agent()}: ${doing}` : `${agent()} is still going`, body: whole() };
    }

    case 'system/background_tasks_changed': {
      const named = ((m.tasks ?? []) as { description?: string }[])
        .map((task) => oneLine(task.description ?? ''))
        .filter(Boolean);
      return {
        rank: 'detail',
        kind,
        text:
          named.length === 0
            ? 'Nothing is running in the background now'
            : `Running in the background: ${named.join(', ')}`,
        body: whole(),
      };
    }

    // The chat's own state changing under him. Idle and working are the
    // machine's — the chat's chip says both, continuously, and better. One
    // WAITING on him is his: nothing moves until he answers, and nothing else
    // on the screen says so (bw-iiv6).
    case 'system/session_state_changed': {
      const state = String(m.state ?? '');
      const said = saidOf(kind, state);
      const who = whoFor(kind, state) ?? 'machine';
      if (!said) {
        return { rank: 'detail', kind, audience: 'machine', text: 'This chat changed to a state this build has no words for.', body: whole() };
      }
      return { rank: who === 'you' ? 'note' : 'detail', kind, audience: who, text: said, body: whole() };
    }

    // The app's own request to the agent, getting on with itself.
    case 'system/control_request_progress': {
      const state = String(m.status ?? '');
      const said = saidOf(kind, state) ?? 'The app is talking to the agent.';
      return { rank: 'detail', kind, audience: whoFor(kind, state) ?? 'machine', text: said, body: whole() };
    }

    // Files he attached being put away. Only a failure is his — a file that did
    // not arrive is a file the agent will never see, and he is the one who can
    // send it again.
    case 'system/files_persisted': {
      const failed = (m.failed ?? []) as { filename?: string; error?: string }[];
      const files = (m.files ?? []) as { filename?: string }[];
      const state = failed.length ? 'some_failed' : 'stored';
      const said = saidOf(kind, state) ?? 'Handled';
      const howMany = failed.length || files.length;
      const why = failed.length ? `: ${oneLine(failed[0].error ?? 'no reason given')}` : '';
      return {
        rank: failed.length ? 'note' : 'detail',
        kind,
        audience: whoFor(kind, state) ?? 'machine',
        text: `${said} ${howMany} ${howMany === 1 ? 'file' : 'files'}${why}.`,
        body: whole(),
      };
    }

    // The four the kit's type file does not declare and its own read loop hands
    // on regardless (bw-cx70). Their shapes are read off the kit's shipped
    // program, so each of these reads only the fields that program is caught
    // writing, and nothing that is merely likely to be there.

    // A standing goal of his. Value gone means the goal is gone: the kit's own
    // note on the type says so, and that is the end of a loop only he started.
    case 'active_goal': {
      const goal = (m.value ?? null) as { condition?: string } | null;
      const state = goal === null ? 'cleared' : 'chasing';
      const said = saidOf(kind, state) ?? 'The goal you set changed.';
      const who = whoFor(kind, state) ?? 'machine';
      const towards = oneLine(goal?.condition ?? '');
      return {
        rank: who === 'you' ? 'note' : 'detail',
        kind,
        audience: who,
        text: goal === null ? said : `${said}${towards ? `: ${towards}` : ''}.`,
        body: whole(),
      };
    }

    // Whether this chat folds its own history up as it fills. A setting, not
    // the fold — `system/compact_boundary` is the fold, and that one is his.
    case 'autocompact_state': {
      const value = (m.value ?? null) as { enabled?: boolean } | null;
      const state = value?.enabled === true ? 'on' : 'off';
      return {
        rank: 'detail',
        kind,
        audience: whoFor(kind, state) ?? 'machine',
        text: saidOf(kind, state) ?? 'This chat changed how it keeps its history.',
        body: whole(),
      };
    }

    // The kit's own reading of where the turn ended. The detail beside it is
    // the kit's English and it is the whole reason this is worth a line: it
    // says WHAT the turn is stopped on, which nothing else on the screen does.
    case 'system/post_turn_summary': {
      const state = String(m.status_category ?? '');
      const said = saidOf(kind, state);
      const who = whoFor(kind, state) ?? 'machine';
      const detail = oneLine(m.status_detail ?? '');
      if (!said) {
        return { rank: 'detail', kind, audience: 'machine', text: 'This turn ended in a way this build has no words for.', body: whole() };
      }
      return {
        rank: who === 'you' ? 'note' : 'detail',
        kind,
        audience: who,
        text: `${said}${detail ? ` — ${detail}` : ''}.`,
        body: whole(),
      };
    }

    // What this chat is doing right now, in one line. The chip and the panel
    // both draw it already, so in the conversation it is the machine breathing.
    case 'system/task_summary': {
      const doing = oneLine(m.detail ?? '');
      const state = doing ? 'doing' : 'cleared';
      const said = saidOf(kind, state) ?? 'This chat changed what it is doing.';
      return {
        rank: 'detail',
        kind,
        audience: whoFor(kind, state) ?? 'machine',
        text: doing ? `${said}: ${doing}.` : said,
        body: whole(),
      };
    }

    case 'system/elicitation_complete':
      return {
        rank: 'detail',
        kind,
        audience: 'machine',
        text: m.mcp_server_name ? `The ${oneLine(m.mcp_server_name)} add-on finished asking.` : 'An add-on finished asking.',
        body: whole(),
      };

    // A guess at what he might type next. It belongs in the writing box and
    // nowhere near the record, so it is silent on purpose and says so in the
    // table (src/workbench/machine-words.ts, SAID_NOTHING).
    case 'prompt_suggestion':
      return null;

    default: {
      // A kind this build has never seen. If it carries a sentence — at the top
      // of the message or a level down — it is drawn like anything else that
      // speaks; if it is only structure it says so in words, and waits behind
      // "show everything". Either way it is never its own wire name, which
      // tells a reader nothing he did not already have (bw-6jq5.3).
      const spoken = spokenIn(m);
      return spoken
        ? { rank: 'note', kind, text: oneLine(spoken), body: String(spoken) }
        : {
            rank: 'detail',
            kind,
            // Its own name went in the sentence here, in brackets, which is the
            // fault this whole section is about wearing a disguise: a reader
            // handed `active_goal` learns nothing he did not have. The name is
            // still on the note — in its body, and on the kind the record
            // keeps — so anyone who opens the line can see exactly what came
            // (bw-cx70.3).
            text: 'The machine said something this build has no words for.',
            body: whole(),
          };
    }
  }
}

type ClaudeTaskSignal =
  | SDKTaskStartedMessage
  | SDKTaskProgressMessage
  | SDKTaskUpdatedMessage
  | SDKTaskNotificationMessage
  | SDKBackgroundTasksChangedMessage;

/** Claude's published task-message union translated into the shared ledger. */
class ClaudeAgentAdapter implements ProviderAgentAdapter<ClaudeTaskSignal> {
  private readonly agents: AgentLifecycle;
  private readonly callsOfHelpers: ReadonlySet<string>;
  private readonly taskOfCall: Map<string, string>;
  private readonly callOfTask: Map<string, string>;
  private readonly parentOfCall: ReadonlyMap<string, string>;

  constructor(
    agents: AgentLifecycle,
    callsOfHelpers: ReadonlySet<string>,
    taskOfCall: Map<string, string>,
    callOfTask: Map<string, string>,
    parentOfCall: ReadonlyMap<string, string>,
  ) {
    this.agents = agents;
    this.callsOfHelpers = callsOfHelpers;
    this.taskOfCall = taskOfCall;
    this.callOfTask = callOfTask;
    this.parentOfCall = parentOfCall;
  }

  accept(message: ClaudeTaskSignal): boolean {
    if (message.subtype === 'background_tasks_changed') {
      // The SDK explicitly defines this as an independent replace-style level
      // signal whose ordering cannot be correlated with lifecycle bookends.
      this.agents.replaceLiveSet(message.tasks.map((task) => task.task_id));
      return true;
    }

    const id = message.task_id;

    if (message.subtype === 'task_started') {
      const call = message.tool_use_id || null;
      if (call) {
        this.taskOfCall.set(call, id);
        this.callOfTask.set(id, call);
      }
      this.agents.start({
        agentId: id,
        toolCallId: call,
        kind: kindOfTask(message.task_type, message.subagent_type),
        what: oneLine(message.description ?? message.workflow_name ?? message.prompt ?? ''),
        agentType: message.subagent_type ?? null,
        model: null,
        execution: this.execution(id, call, message.subagent_type ?? null),
      });
      return true;
    }

    if (message.subtype === 'task_progress') {
      this.agents.progress(id, {
        seconds: Math.round(message.usage.duration_ms / 1000),
        tokens: message.usage.total_tokens,
        calls: message.usage.tool_uses,
        doing: oneLine(message.summary ?? message.last_tool_name ?? message.description),
      });
      return true;
    }

    if (message.subtype === 'task_updated') {
      const state = message.patch.is_backgrounded
        ? 'parked'
        : message.patch.status && TASK_STATE[message.patch.status];
      if (!state) return true;
      if (isOver(state)) this.agents.finish(id, { state, result: message.patch.error ?? null });
      else this.agents.progress(id, { state });
      return true;
    }

    const state = TASK_STATE[message.status];
    this.agents.finish(id, {
      state: state && isOver(state) ? state : 'done',
      seconds: message.usage ? Math.round(message.usage.duration_ms / 1000) : undefined,
      tokens: message.usage?.total_tokens,
      calls: message.usage?.tool_uses,
      result: oneLine(message.summary) || null,
    });
    return true;
  }

  private execution(agentId: string, operationId: string | null, actorName: string | null): ExecutionContext {
    const parentOperationId = operationId ? this.parentOfCall.get(operationId) ?? null : null;
    const parentActorId = parentOperationId ? this.taskOfCall.get(parentOperationId) ?? null : null;
    return {
      conversationId: agentId,
      actorId: agentId,
      actorName,
      parentActorId,
      operationId,
      parentOperationId,
    };
  }
}

export class ClaudeDriver implements Driver {
  private emit!: (e: DriverEvent) => void;
  private cwd = process.cwd();
  private q: ReturnType<typeof query> | null = null;
  /** Turns queued by the browser, handed to the SDK as an async iterable. */
  private inbox: PromptInput[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private asks = new Map<string, PendingAsk>();
  private plans = new Map<string, PendingPlan>();
  private questions = new Map<string, PendingQuestions>();
  /** Tools whose result we are still waiting for, so a completion can name them. */
  private liveTools = new Map<string, string>();
  /** The assistant message currently being streamed. */
  private streamingMessageId = '';
  /** The agent's checklist, in the order the items were created. */
  private todos: TodoItem[] = [];
  /** The skills this install has, kept so a pushed command list can be re-sent with them. */
  private skills: string[] = [];
  /** The exact executable surface last advertised to the browser. */
  private commands: CommandInfo[] = [];
  private menuReady: Promise<void> = Promise.resolve();
  /**
   * The models and the terminal-only names from the last full menu.
   *
   * A mid-session push carries commands and nothing else, and the browser
   * replaces the whole menu with what it is sent — so re-sending it without
   * these took the model picker away for the rest of the chat and offered the
   * commands a browser must hide (bw-f1q.13).
   */
  private models: ModelChoice[] = [];
  /**
   * The same models as the kit stated them, thinking included.
   *
   * Kept beside `models` because the shared menu carries only what a picker
   * draws, and which levels a model offers is answered per model.
   */
  private modelRows: ClaudeModelRow[] = [];
  /** The model this chat is running, which decides the levels it can be set to. */
  private model: string | null = null;
  private terminalOnly = new Set<string>();
  /**
   * The window the conversation is measured against, which the kit states only
   * when it was asked for its own context report (bw-4wcd.15).
   */
  private window = WINDOW;
  /** What the last turn left in the window, so a corrected window can be re-stated. */
  private used: number | null = null;
  /** The kit is asked for its real window once per session, not once per turn. */
  private windowAsked = false;
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
  private agents = new AgentLifecycle((event) => this.emit(event));
  private taskAdapter: ClaudeAgentAdapter | null = null;
  /** Which task a call sent off, so a helper's own words can find its row. */
  private taskOfCall = new Map<string, string>();
  /**
   * And back the other way, so a row can be steered.
   *
   * Parking is asked for by the CALL that started the work, not by the task —
   * that is what the kit's own control takes — and the row carries the task id
   * (docs/agent-workbench.md §8.2.7).
   */
  private callOfTask = new Map<string, string>();
  /**
   * Which sent-off agent made a call, for the calls a helper makes of its own.
   *
   * A permission question names the call it is about and nothing else, so this
   * is what says whose question it is: the helper's call is looked up here, and
   * the answer is the call that sent the helper — the same parentage every one
   * of its words already carries (bw-7ks.22.5).
   */
  private parentOfCall = new Map<string, string>();
  /** Which row is held up by an outstanding question, so it can be let go again. */
  private agentAsking = new Map<string, string>();
  /** Every call a HELPER made, so work it sends away is not read as this chat's. */
  private callsOfHelpers = new Set<string>();
  /** The tasks that turned out to be a helper's own, so nothing later opens a row for them. */
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
   *
   * Null is "no status has arrived yet", and it is not the same as the empty
   * string: a chat that has only just opened has not CHANGED its mode, and
   * saying so put a line about the machine's own settings at the top of every
   * conversation the manager opened — 37 of them over three days, every one the
   * first line of its chat (bw-6jq5.2, bw-k3vs).
   */
  private mode: string | null = null;
  private effort: string | null = null;
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
   * The exception is work a HELPER sent away, and the answer is true twice.
   * `true` means the shared lifecycle consumed the message. The panel and the
   * categorized operation row are projections of that record; drawing the
   * SDK notification again as a quiet machine/assistant line would give one
   * transition two UI identities.
   *
   * Nothing here is a delta. The kit's messages each carry a different corner
   * of the picture — a status change with no numbers, a result with no elapsed
   * — so what it does not say this time is what it said last time, kept in
   * the shared lifecycle ledger rather than blanked.
   */
  private sawTask(m: Record<string, any>): boolean {
    if (m.type !== 'system') return false;
    if (!['task_started', 'task_progress', 'task_updated', 'task_notification', 'background_tasks_changed'].includes(String(m.subtype))) return false;
    return this.claudeAgents().accept(m as ClaudeTaskSignal);
  }

  private claudeAgents(): ClaudeAgentAdapter {
    this.taskAdapter ??= new ClaudeAgentAdapter(
      this.agents,
      this.callsOfHelpers,
      this.taskOfCall,
      this.callOfTask,
      this.parentOfCall,
    );
    return this.taskAdapter;
  }

  /** What a row last said about itself, for a message that carries only part of it. */
  private rowNumbers(agentId: string): { seconds: number; tokens: number; calls: number; model: string | null; state: AgentState; what: string } {
    const row = this.agents.get(agentId);
    return row ?? { seconds: 0, tokens: 0, calls: 0, model: null, state: 'running', what: '' };
  }

  /**
   * A row's state changed and nothing else about it did.
   *
   * The numbers are sent again rather than blanked: a question being raised
   * says nothing about how long the helper has been going, and a row that
   * dropped its clock every time one arrived would flicker.
   */
  private agentState(agentId: string, state: AgentState): void {
    if (!this.agents.has(agentId)) return;
    const was = this.rowNumbers(agentId);
    if (was.state === state) return;
    // The states a row never leaves. Everything that moves a row through this
    // door — a question raised, a park, the background list saying a command is
    // running — is about work still going on, and none of it is a reason to
    // reopen work that is over (bw-7ks.22.30).
    if (OVER.has(was.state)) return;
    if (isOver(state)) this.agents.finish(agentId, { state, result: null });
    else this.agents.progress(agentId, { state });
  }

  /**
   * Which sent-off agent raised a permission question, when one did
   * (bw-7ks.22.5).
   *
   * The kit names only the call being asked about. That call is the helper's
   * OWN, and the step from it to the call that sent the helper is the same
   * parentage every one of the helper's words is already stamped with — so
   * nothing new has to be asked of the kit to know whose question this is.
   *
   * `agentId` can be null where the call's parent is known and its row is not:
   * the question still belongs to that agent's conversation, which is where a
   * reader goes looking for it.
   */
  private whoAsked(toolUseId: string | undefined): { sentBy: string; agentId: string | null } | null {
    const sentBy = toolUseId ? this.parentOfCall.get(toolUseId) : undefined;
    if (!sentBy) return null;
    return { sentBy, agentId: this.taskOfCall.get(sentBy) ?? null };
  }

  private executionFor(
    sentBy: string | undefined,
    operationId: string | null,
  ): ExecutionContext | undefined {
    if (!sentBy) return undefined;
    const actorId = this.taskOfCall.get(sentBy);
    if (!actorId) return undefined;
    const actor = this.agents.get(actorId);
    return {
      conversationId: actorId,
      actorId,
      actorName: actor?.agentType || actor?.what || null,
      parentActorId: actor?.execution?.parentActorId ?? null,
      operationId,
      parentOperationId: sentBy,
    };
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
    const was = this.agents.get(id);
    if (!was || was.model === model) return;
    this.agents.progress(id, { model });
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
    const was = this.agents.get(id);
    if (!was) return;
    // He stopped it. The call it was dispatched by comes back interrupted a
    // moment later, and reading that receipt as an ending would rewrite what he
    // did into a clean finish — no error, and nothing on the screen to say the
    // stop ever happened (bw-7ks.22.27).
    if (was.state === 'stopped') return;
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
        this.agents.progress(id, { model });
      }
      return;
    }

    this.agents.finish(id, {
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
      // Only where the STATE decided it. Left off, the screen falls back to the
      // ruling for the whole kind, which is where that ruling lives (bw-iiv6).
      ...(note.audience ? { audience: note.audience } : {}),
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
    const path = typeof input.file_path === 'string' ? input.file_path : '';
    let source: string | undefined;
    if (path) {
      try {
        source = readFileSync(resolve(this.cwd, path), 'utf8');
      } catch {
        // The diff still draws without a line.
      }
    }
    const change = diffOf(name, input, source);
    if (change) this.emit({ type: 'diff', toolCallId, ...change });
  }

  async start(opts: StartOptions): Promise<void> {
    this.effort = opts.effort ?? null;
    this.model = opts.model ?? null;
    this.emit = opts.emit;
    this.agents = new AgentLifecycle(this.emit);
    this.taskAdapter = null;
    this.cwd = opts.cwd;
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
        // The reader's own Claude Code, not the copy the kit ships: this
        // helper travels inside a single binary and that copy is a third of a
        // gigabyte, and theirs is the one they signed into and update.
        // `undefined` here is how the kit is asked to find its own, which is
        // what a machine that installed the helper from source wants.
        pathToClaudeCodeExecutable: claudeProgram(),
        // Resuming by id works from any directory, for sessions started
        // anywhere — including ones the owner began in a terminal.
        resume: opts.resume,
        // Keep the id: a fork would strand the transcript we already show.
        forkSession: false,
        // Pinned explicitly every time: the CLI's defaults shift, and plan /
        // bypass are not restored on resume. 'default' is the mode that asks
        // about every tool — measured, see protocol.ts.
        permissionMode: opts.permissionMode as never,
        effort: opts.effort as never,
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
        // `toolUseID` is what says whose question this is: it names the call
        // being asked about, and a call a helper made is on record as the
        // helper's (bw-7ks.22.5).
        canUseTool: (
          toolName: string,
          input: Record<string, unknown>,
          o: { suggestions?: PermissionUpdate[]; toolUseID?: string; agentID?: string },
        ) => this.onPermissionRequest(toolName, input, o),
      },
    });

    void this.pump();
    // Asked now, not when the session announces itself: measured 2026-08-17, a
    // session says nothing at all until the first turn is sent, while
    // supportedCommands/supportedModels answer in 0.7s on a silent one. Waiting
    // for `init` would leave a fresh chat with no menus until he had already
    // typed something (bw-f1q).
    this.menuReady = this.publishMenu(null);
  }

  /**
   * The permission card, and the promise the SDK is blocked on until it is
   * clicked. Public for the same reason `draw` is: the standing check drives
   * THIS rather than a copy of it (scripts/README.md).
   */
  onPermissionRequest(
    toolName: string,
    input: Record<string, unknown>,
    o: { suggestions?: PermissionUpdate[]; toolUseID?: string; agentID?: string },
  ): Promise<PermissionResult> {
    const askId = randomUUID();
    // Whose question this is, worked out before the card goes out: a helper's
    // question is answered on the helper's row and inside the helper's own
    // conversation, not in the middle of its owner's (§8.2.7).
    const asker = this.whoAsked(o.toolUseID);
    if (toolName === 'AskUserQuestion' && Array.isArray(input.questions) && input.questions.length > 0) {
      const questions = input.questions.filter((question): question is Record<string, any> =>
        question !== null && typeof question === 'object' && typeof question.question === 'string');
      if (questions.length > 0) return new Promise<PermissionResult>((resolve) => {
        this.questions.set(askId, { resolve, input, questions, ...(asker?.agentId ? { agentId: asker.agentId } : {}) });
        if (asker?.agentId) this.agentState(asker.agentId, 'waiting');
        this.emit({
          type: 'question.requested', requestId: askId, blocking: true,
          questions: questions.map((question, questionIndex) => ({
            id: `question:${questionIndex}`,
            header: String(question.header || 'Question'),
            prompt: String(question.question),
            selection: question.multiSelect === true ? 'multiple' as const : 'single' as const,
            options: (Array.isArray(question.options) ? question.options : []).map((option: Record<string, any>, optionIndex: number) => ({
              id: `question:${questionIndex}:option:${optionIndex}`,
              label: String(option.label),
              ...(typeof option.description === 'string' && option.description ? { description: option.description } : {}),
              ...(typeof option.preview === 'string' && option.preview ? { preview: option.preview } : {}),
            })),
            allowCustom: true,
            secret: question.isSecret === true,
          })),
          ...(asker ? { parentToolCallId: asker.sentBy } : {}),
        });
        this.emit({ type: 'session.state', state: 'waiting_permission', label: 'Waiting for your answer' });
      });
    }
    if (toolName === 'ExitPlanMode' && typeof input.plan === 'string' && input.plan.trim()) {
      const markdown = input.plan.trim();
      return new Promise<PermissionResult>((resolve) => {
        this.plans.set(askId, { resolve, input });
        this.emit({
          type: 'plan.proposed', proposalId: askId, markdown,
          actions: [
            {
              id: 'approve', kind: 'approve', label: 'Approve plan',
              description: 'Approve Claude’s plan and continue through its native plan-mode control.',
            },
            {
              id: 'request_changes', kind: 'request_changes', label: 'Request changes', acceptsFeedback: true,
              description: 'Keep planning and tell Claude what should change.',
            },
          ],
          ...(asker ? { parentToolCallId: asker.sentBy } : {}),
        });
        this.emit({ type: 'session.state', state: 'waiting_permission', label: 'Waiting for your plan decision' });
      });
    }
    return new Promise<PermissionResult>((resolve) => {
      this.asks.set(askId, { resolve, suggestions: o.suggestions, input });
      // The row stops reading as working while nobody is answering it. That is
      // the whole reason a row's state is not a boolean.
      if (asker?.agentId) {
        this.agentAsking.set(askId, asker.agentId);
        this.agentState(asker.agentId, 'waiting');
      }
      // Cut where the call's own arguments and its output are cut. The card
      // for a Write carries the whole file, one method away from the cap
      // bw-1u1.33 put on the same bytes — and every chat in the asking mode
      // is the ones that pays it. The kit is still ANSWERED with the whole
      // input: `this.asks` above keeps it (bw-1u1.42).
      //
      const shown = trimInput(input);
      this.emit({
        type: 'ask.permission',
        askId,
        toolName,
        input: shown,
        // The one place that does NOT get the English sentence. A reader being
        // asked whether to allow something is entitled to the literal text that
        // will run: `rm -rf dist` and `rm -rf /` are one sentence and two very
        // different commands, and a summary is exactly the wrong thing on the
        // screen where the detail decides the answer (bw-7ks.24.6).
        title: rawTitle(toolName, shown),
        options: [
          { id: 'allow_once', label: 'Allow once', kind: 'allow_once' },
          { id: 'allow_always', label: 'Allow always', kind: 'allow_always' },
          { id: 'deny', label: 'Deny', kind: 'deny' },
        ],
        ...(asker ? { parentToolCallId: asker.sentBy } : {}),
      });
      this.emit({ type: 'session.state', state: 'waiting_permission', label: `Asking about ${toolName}` });
    });
  }

  answerQuestions(requestId: string, response: QuestionResponse): void {
    const pending = this.questions.get(requestId);
    if (!pending) throw new Error('This Claude question is no longer awaiting an answer');
    const byId = new Map(response.answers.map((answer) => [answer.questionId, answer]));
    const answers: Record<string, string> = {};
    const annotations: Record<string, { notes?: string; preview?: string }> = {};
    pending.questions.forEach((question, questionIndex) => {
      const questionId = `question:${questionIndex}`;
      const answer = byId.get(questionId);
      if (!answer) throw new Error(`No answer was supplied for Claude question "${question.question}"`);
      const options = new Map((Array.isArray(question.options) ? question.options : []).map((option: Record<string, any>, optionIndex: number) => [
        `${questionId}:option:${optionIndex}`, option,
      ]));
      const selected = answer.optionIds.map((id) => options.get(id)).filter((option): option is Record<string, any> => Boolean(option));
      const values = selected.map((option) => String(option.label));
      if (answer.customText?.trim()) values.push(answer.customText.trim());
      answers[String(question.question)] = values.join(', ');
      const previews = selected.map((option) => option.preview).filter((preview): preview is string => typeof preview === 'string' && preview.length > 0);
      if (answer.note?.trim() || previews.length) annotations[String(question.question)] = {
        ...(answer.note?.trim() ? { notes: answer.note.trim() } : {}),
        ...(previews.length ? { preview: previews.join('\n\n') } : {}),
      };
    });
    this.questions.delete(requestId);
    if (pending.agentId) this.agentState(pending.agentId, 'running');
    pending.resolve({
      behavior: 'allow',
      updatedInput: { ...pending.input, answers, ...(Object.keys(annotations).length ? { annotations } : {}) },
    });
    this.emit({ type: 'question.resolved', requestId, answers: response.answers });
    this.emit({ type: 'session.state', state: 'thinking', label: 'Working' });
  }

  async respondToPlan(proposalId: string, response: PlanResponse): Promise<void> {
    const pending = this.plans.get(proposalId);
    if (!pending) throw new Error('This Claude plan is no longer awaiting a response');
    this.plans.delete(proposalId);
    if (response.actionId === 'approve') {
      pending.resolve({ behavior: 'allow', updatedInput: pending.input });
      this.emit({ type: 'plan.resolved', proposalId, status: 'approved', actionId: response.actionId });
    } else if (response.actionId === 'request_changes') {
      const feedback = response.feedback?.trim();
      if (!feedback) {
        this.plans.set(proposalId, pending);
        throw new Error('Plan feedback is required');
      }
      pending.resolve({ behavior: 'deny', message: feedback });
      this.emit({ type: 'plan.resolved', proposalId, status: 'changes_requested', actionId: response.actionId, feedback });
    } else {
      this.plans.set(proposalId, pending);
      throw new Error(`Unknown Claude plan action "${response.actionId}"`);
    }
    this.emit({ type: 'session.state', state: 'thinking', label: 'Working' });
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
    let rows: ClaudeModelRow[] = [];
    try {
      const [commands, offered] = await Promise.all([
        this.q?.supportedCommands() ?? Promise.resolve([]),
        this.q?.supportedModels() ?? Promise.resolve([]),
      ]);
      described = commands as typeof described;
      rows = offered as ClaudeModelRow[];
    } catch {
      // An older install answers neither; the names from init still make a menu.
    }

    // Remembered, because a later push carries neither of them.
    if (rows.length) {
      this.modelRows = rows;
      this.models = rows.map((m) => ({ value: m.value, displayName: m.displayName, description: m.description }));
    }
    if (terminalOnly.size) this.terminalOnly = terminalOnly;
    this.emitMenu(described.length ? described : named.map((name) => ({ name, description: '' })));
  }

  /** Folds one list of commands into the menu event, skills and models included. */
  private emitMenu(commands: { name: string; description: string; argumentHint?: string }[]): void {
    // A command whose whole point is the terminal it was typed in cannot work
    // from a browser, so it is not offered here (§7).
    this.commands = advertisedSlashCommands(commands, this.skills, this.terminalOnly);
    this.pushMenu();
  }

  /**
   * Sends the menu as it now stands.
   *
   * Apart from `emitMenu`, because folding the commands a second time would
   * fold the skills in on top of themselves; a model change needs the levels
   * redrawn and the commands left exactly as they are.
   */
  private pushMenu(): void {
    this.emit({
      type: 'session.menu',
      commands: this.commands,
      skills: this.skills,
      models: this.models,
      permissionModes: [...CLAUDE_PERMISSION_MODES],
      efforts: claudeEffortMenu(this.modelRows, this.model),
      agentDefinitions: [],
      agentControls: this.agentControls(),
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
   * request and carries the mode each time (bw-1u1.43). Nor when there is
   * nothing to have changed FROM — the first status of a chat is the mode it
   * opened in, which the header already shows and nobody chose here. Asking for
   * a mode still speaks even as the first thing a chat does, because then
   * somebody did choose it (bw-6jq5.2).
   */
  private modeIsNow(mode: string, heard: 'observed' | 'asked' = 'asked'): void {
    if (mode === this.mode) return;
    const openedIn = this.mode === null && heard === 'observed';
    this.mode = mode;
    // `model: null` is "this message says nothing about the model" — see
    // protocol.ts. The sidecar stores the mode off this event, so a chat that
    // goes to sleep does not wake up back in the old one (§3.1).
    this.emit({ type: 'session.pinned', permissionMode: mode, model: null });
    if (openedIn) return;
    // The setting's own spelling used to go straight into the sentence, so the
    // one line on the screen that MUST be read said `bypassPermissions`
    // (bw-iiv6). A mode this build has never met has its seams opened up rather
    // than being printed as the kit spells it.
    const said = PERMISSION_MODE[mode]?.said ?? inWords(mode).toLowerCase();
    this.note({ rank: 'note', kind: 'mode', text: `This chat will now ${said}.`, always: true });
  }

  async setModel(model: string): Promise<void> {
    await this.q?.setModel(model);
    this.model = model;
    this.note({ rank: 'note', kind: 'model', text: `Model is now ${model}.`, always: true });
    // The levels belong to the model, so the picker is redrawn for the one
    // just chosen rather than left offering the last model's (bw-1jfs.3).
    this.pushMenu();
  }

  async setEffort(effort: string): Promise<void> {
    if (!this.q) throw new Error('This chat is not running, so its effort cannot be changed');
    // A level is a settings change that stands for the rest of the session.
    // The kit has never had a `setEffort` of its own, so guarding on one meant
    // every pick was refused, in the name of the reader's install (bw-1jfs.2).
    await this.q.applyFlagSettings({ effortLevel: effort as EffortLevel });
    this.effort = effort;
    this.emit({ type: 'session.pinned', permissionMode: null, model: null, effort });
  }

  answer(askId: string, choice: PermissionAnswer): void {
    const ask = this.asks.get(askId);
    if (!ask) return;
    this.asks.delete(askId);
    // Whatever was held up by it is working again.
    const held = this.agentAsking.get(askId);
    if (held !== undefined) {
      this.agentAsking.delete(askId);
      this.agentState(held, 'running');
    }

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
    // Nothing is reading the inbox once this driver is down. A turn pushed into
    // it would sit there forever under a chip saying Thinking, which is the one
    // thing a chat must never say about a turn nobody has (bw-sxzv.2).
    if (this.closed) throw new Error('This chat is no longer running.');
    await this.validate(input);
    this.inbox.push(input);
    this.wake?.();
    this.wake = null;
    this.awaitingAnswer = true;
    this.emit({ type: 'session.state', state: 'thinking', label: 'Thinking' });
  }

  async validate(input: PromptInput): Promise<void> {
    await this.menuReady;
    offeredSlashCommand(input.text, this.commands);
  }

  /**
   * All three, because the kit has all three: it stops one task by its id, it
   * backgrounds one by the call that started it, and a relay asks the brand for
   * nothing at all (docs/agent-workbench.md §8.2.7).
   */
  agentControls(): AgentControl[] {
    return ['stop', 'park', 'say'];
  }

  /**
   * Ends one piece of sent-off work and nothing else. The chat keeps its turn,
   * and everything else it sent away keeps running; the kit answers with a
   * notification of its own, which is what closes the row.
   *
   * The row is told the moment the kit takes the stop, and not left waiting for
   * that notification: the call this work was dispatched by also comes back,
   * carrying a clean result whatever became of the work, and whichever of the
   * two arrives first is the one the row would have believed. Written down
   * here, the order stops mattering and what he did survives it
   * (bw-7ks.22.27). A row already over is left alone — stopping something that
   * has just finished does not un-finish it.
   */
  async stopAgent(agentId: string): Promise<void> {
    await this.q?.stopTask(agentId);
    this.agentState(agentId, 'stopped');
  }

  /**
   * Hands the turn back and lets the work run on.
   *
   * Asked for by the CALL that started it, which is what the kit's control
   * takes. No means one thing only — the kit answers false when no work of that
   * name was in the foreground — so a no is not a failure but an answer about
   * the work: it is already running in the background, and the row is told to
   * read that way. Nothing on the wire says so any earlier. A command left
   * running arrives like any other piece of work, call and all, and the kit
   * only mentions being backgrounded when something changes it (bw-7ks.22.24).
   */
  async parkAgent(agentId: string): Promise<boolean> {
    const call = this.callOfTask.get(agentId);
    const parked = call ? ((await this.q?.backgroundTasks(call)) ?? false) : false;
    // Parking it moves it itself, in the kit's own report; only the no has to
    // be written down here, and the row stops offering what is already true.
    if (!parked) this.agentState(agentId, 'parked');
    return parked;
  }

  async interrupt(): Promise<void> {
    // Any card still on screen must be released first, or interrupt deadlocks
    // behind a promise nobody will resolve.
    for (const [askId, ask] of this.asks) {
      ask.resolve({ behavior: 'deny', message: 'Stopped by the owner.', interrupt: true });
      this.emit({ type: 'ask.resolved', askId, chosen: 'deny' });
    }
    this.asks.clear();
    for (const [requestId, question] of this.questions) {
      question.resolve({ behavior: 'deny', message: 'Stopped by the owner.', interrupt: true });
      this.emit({ type: 'question.resolved', requestId, answers: [] });
    }
    this.questions.clear();
    for (const [proposalId, plan] of this.plans) {
      plan.resolve({ behavior: 'deny', message: 'Stopped by the owner.', interrupt: true });
      this.emit({ type: 'plan.resolved', proposalId, status: 'rejected', actionId: 'interrupt' });
    }
    this.plans.clear();
    await this.q?.interrupt();
    this.awaitingAnswer = false;
    this.emit({ type: 'session.state', state: 'stopped', label: 'Stopped' });
  }


  /**
   * What is filling this chat's window, as the kit's own `/context` has it.
   *
   * Down the channel that is already open, so it costs no turn and no tokens
   * (measured 2026-08-20: 1.4s, 0 tokens) — which is what lets the panel ask
   * every time it is opened rather than caching a picture that has moved. The
   * shape is the kit's; `readWindow` in `src/workbench/window-now.ts` turns it
   * into the browser's, and this is the one line that knows the method's name
   * (bw-3ug7).
   */
  /**
   * Takes the window the kit itself is measuring against, and re-states the
   * gauge if it differs from what was assumed.
   */
  private async adoptWindow(): Promise<void> {
    try {
      const raw = (await this.windowNow()) as { rawMaxTokens?: unknown; maxTokens?: unknown } | null;
      const stated = [raw?.rawMaxTokens, raw?.maxTokens].find(
        (n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0,
      );
      if (stated === undefined || stated === this.window) return;
      this.window = stated;
      if (this.used !== null) this.emit({ type: 'context', used: this.used, window: this.window });
    } catch {
      // An unanswerable kit leaves the assumed window standing, which is what
      // was drawn before this asked at all.
    }
  }

  async windowNow(): Promise<unknown | null> {
    const q = this.q as { getContextUsage?: () => Promise<unknown> } | null;
    if (!q?.getContextUsage) return null;
    return await q.getContextUsage();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wake?.();
    for (const ask of this.asks.values()) ask.resolve({ behavior: 'deny', message: 'Session closed.' });
    this.asks.clear();
    for (const question of this.questions.values()) question.resolve({ behavior: 'deny', message: 'Session closed.' });
    this.questions.clear();
    for (const plan of this.plans.values()) plan.resolve({ behavior: 'deny', message: 'Session closed.' });
    this.plans.clear();
    this.q?.close();
  }

  /**
   * Puts this driver down where it stands, without waiting to be asked.
   *
   * Everything here is a promise something else is holding: the run handle the
   * kit answers on, the turns queued for a generator that is still being read,
   * the permission cards blocking the kit's own call. When the stream this
   * driver was reading ends in an error, all four are already dead and none of
   * them say so — so the chat went on looking alive. It took the next turn into
   * an inbox with no reader and drew Thinking over it, and his Stop went out
   * over a transport nobody was on and hung until the browser gave up ten
   * seconds later (bw-sxzv.2).
   *
   * Said in the past tense on purpose: this does not stop anything, it admits
   * that everything is already stopped.
   */
  private putDown(): void {
    this.closed = true;
    this.q = null;
    // The turns nobody will ever read. Dropped rather than kept, because the
    // chat comes back by starting a fresh run, and a turn replayed into that
    // one would be a question asked twice.
    this.inbox = [];
    this.awaitingAnswer = false;
    // Lets the generator wake, see that this is over, and end.
    this.wake?.();
    this.wake = null;
    // And any card still on his screen comes down. The call it was blocking is
    // gone with the transport, so leaving it up asks him to answer nobody.
    for (const [askId, ask] of this.asks) {
      ask.resolve({ behavior: 'deny', message: 'This chat stopped answering.' });
      this.emit({ type: 'ask.resolved', askId, chosen: 'deny' });
    }
    this.asks.clear();
  }

  /** Reads the SDK’s message stream and hands every message to `draw`. */
  private async pump(): Promise<void> {
    if (!this.q) return;
    try {
      for await (const m of this.q as AsyncIterable<Record<string, any>>) this.draw(m);
    } catch (err) {
      // Down first, then the news. `emit` runs the whole publishing path
      // synchronously — the record, the browser, and the app letting go of this
      // driver — so anything it reaches must find a driver that has already
      // stopped claiming to work.
      this.putDown();
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
          this.modeIsNow(m.permissionMode, 'observed');
        }
        // What the chat has sent away, read from the same messages the lines
        // below are drawn from rather than instead of them (§8.2.7). It answers
        // whether the message was a helper's own work, which this chat says
        // nothing at all about — see `sawTask`.
        const helpers = this.sawTask(m);
        if (m.subtype === 'init') {
          this.emit({
            type: 'session.started',
            brand: 'claude',
            externalId: m.session_id ?? null,
            model: m.model ?? null,
            cwd: m.cwd ?? '',
            permissionMode: m.permissionMode ?? '',
            effort: typeof m.effort === 'string' ? m.effort : this.effort,
          });
          // Only when nothing is in flight: see `awaitingAnswer`.
          if (!this.awaitingAnswer) this.emit({ type: 'session.state', state: 'idle', label: 'Ready' });
          this.menuReady = this.publishMenu(m);
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
        } else if (!helpers) {
          // Every other thing the session says about itself.
          const note = noteFor(m, (id) => this.agents.get(id)?.what ?? '');
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
        const messageExecution = this.executionFor(sentBy, String(m.message?.id ?? m.uuid ?? '') || null);
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
                ...(messageExecution ? { execution: messageExecution } : {}),
              });
              this.emit({ type: 'message.completed', messageId: id, ...(messageExecution ? { execution: messageExecution } : {}) });
              return;
            }
            if (b.type !== 'text' || !String(b.text ?? '').trim()) return;
            // The status that came just before may already have said this —
            // this chat's status, about this chat's own words. A helper speaks
            // under its own heading and its words are not lines of this
            // conversation, so they are not kept in this window either: shared,
            // a helper answering "DONE" silenced the very line saying that
            // helper had come back, because that line quotes its answer
            // (bw-7ks.22.6).
            if (sentBy === undefined && this.saidAlready(String(b.text))) return;
            this.emit({
              type: 'message.started', messageId: id, role: 'assistant', parentToolCallId: sentBy,
              ...(messageExecution ? { execution: messageExecution } : {}),
            });
            this.emit({ type: 'text.delta', messageId: id, text: String(b.text), ...(messageExecution ? { execution: messageExecution } : {}) });
            this.emit({ type: 'message.completed', messageId: id, ...(messageExecution ? { execution: messageExecution } : {}) });
          });
        }
        (m.message?.content ?? []).forEach((b: Record<string, any>, index: number) => {
          if (b.type !== 'text') return;
          for (const comparison of materializeComparisons(String(b.text ?? ''), this.cwd)) {
            this.emit({ type: 'image.compare', messageId: `${messageId}:${index}`, comparison });
          }
          for (const widget of widgetSpecs(String(b.text ?? ''))) {
            this.emit({ type: 'widget', messageId: `${messageId}:${index}`, widget });
          }
        });
        // How full the conversation now is, which only the kit knows and only
        // says here (bw-4wcd.4). A helper's own usage is not this conversation's:
        // reading it here would make the gauge jump to whatever the last
        // delegated turn happened to be holding (bw-7ks.22.2).
        if (sentBy === undefined) {
          const named = windowNamed(m);
          if (named !== null) this.window = named;
          const used = fullness(m.message?.usage);
          if (used !== null) {
            this.used = used;
            this.emit({ type: 'context', used, window: this.window });
            // The messages rarely state the window, so the gauge would sit on
            // the ordinary 200k while a session actually running on a million
            // was 3% full — and the panel the gauge opens, which asks the kit
            // outright, said so on the same screen (bw-3ug7.11). Ask once, off
            // the turn: the answer costs nothing and takes no turn.
            if (!this.windowAsked) {
              this.windowAsked = true;
              void this.adoptWindow();
            }
          }
        }
        for (const b of m.message?.content ?? []) {
          if (b.type === 'tool_use') {
            const input = b.input ?? {};
            // Whose call this is, kept for the panel: work started by a call a
            // helper made is the helper's, not this chat's.
            if (sentBy) {
              this.callsOfHelpers.add(String(b.id));
              this.parentOfCall.set(String(b.id), sentBy);
            }
            this.liveTools.set(b.id, b.name);
            // Trimmed for the row and for the log; the whole of it still goes
            // to the diff and the checklist below (bw-1u1.33). The title is
            // said off the trimmed copy on purpose — the browser has only that
            // copy, and the two have to arrive at the same sentence from it
            // (bw-7ks.24.6).
            const shown = trimInput(input);
            const execution = this.executionFor(sentBy, String(b.id));
            this.emit({
              type: 'tool.started',
              toolCallId: b.id,
              name: b.name,
              input: shown,
              title: toolTitle(b.name, shown),
              // Subagent attribution rides on the MESSAGE, not the block.
              parentToolCallId: m.parent_tool_use_id ?? null,
              ...(execution ? { execution } : {}),
            });
            this.emitDiff(b.id, b.name, input);
            this.applyChecklistCall(b.id, b.name, input);
            // The line under the last message is read WHILE this runs, so it says
            // "Running the tests" rather than the row's own past tense.
            this.emit({ type: 'session.state', state: 'running_tool', label: whileItRuns(toolTitle(b.name, shown)) });
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
            const resultExecution = this.executionFor(this.parentOfCall.get(String(b.tool_use_id)), String(b.tool_use_id));
            this.absorbChecklistResult(b.tool_use_id, output);
            this.emit({
              type: 'tool.completed',
              toolCallId: b.tool_use_id,
              ok: !b.is_error,
              output: cut(output),
              ...(resultExecution ? { execution: resultExecution } : {}),
            });
            const pictures = Array.isArray(b.content)
              ? b.content
                  .map((part: Record<string, any>) => resultImage(part))
                  .filter((image: ImagePayload | null): image is ImagePayload => image !== null)
              : [];
            if (pictures.length) {
              const messageId = `${b.tool_use_id}:images`;
              this.emit({ type: 'message.started', messageId, role: 'assistant', ...(resultExecution ? { execution: resultExecution } : {}) });
              for (const image of pictures) this.emit({ type: 'image', messageId, image, ...(resultExecution ? { execution: resultExecution } : {}) });
              this.emit({ type: 'message.completed', messageId, ...(resultExecution ? { execution: resultExecution } : {}) });
            }
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
        // The chip used to wear the kit's own subtype, so `error_max_turns`
        // sat where "Ready" sits — the one place on the screen a reader looks
        // to know whether he can type (bw-iiv6).
        this.emit({
          type: 'session.state',
          state: m.subtype === 'success' ? 'idle' : 'errored',
          label: TURN_ENDED[String(m.subtype ?? '')] ?? 'Failed',
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
        const note = noteFor(m, (id) => this.agents.get(id)?.what ?? '');
        if (note) this.note(note);
      }
    }
  }
}
