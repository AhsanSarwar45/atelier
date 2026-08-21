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
  AgentControl,
  AgentKind,
  AgentState,
  AskOption,
  Audience,
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
// With its extension, which is not a style: this file is read two ways. The
// browser's build resolves it either way; the sidecar is Node running the
// TypeScript as it stands, and Node resolves the exact filename or nothing —
// so a bare `./protocol` here kills the sidecar on launch, forever, and no
// chat opens at all (bw-7ks.22.35). Type-only imports are erased and never
// meet Node, which is why the one above can be spelled the short way.
import { isOver } from './protocol.ts';

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
  /**
   * Who this line is for, when the driver settled it from the message's own
   * state. Absent on a line whose whole kind has one reader, and on every line
   * written before there were audiences (bw-iiv6).
   */
  audience?: Audience;
}

export interface TranscriptAsk {
  kind: 'ask';
  id: string;
  toolName: string;
  title: string;
  options: AskOption[];
  chosen: string | null;
  /**
   * The call that sent the agent which raised this question, or null when the
   * chat's own agent raised it. Named `parentId` because that is what every
   * other row calls it — it is what the agent's own pane reads to find the
   * questions that belong to it (docs/agent-workbench.md §8.2.7).
   */
  parentId: string | null;
  /**
   * What that agent was sent off to do, as its row says it — joined here once,
   * when the question arrives, so a card in the middle of the conversation
   * names the agent that raised it instead of reading as the chat's own.
   */
  askedBy: string | null;
}

export interface TranscriptNotice {
  kind: 'notice';
  id: string;
  text: string;
  /** Which family it is drawn as; absent on a chat recorded before there were families. */
  family?: MachineFamily;
  /** Who it is for; absent on a chat recorded before there were audiences (bw-6jq5). */
  audience?: Audience;
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

/**
 * One piece of work the chat sent away, as the panel draws it
 * (docs/agent-workbench.md §8.2.7).
 *
 * It is kept apart from the conversation rather than as another item in it,
 * because it is not something that was said: a helper started ten minutes ago
 * is a row whose numbers are still moving, and a row that moves cannot be a
 * line in a transcript that only ever grows at the bottom.
 *
 * `startedAt` is when the chat let go of it, so a row can count its own seconds
 * between the kit's reports; `seconds` is the kit's own count, which is the one
 * that is right when the two disagree.
 */
export interface SentAway {
  id: string;
  /** The call that sent it, where there was one. A helper's row opens onto it. */
  toolCallId: string | null;
  kind: AgentKind;
  what: string;
  agentType: string | null;
  model: string | null;
  state: AgentState;
  /** Milliseconds since the epoch, from the event that started it. */
  startedAt: number;
  /** How long the kit says it has been going. */
  seconds: number;
  tokens: number;
  calls: number;
  /** Its own last present-tense line, or null until it has said one. */
  doing: string | null;
  /** Its last word, kept once it is finished. */
  result: string | null;
  /**
   * Words the owner typed FOR this agent, in the order they were typed.
   *
   * They were not delivered to it — nothing can — they were said to the chat
   * that sent it, naming it. Kept so the row can say so (§8.2.7).
   */
  relayed: string[];
}

/**
 * The brief of the agent a question came from, as its row knows it.
 *
 * By the call that SENT it, falling back to the row's own id, which is the one
 * key every part of this app looks a sent-off agent up by.
 */
function briefOf(agents: SentAway[], sentBy: string | null): string | null {
  if (sentBy === null) return null;
  return agents.find((a) => (a.toolCallId ?? a.id) === sentBy)?.what || null;
}

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
  /** Everything this chat sent away, oldest first (docs/agent-workbench.md §8.2.7). */
  agents: SentAway[];
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
  /** Which steering controls this session's brand has for the work it sent away. */
  agentControls: AgentControl[];
}

const NO_MENU: SessionMenu = { commands: [], skills: [], models: [], permissionModes: [], agentControls: [] };

/** A chat with nothing drawn yet. Exported so the fold can be checked on its own. */
export const EMPTY: SessionView = {
  items: [],
  state: 'starting',
  stateLabel: 'Starting',
  cost: null,
  context: null,
  todos: [],
  agents: [],
  beads: [],
  permissionMode: null,
  model: null,
  menu: NO_MENU,
  thinkingTokens: 0,
  error: null,
  lastSeq: 0,
};

/** A list off the wire, or the blank one when the sender never sent it. */
function list<T>(sent: T[] | undefined, blank: T[]): T[] {
  return Array.isArray(sent) ? sent : blank;
}

