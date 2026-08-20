/**
 * A conversation, and the one pass that builds it.
 *
 * The transcript is a fold over the event log. It lives apart from the React
 * hook that used to hold it so the sidecar can run the very same fold: opening
 * a chat used to hand the browser every event ever recorded — three and three
 * quarter megabytes for the longest chat on this machine, of which four
 * hundredths were still on the screen, the rest wiped by a later
 * `transcript.reset` — and the browser folded all of it before drawing a word.
 * The sidecar folds it once now and sends what it built (bw-uiyz.4).
 *
 * `reduce` is the live tail: one event onto a drawn conversation, handing back
 * a fresh array so React sees a change, and leaving every untouched item's
 * identity alone so the remembered rows in transcript-rows.tsx stay put.
 * `foldAll` is the whole log at once: one look over the conversation rather
 * than one per event, which is what makes replaying thousands of events cost
 * what the conversation is rather than what the log is.
 *
 * Design: docs/agent-workbench.md §4.
 */
import type {
  AskOption,
  CommandInfo,
  Cost,
  ImagePayload,
  MachineFamily,
  ModelChoice,
  NoteRank,
  SessionState,
  TodoItem,
  WbpEvent,
} from './protocol';

export interface TranscriptMessage {
  kind: 'message';
  id: string;
  role: 'user' | 'assistant';
  text: string;
  images: ImagePayload[];
  done: boolean;
  /** Set when a sent-off agent said this — the row nests under the call that sent it. */
  parentId: string | null;
}

/** What the agent worked out on its way to an answer, as it arrived. */
export interface TranscriptThinking {
  kind: 'thinking';
  id: string;
  text: string;
  done: boolean;
  /** Set when a sent-off agent was working this out, not the agent you are talking to. */
  parentId: string | null;
}

export interface TranscriptTool {
  kind: 'tool';
  id: string;
  name: string;
  title: string;
  status: 'running' | 'ok' | 'failed';
  /** How long it has been running, as the brand counts it. */
  seconds: number;
  /**
   * What the agent this call sent away is doing NOW, in its own words. Null on
   * every other kind of call, and on a sent-off one until the first summary
   * arrives (bw-7ks.22.2).
   */
  summary: string | null;
  /** Set when a subagent made this call — the row nests under that call. */
  parentId: string | null;
  diff: { path: string; before: string; after: string } | null;
  /** What it was asked to do, and what it printed. Both open on the row's own click. */
  input: Record<string, unknown>;
  output: string | null;
}

/**
 * A line about the chat's own machinery rather than the agent's words.
 *
 * `rank` decides how loudly: `note` is always on the page in grey, `detail`
 * waits until the reader asks for everything (docs/agent-workbench.md §8.2.4).
 */
export interface TranscriptNote {
  kind: 'note';
  id: string;
  rank: NoteRank;
  /** The brand's own name for this kind of message, shown when everything is open. */
  noteKind: string;
  text: string;
  body: string | null;
}

export interface TranscriptAsk {
  kind: 'ask';
  id: string;
  toolName: string;
  title: string;
  options: AskOption[];
  chosen: string | null;
}

export interface TranscriptNotice {
  kind: 'notice';
  id: string;
  text: string;
  /** Which family it is drawn as; absent on a chat recorded before there were families. */
  family?: MachineFamily;
}

export interface TranscriptReport {
  kind: 'report';
  id: string;
  project: string;
  slug: string;
}

export type TranscriptItem =
  | TranscriptMessage
  | TranscriptThinking
  | TranscriptTool
  | TranscriptAsk
  | TranscriptReport
  | TranscriptNote
  | TranscriptNotice;

export interface SessionView {
  items: TranscriptItem[];
  state: SessionState;
  stateLabel: string;
  cost: Cost | null;
  /**
   * How full the conversation is, as the model last reported it, against the
   * window it has. Null until it has answered once (bw-4wcd.4).
   */
  context: { used: number; window: number } | null;
  todos: TodoItem[];
  /** Cards this chat has touched, as the machine recorded them. */
  beads: string[];
  /** What the session is actually pinned to, as the agent reported it. */
  permissionMode: string | null;
  model: string | null;
  /** What the writing box can offer for this session: its commands, skills, models. */
  menu: SessionMenu;
  /** Thinking done in this turn when the thinking itself is withheld, as the brand estimates it. */
  thinkingTokens: number;
  error: string | null;
  lastSeq: number;
}

