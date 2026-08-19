/**
 * One chat session in the browser: the SSE subscription and the view it folds
 * events into.
 *
 * The transcript is a fold over the event log, and the log replays from seq 0
 * on connect, so history and the live tail are the same code path
 * (docs/agent-workbench.md §4). Nothing is fetched separately for "the past".
 */
'use client';

import { useEffect, useState } from 'react';

import { apiUrl } from '@/lib/api-base';
import type {
  AskOption,
  CommandInfo,
  Cost,
  ImagePayload,
  ModelChoice,
  NoteRank,
  SessionFacts,
  SessionState,
  TodoItem,
  WbpCommand,
  WbpEvent,
} from '@/workbench/protocol';

export interface TranscriptMessage {
  kind: 'message';
  id: string;
  role: 'user' | 'assistant';
  text: string;
  images: ImagePayload[];
  done: boolean;
}

/** What the agent worked out on its way to an answer, as it arrived. */
export interface TranscriptThinking {
  kind: 'thinking';
  id: string;
  text: string;
  done: boolean;
}

export interface TranscriptTool {
  kind: 'tool';
  id: string;
  name: string;
  title: string;
  status: 'running' | 'ok' | 'failed';
  /** How long it has been running, as the brand counts it. */
  seconds: number;
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
      next.items = [...items, { kind: 'message', id: e.messageId, role: e.role, text: '', images: [], done: false }];
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
        : [...items, { kind: 'thinking', id: e.messageId, text: e.text, done: false }];
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
      next.items = items.map((it) =>
        it.kind === 'tool' && it.id === e.toolCallId ? { ...it, seconds: e.seconds } : it,
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
      next.items = [...next.items, { kind: 'notice', id: `notice-${e.seq}`, text: e.text }];
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

/** Reads a picked or pasted file into the shape the protocol carries. */
export function readImage(file: File): Promise<ImagePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read the picture'));
    reader.onload = () =>
      resolve({ mime: file.type, dataUrl: String(reader.result), alt: file.name });
    reader.readAsDataURL(file);
  });
}

export async function sendCommand<T = unknown>(cmd: WbpCommand): Promise<T> {
  const res = await fetch(apiUrl('/api/workbench/command'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`${cmd.type} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * What the open chat says about itself: the cards it has worked on and where it
 * is working. Asked once per chat — the cards come from the board, so a chat
 * begun in a terminal carries them the first time it is opened, not only after
 * this app has watched it work.
 */
export function useSessionFacts(sessionId: string | null): SessionFacts | null {
  const [facts, setFacts] = useState<SessionFacts | null>(null);

  useEffect(() => {
    // Cleared first, so the line never names the chat before this one.
    setFacts(null);
    if (!sessionId) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch(apiUrl(`/api/workbench/session/${encodeURIComponent(sessionId)}`));
        if (live && res.ok) setFacts((await res.json()) as SessionFacts);
      } catch {
        // The header falls back to what the stream itself carries.
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionId]);

  return facts;
}

export function useSession(sessionId: string | null): SessionView {
  // What has been drawn and which chat it was drawn from are one value. Held
  // apart, a second chat folds onto the first chat's messages and its own
  // opening events are skipped as already seen (docs/agent-workbench.md §4.1).
  const [drawn, setDrawn] = useState<{ id: string | null; view: SessionView }>({ id: null, view: EMPTY });

  useEffect(() => {
    setDrawn({ id: sessionId, view: EMPTY });
    if (!sessionId) return;
    const source = new EventSource(apiUrl(`/api/workbench/events?session=${encodeURIComponent(sessionId)}&since=0`));
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as WbpEvent;
      // Late events from the chat just left are dropped by the id, not by luck
      // of ordering: the socket is closed on the way out, but a message already
      // in flight still arrives.
      setDrawn((d) => (d.id === sessionId ? { id: d.id, view: reduce(d.view, event) } : d));
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [sessionId]);

  // Never the last chat's transcript under this chat's name, not even for the
  // one paint between the id changing and the effect running.
  return drawn.id === sessionId ? drawn.view : EMPTY;
}

/** True while the agent owes an answer — the Stop button's condition. */
export function isBusy(state: SessionState): boolean {
  return state === 'thinking' || state === 'streaming' || state === 'running_tool' || state === 'waiting_permission';
}

/**
 * Which chat is open is not a state any component holds: it is in the address,
 * and the chat tab reads it there (docs/designs/app-shell.md §1.7). A hook that
 * kept its own copy answered the first link and then quietly disagreed with
 * every one after it — which is what made an open chat unlinkable and Back do
 * nothing (bw-m8o).
 */