/**
 * A menu off the wire, every list of it guarded — including the one that
 * arrives from a running sidecar as nothing at all.
 *
 * Same reason the whole conversation is guarded (asView below): the sidecar
 * goes on running the code it was started with, so it announces the menu it
 * knew about when it started. A sidecar older than the controls has no
 * `agentControls` to send, and a panel that asks that absent list whether it
 * contains `stop` takes the chat down with it. Guarding four of the five and
 * not the newest one guards exactly the fields that were never going to be
 * missing (bw-7ks.22.31).
 */
function menuOf(sent: Partial<SessionMenu>): SessionMenu {
  return {
    commands: list(sent.commands, NO_MENU.commands),
    skills: list(sent.skills, NO_MENU.skills),
    models: list(sent.models, NO_MENU.models),
    permissionModes: list(sent.permissionModes, NO_MENU.permissionModes),
    agentControls: list(sent.agentControls, NO_MENU.agentControls),
  };
}

/**
 * A conversation off the wire, filled against a blank one.
 *
 * The sidecar is a process and the screen is a page: it goes on running the
 * code it was started with while the browser reloads into newer code, so a
 * screen reading a list the sidecar has never heard of reads nothing at all and
 * the whole chat goes white. That is not a hypothetical — it is what an agent
 * panel does against a sidecar started before the panel existed, and it is what
 * every reader with the program already running will meet on the next upgrade.
 *
 * Anything the sender left out is what a chat with nothing in it has, which is
 * exactly what the screen drew before that field existed.
 */