export interface SessionMenu {
  commands: CommandInfo[];
  skills: string[];
  models: ModelChoice[];
  permissionModes: string[];
}

const NO_MENU: SessionMenu = { commands: [], skills: [], models: [], permissionModes: [] };

/** A chat with nothing drawn yet. Exported so the fold can be checked on its own. */
export const EMPTY: SessionView = {
  items: [],
  state: 'starting',
  stateLabel: 'Starting',
  cost: null,
  context: null,
  todos: [],
  beads: [],
  permissionMode: null,
  model: null,
  menu: NO_MENU,
  thinkingTokens: 0,
  error: null,
  lastSeq: 0,
};

/** Applies one event to the view. Pure, so replay and live tail agree by construction. */
export function reduce(view: SessionView, e: WbpEvent): SessionView {
  const items = view.items;
  const next: SessionView = { ...view, lastSeq: Math.max(view.lastSeq, e.seq) };

  switch (e.type) {
    case 'session.started':
      next.permissionMode = e.permissionMode || null;
      next.model = e.model;
      return next;

    case 'session.state':
      next.state = e.state;
      next.stateLabel = e.label;
      // A turn that is over owes no thinking count to the next one.
      if (e.state === 'idle' || e.state === 'errored' || e.state === 'stopped') next.thinkingTokens = 0;
      return next;

    case 'message.started':
      next.items = [
        ...items,
        {
          kind: 'message',
          id: e.messageId,
          role: e.role,
          text: '',
          images: [],
          done: false,
          parentId: e.parentToolCallId ?? null,
        },
      ];
      return next;

    case 'image':
      next.items = items.map((it) =>
        it.kind === 'message' && it.id === e.messageId ? { ...it, images: [...it.images, e.image] } : it,
      );
      return next;

    case 'text.delta':
      next.items = items.map((it) =>
        it.kind === 'message' && it.id === e.messageId ? { ...it, text: it.text + e.text } : it,
      );
      return next;

    case 'thinking.delta': {
      // One block per thinking id, grown by its deltas — the same fold as text,
      // so replay and the live tail cannot disagree (§4).
      const known = items.some((it) => it.kind === 'thinking' && it.id === e.messageId);
      next.items = known
        ? items.map((it) =>
            it.kind === 'thinking' && it.id === e.messageId ? { ...it, text: it.text + e.text } : it,
          )
        : [
            ...items,
            { kind: 'thinking', id: e.messageId, text: e.text, done: false, parentId: e.parentToolCallId ?? null },
          ];
      return next;
    }

    case 'message.completed':
      next.items = items.map((it) =>
        (it.kind === 'message' || it.kind === 'thinking') && it.id === e.messageId ? { ...it, done: true } : it,
      );
      return next;

    case 'tool.started':
      next.items = [
        ...items,
        {
          kind: 'tool',
          id: e.toolCallId,
          name: e.name,
          title: e.title,
          status: 'running',
          seconds: 0,
          summary: null,
          parentId: e.parentToolCallId,
          diff: null,
          input: e.input,
          output: null,
        },
      ];
      return next;

    case 'tool.completed':
      // The output is KEPT. It always crossed the wire and was thrown away
      // here, which is why a command could never be opened (bw-1u1).
      next.items = items.map((it) =>
        it.kind === 'tool' && it.id === e.toolCallId
          ? { ...it, status: e.ok ? 'ok' : 'failed', output: e.output }
          : it,
      );
      return next;

    case 'note':
      next.items = [...items, { kind: 'note', id: e.noteId, rank: e.rank, noteKind: e.kind, text: e.text, body: e.body }];
      return next;

    case 'tool.progress':
      // A summary that did not come with this one leaves the last one standing:
      // the line says what the helper is doing, and it is still doing it.
      next.items = items.map((it) =>
        it.kind === 'tool' && it.id === e.toolCallId
          ? { ...it, seconds: e.seconds, summary: e.summary || it.summary }
          : it,
      );
      return next;

    case 'diff':
      next.items = items.map((it) =>
        it.kind === 'tool' && it.id === e.toolCallId
          ? { ...it, diff: { path: e.path, before: e.before, after: e.after } }
          : it,
      );
      return next;

    case 'todo':
      next.todos = e.items;
      return next;

    case 'link.bead':
      next.beads = view.beads.includes(e.beadId) ? view.beads : [...view.beads, e.beadId];
      return next;

    case 'report.available': {
      const id = `${e.project}/${e.slug}`;
      next.items = items.some((it) => it.kind === 'report' && it.id === id)
        ? items
        : [...items, { kind: 'report', id, project: e.project, slug: e.slug }];
      return next;
    }

    case 'ask.permission':
      next.items = [
        ...items,
        { kind: 'ask', id: e.askId, toolName: e.toolName, title: e.title, options: e.options, chosen: null },
      ];
      return next;

    case 'ask.resolved':
      next.items = items.map((it) => (it.kind === 'ask' && it.id === e.askId ? { ...it, chosen: e.chosen } : it));
      return next;

    case 'thinking.progress':
      next.thinkingTokens = e.tokens;
      return next;

    case 'session.menu':
      next.menu = {
        commands: e.commands,
        skills: e.skills,
        models: e.models,
        permissionModes: e.permissionModes,
      };
      return next;

    case 'session.pinned':
      // A null field says nothing about that setting; what was there stays.
      // The tool changing the mode by itself reports only the mode, and it must
      // not blank the model on its way past (bw-1u1.43).
      if (e.permissionMode !== null) next.permissionMode = e.permissionMode;
      if (e.model !== null) next.model = e.model;
      return next;

    case 'cost':
      next.cost = e.cost;
      return next;

    case 'context':
      next.context = { used: e.used, window: e.window };
      return next;

    case 'error':
      next.error = e.message;
      return next;

    case 'notice':
      next.items = [...next.items, { kind: 'notice', id: `notice-${e.seq}`, text: e.text, family: e.family }];
      return next;

    // What follows replaces what came before: a chat re-read under a newer
    // reading of the record republishes its whole transcript, and a browser
    // already drawing the old copy must drop it rather than append (bw-1u1.27).
    // The cards go with it — they are read out of the same record.
    case 'transcript.reset':
      next.items = [];
      next.beads = [];
      return next;

    default:
      return next;
  }
}

