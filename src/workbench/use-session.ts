/**
 * One chat session in the browser: the SSE subscription and the view it folds
 * events into.
 *
 * The transcript is a fold over the event log, and the log replays from seq 0
 * on connect, so history and the live tail are the same code path
 * (docs/agent-workbench.md §4). Nothing is fetched separately for "the past".
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiUrl } from '@/lib/api-base';
import type {
  AskOption,
  Cost,
  ImagePayload,
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

export interface TranscriptTool {
  kind: 'tool';
  id: string;
  name: string;
  title: string;
  status: 'running' | 'ok' | 'failed';
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

export interface TranscriptReport {
  kind: 'report';
  id: string;
  project: string;
  slug: string;
}

export type TranscriptItem = TranscriptMessage | TranscriptTool | TranscriptAsk | TranscriptReport;

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
  error: string | null;
  lastSeq: number;
}

const EMPTY: SessionView = {
  items: [],
  state: 'starting',
  stateLabel: 'Starting',
  cost: null,
  todos: [],
  beads: [],
  permissionMode: null,
  model: null,
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

    case 'message.completed':
      next.items = items.map((it) =>
        it.kind === 'message' && it.id === e.messageId ? { ...it, done: true } : it,
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

    case 'cost':
      next.cost = e.cost;
      return next;

    case 'error':
      next.error = e.message;
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

export function useSession(sessionId: string | null): SessionView {
  const [view, setView] = useState<SessionView>(EMPTY);
  // Read inside the effect only, so a reconnect resumes without re-subscribing.
  const seqRef = useRef(0);

  useEffect(() => {
    if (!sessionId) {
      setView(EMPTY);
      seqRef.current = 0;
      return;
    }
    const source = new EventSource(apiUrl(`/api/workbench/events?session=${encodeURIComponent(sessionId)}&since=${seqRef.current}`));
    source.onmessage = (msg) => {
      const event = JSON.parse(msg.data) as WbpEvent;
      seqRef.current = Math.max(seqRef.current, event.seq);
      setView((v) => reduce(v, event));
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [sessionId]);

  return view;
}

/** True while the agent owes an answer — the Stop button's condition. */
export function isBusy(state: SessionState): boolean {
  return state === 'thinking' || state === 'streaming' || state === 'running_tool' || state === 'waiting_permission';
}

/**
 * `openSessionId` attaches to a session that already exists instead of opening
 * a new one — how a link from a card, the tray or the sidebar lands on a chat.
 */
export function useStartSession(
  projectId: string | null,
  projectPath: string | null,
  openSessionId?: string | null,
) {
  const [sessionId, setSessionId] = useState<string | null>(openSessionId ?? null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (openSessionId) setSessionId(openSessionId);
  }, [openSessionId]);

  const start = useCallback(async () => {
    if (!projectId || !projectPath) return;
    setStarting(true);
    setError(null);
    try {
      const s = await sendCommand<{ id: string }>({
        type: 'session.start',
        projectId,
        projectPath,
        brand: 'claude',
      });
      setSessionId(s.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }, [projectId, projectPath]);

  return { sessionId, start, starting, error };
}