export function asView(sent: Partial<SessionView> | null | undefined): SessionView {
  const raw = sent ?? {};
  const menu = (raw.menu ?? {}) as Partial<SessionMenu>;
  return {
    ...EMPTY,
    ...raw,
    items: list(raw.items, EMPTY.items),
    todos: list(raw.todos, EMPTY.todos),
    agents: list(raw.agents, EMPTY.agents),
    beads: list(raw.beads, EMPTY.beads),
    menu: menuOf(menu),
  };
}

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
      next.items = [
        ...items,
        { kind: 'note', id: e.noteId, rank: e.rank, noteKind: e.kind, text: e.text, body: e.body, audience: e.audience },
      ];
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

    case 'agent.started': {
      // Named work: a kit that says the same thing twice — the level list and
      // the edge, which the SDK's own note says may arrive in either order —
      // must not draw two rows for one helper (bw-7ks.22.3).
      const known = view.agents.some((a) => a.id === e.agentId);
      next.agents = known
        ? view.agents.map((a) =>
            a.id === e.agentId
              ? { ...a, toolCallId: a.toolCallId ?? e.toolCallId, what: a.what || e.what, model: a.model ?? e.model }
              : a,
          )
        : [
            ...view.agents,
            {
              id: e.agentId,
              toolCallId: e.toolCallId,
              kind: e.kind,
              what: e.what,
              agentType: e.agentType,
              model: e.model,
              state: 'running' as AgentState,
              startedAt: Date.parse(e.at) || 0,
              seconds: 0,
              tokens: 0,
              calls: 0,
              doing: null,
              result: null,
              relayed: [],
            },
          ];
      return next;
    }

    case 'agent.progress':
      next.agents = view.agents.map((a) =>
        a.id === e.agentId
          ? isOver(a.state)
            ? // A row that is over says what it ended with. Something still
              // sending progress about work that has finished — or that he
              // stopped — must not reopen it as running, nor wind its clock
              // and its figure back to whatever that message happens to carry
              // (bw-7ks.22.30). Only the model is taken, and only if the row
              // never learned one: it is the one fact that arrives late by
              // design.
              { ...a, model: a.model || e.model || null }
            : {
                ...a,
                seconds: e.seconds,
                tokens: e.tokens,
                calls: e.calls,
                // Absent means "still whatever it last said", the same bargain
                // tool.progress makes: a blank line would erase it.
                doing: e.doing || a.doing,
                model: e.model || a.model,
                state: e.state ?? a.state,
              }
          : a,
      );
      return next;

    case 'agent.relayed':
      next.agents = view.agents.map((a) => (a.id === e.agentId ? { ...a, relayed: [...a.relayed, e.text] } : a));
      return next;

    case 'agent.finished':
      next.agents = view.agents.map((a) =>
        a.id === e.agentId
          ? {
              ...a,
              // He stopped it, and that stays said. The kit ends a row twice
              // over — its own notification about the work, and the receipt of
              // the call that dispatched it — and an interrupted call's receipt
              // can land after the notification saying it was stopped. Taking
              // the later one would quietly rewrite what he did into a clean
              // finish, with nothing on the screen to say otherwise
              // (bw-7ks.22.27).
              state: a.state === 'stopped' ? 'stopped' : e.state,
              result: a.state === 'stopped' ? a.result : e.result,
              // The kit's own numbers where it sent them, and what the row
              // already had where it did not: a finished row that blanks its
              // spend is worse than one carrying the last figure it was given.
              seconds: e.seconds || a.seconds,
              tokens: e.tokens || a.tokens,
              calls: e.calls || a.calls,
              model: e.model ?? a.model,
            }
          : a,
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
        {
          kind: 'ask',
          id: e.askId,
          toolName: e.toolName,
          title: e.title,
          options: e.options,
          chosen: null,
          parentId: e.parentToolCallId ?? null,
          askedBy: briefOf(view.agents, e.parentToolCallId ?? null),
        },
      ];
      return next;

    case 'ask.resolved':
      next.items = items.map((it) => (it.kind === 'ask' && it.id === e.askId ? { ...it, chosen: e.chosen } : it));
      return next;

    case 'thinking.progress':
      next.thinkingTokens = e.tokens;
      return next;

    case 'session.menu':
      next.menu = menuOf(e);
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
      next.items = [...next.items, { kind: 'notice', id: `notice-${e.seq}`, text: e.text, family: e.family, audience: e.audience }];
      return next;

    // What follows replaces what came before: a chat re-read under a newer
    // reading of the record republishes its whole transcript, and a browser
    // already drawing the old copy must drop it rather than append (bw-1u1.27).
    // The cards go with it — they are read out of the same record.
    case 'transcript.reset':
      next.items = [];
      next.beads = [];
      next.agents = [];
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
  const agents: SentAway[] = [];
  const agentAt = new Map<string, number>();

  const view: SessionView = { ...EMPTY, items, beads, agents, todos: [] };

  const forget = () => {
    items.length = 0;
    messageAt.clear();
    thinkingAt.clear();
    toolAt.clear();
    askAt.clear();
    reportSeen.clear();
    beads.length = 0;
    beadSeen.clear();
    agents.length = 0;
    agentAt.clear();
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

      case 'agent.started': {
        const at = agentAt.get(e.agentId);
        if (at === undefined) {
          agentAt.set(e.agentId, agents.length);
          agents.push({
            id: e.agentId,
            toolCallId: e.toolCallId,
            kind: e.kind,
            what: e.what,
            agentType: e.agentType,
            model: e.model,
            state: 'running',
            startedAt: Date.parse(e.at) || 0,
            seconds: 0,
            tokens: 0,
            calls: 0,
            doing: null,
            result: null,
            relayed: [],
          });
        } else {
          const row = agents[at]!;
          row.toolCallId = row.toolCallId ?? e.toolCallId;
          row.what = row.what || e.what;
          row.model = row.model ?? e.model;
        }
        break;
      }

      case 'agent.progress': {
        const at = agentAt.get(e.agentId);
        if (at !== undefined) {
          const row = agents[at]!;
          // Over is over here too, for the reason the live arm gives above: a
          // late progress must not reopen a finished row or undo a stop
          // (bw-7ks.22.30).
          if (isOver(row.state)) {
            row.model = row.model || e.model || null;
            break;
          }
          row.seconds = e.seconds;
          row.tokens = e.tokens;
          row.calls = e.calls;
          if (e.doing) row.doing = e.doing;
          if (e.model) row.model = e.model;
          if (e.state) row.state = e.state;
        }
        break;
      }

      case 'agent.relayed': {
        const at = agentAt.get(e.agentId);
        if (at !== undefined) agents[at]!.relayed.push(e.text);
        break;
      }

      case 'agent.finished': {
        const at = agentAt.get(e.agentId);
        if (at !== undefined) {
          const row = agents[at]!;
          // A stop he asked for is final here too, for the reason the live arm
          // gives above: the second ending is the dispatching call's receipt,
          // and it comes back clean whatever became of the work (bw-7ks.22.27).
          const stopped = row.state === 'stopped';
          row.state = stopped ? 'stopped' : e.state;
          row.seconds = e.seconds || row.seconds;
          row.tokens = e.tokens || row.tokens;
          row.calls = e.calls || row.calls;
          row.model = e.model ?? row.model;
          if (!stopped) row.result = e.result;
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
        items.push({ kind: 'note', id: e.noteId, rank: e.rank, noteKind: e.kind, text: e.text, body: e.body, audience: e.audience });
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
        items.push({
          kind: 'ask',
          id: e.askId,
          toolName: e.toolName,
          title: e.title,
          options: e.options,
          chosen: null,
          parentId: e.parentToolCallId ?? null,
          askedBy: briefOf(agents, e.parentToolCallId ?? null),
        });
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
        view.menu = menuOf(e);
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
        items.push({ kind: 'notice', id: `notice-${e.seq}`, text: e.text, family: e.family, audience: e.audience });
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