/**
 * The whole log in one pass.
 *
 * `reduce` looks over every item drawn so far to find the one an event is
 * about, which is right for a single arriving event and ruinous for a replay:
 * a chat of three thousand events and two thousand rows walked six million of
 * them before it could be drawn. Here each item is found by name instead, and
 * the conversation is built in place, so the price is the log's length and
 * nothing more.
 *
 * The answer is the same view `events.reduce(reduce, EMPTY)` gives — proved
 * case by case in src/workbench/__tests__/reading-a-chat.test.ts against the
 * real fold.
 */
export function foldAll(events: readonly WbpEvent[]): SessionView {
  const items: TranscriptItem[] = [];
  // Where each item sits, by name. A message and a block of thinking can carry
  // the same name — they are the same turn of the conversation — so they are
  // looked up apart from one another.
  const messageAt = new Map<string, number>();
  const thinkingAt = new Map<string, number>();
  const toolAt = new Map<string, number>();
  const askAt = new Map<string, number>();
  const reportSeen = new Set<string>();
  const beads: string[] = [];
  const beadSeen = new Set<string>();

  const view: SessionView = { ...EMPTY, items, beads, todos: [] };

  const forget = () => {
    items.length = 0;
    messageAt.clear();
    thinkingAt.clear();
    toolAt.clear();
    askAt.clear();
    reportSeen.clear();
    beads.length = 0;
    beadSeen.clear();
  };

  for (const e of events) {
    if (e.seq > view.lastSeq) view.lastSeq = e.seq;

    switch (e.type) {
      case 'session.started':
        view.permissionMode = e.permissionMode || null;
        view.model = e.model;
        break;

      case 'session.state':
        view.state = e.state;
        view.stateLabel = e.label;
        if (e.state === 'idle' || e.state === 'errored' || e.state === 'stopped') view.thinkingTokens = 0;
        break;

      case 'message.started':
        messageAt.set(e.messageId, items.length);
        items.push({
          kind: 'message',
          id: e.messageId,
          role: e.role,
          text: '',
          images: [],
          done: false,
          parentId: e.parentToolCallId ?? null,
        });
        break;

      case 'image': {
        const at = messageAt.get(e.messageId);
        if (at !== undefined) {
          const it = items[at] as TranscriptMessage;
          it.images = [...it.images, e.image];
        }
        break;
      }

      case 'text.delta': {
        const at = messageAt.get(e.messageId);
        if (at !== undefined) (items[at] as TranscriptMessage).text += e.text;
        break;
      }

      case 'thinking.delta': {
        const at = thinkingAt.get(e.messageId);
        if (at === undefined) {
          thinkingAt.set(e.messageId, items.length);
          items.push({
            kind: 'thinking',
            id: e.messageId,
            text: e.text,
            done: false,
            parentId: e.parentToolCallId ?? null,
          });
        } else {
          (items[at] as TranscriptThinking).text += e.text;
        }
        break;
      }

      case 'message.completed': {
        const said = messageAt.get(e.messageId);
        if (said !== undefined) (items[said] as TranscriptMessage).done = true;
        const thought = thinkingAt.get(e.messageId);
        if (thought !== undefined) (items[thought] as TranscriptThinking).done = true;
        break;
      }

      case 'tool.started':
        toolAt.set(e.toolCallId, items.length);
        items.push({
          kind: 'tool',
          id: e.toolCallId,
          name: e.name,
          title: e.title,
          status: 'running',
          seconds: 0,
          summary: null,
          parentId: e.parentToolCallId,
          diff: null,
          input: e.input,
          output: null,
        });
        break;

      case 'tool.completed': {
        const at = toolAt.get(e.toolCallId);
        if (at !== undefined) {
          const it = items[at] as TranscriptTool;
          it.status = e.ok ? 'ok' : 'failed';
          it.output = e.output;
        }
        break;
      }

      case 'tool.progress': {
        const at = toolAt.get(e.toolCallId);
        if (at !== undefined) {
          const it = items[at] as TranscriptTool;
          it.seconds = e.seconds;
          if (e.summary) it.summary = e.summary;
        }
        break;
      }

      case 'diff': {
        const at = toolAt.get(e.toolCallId);
        if (at !== undefined) {
          (items[at] as TranscriptTool).diff = { path: e.path, before: e.before, after: e.after };
        }
        break;
      }

      case 'note':
        items.push({ kind: 'note', id: e.noteId, rank: e.rank, noteKind: e.kind, text: e.text, body: e.body });
        break;

      case 'todo':
        view.todos = e.items;
        break;

      case 'link.bead':
        if (!beadSeen.has(e.beadId)) {
          beadSeen.add(e.beadId);
          beads.push(e.beadId);
        }
        break;

      case 'report.available': {
        const id = `${e.project}/${e.slug}`;
        if (!reportSeen.has(id)) {
          reportSeen.add(id);
          items.push({ kind: 'report', id, project: e.project, slug: e.slug });
        }
        break;
      }

      case 'ask.permission':
        askAt.set(e.askId, items.length);
        items.push({ kind: 'ask', id: e.askId, toolName: e.toolName, title: e.title, options: e.options, chosen: null });
        break;

      case 'ask.resolved': {
        const at = askAt.get(e.askId);
        if (at !== undefined) (items[at] as TranscriptAsk).chosen = e.chosen;
        break;
      }

      case 'thinking.progress':
        view.thinkingTokens = e.tokens;
        break;

      case 'session.menu':
        view.menu = {
          commands: e.commands,
          skills: e.skills,
          models: e.models,
          permissionModes: e.permissionModes,
        };
        break;

      case 'session.pinned':
        if (e.permissionMode !== null) view.permissionMode = e.permissionMode;
        if (e.model !== null) view.model = e.model;
        break;

      case 'cost':
        view.cost = e.cost;
        break;

      case 'context':
        view.context = { used: e.used, window: e.window };
        break;

      case 'error':
        view.error = e.message;
        break;

      case 'notice':
        items.push({ kind: 'notice', id: `notice-${e.seq}`, text: e.text, family: e.family });
        break;

      case 'transcript.reset':
        forget();
        break;

      default:
        break;
    }
  }

  return view;
}
