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
  | TranscriptNotice;

export interface SessionView {
  items: TranscriptItem[];
  state: SessionState;
  stateLabel: string;
  cost: Cost | null;
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

const EMPTY: SessionView = {
  items: [],
  state: 'starting',
  stateLabel: 'Starting',
  cost: null,
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
function reduce(view: SessionView, e: WbpEvent): SessionView {
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
        },
      ];
      return next;

    case 'tool.completed':
      next.items = items.map((it) =>
        it.kind === 'tool' && it.id === e.toolCallId ? { ...it, status: e.ok ? 'ok' : 'failed' } : it,
      );
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
      next.permissionMode = e.permissionMode;
      next.model = e.model;
      return next;

    case 'cost':
      next.cost = e.cost;
      return next;

    case 'error':
      next.error = e.message;
      return next;

    case 'notice':
      next.items = [...next.items, { kind: 'notice', id: `notice-${e.seq}`, text: e.text }];
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
