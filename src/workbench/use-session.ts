/**
 * One chat session in the browser: the SSE subscription and the view it folds
 * events into.
 *
 * The conversation itself — what an event does to it — lives in fold.ts, which
 * the sidecar runs too. Opening a chat is answered with the conversation
 * already built (one `snapshot` frame), and this only folds what has happened
 * since; a stream that drops is opened again from the last event drawn rather
 * than from the beginning of time (docs/agent-workbench.md §4).
 *
 * The connection is not this file's: the chat is one tag on the one connection
 * the window holds, and the number of the last event drawn is what that
 * connection carries when it is asked again (live-wire.ts, bw-zkh4).
 */
'use client';

import { useEffect, useRef, useState } from 'react';

import { request } from '@/lib/api';
import { onChat } from '@/workbench/live-wire';
import { asView, EMPTY, reduce, type SessionView } from '@/workbench/fold';
import type { ImagePayload, SessionFacts, SessionState, WbpCommand, WbpEvent } from '@/workbench/protocol';

export {
  EMPTY,
  foldAll,
  reduce,
  type SessionMenu,
  type SessionView,
  type TranscriptAsk,
  type TranscriptItem,
  type TranscriptMessage,
  type TranscriptNote,
  type TranscriptNotice,
  type TranscriptReport,
  type TranscriptThinking,
  type TranscriptTool,
} from '@/workbench/fold';


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

/**
 * What to put in front of the reader when the sidecar says no.
 *
 * A refusal is often a rule rather than a fault — the chat belongs to another
 * program for the moment (sessions.ts, HELD_ELSEWHERE) — and those are written
 * to be read. The status line is kept only for the failures that carry no words
 * of their own.
 */
async function refusal(res: Response, command: string): Promise<string> {
  const body = await res.text();
  try {
    const said = JSON.parse(body) as { error?: unknown };
    if (typeof said.error === 'string' && said.error) return said.error;
  } catch {
    // Not JSON: the raw body is all there is.
  }
  return `${command} failed: ${res.status} ${body}`;
}

export async function sendCommand<T = unknown>(cmd: WbpCommand): Promise<T> {
  const res = await request('/api/workbench/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(await refusal(res, cmd.type));
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
        const res = await request(`/api/workbench/session/${encodeURIComponent(sessionId)}`);
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

  // The last event drawn, kept where the reconnection can read it. A stream
  // that drops is opened again from here: asking from zero would send the whole
  // conversation a second time, and fold it onto itself.
  const seen = useRef(0);

  useEffect(() => {
    setDrawn({ id: sessionId, view: EMPTY });
    seen.current = 0;
    if (!sessionId) return;

    const draw = (view: SessionView) => {
      seen.current = view.lastSeq;
      // Late events from the chat just left are dropped by the id, not by luck
      // of ordering: the connection is told to stop on the way out, but a
      // message already in flight still arrives.
      setDrawn((d) => (d.id === sessionId ? { id: d.id, view } : d));
    };

    return onChat(sessionId, {
      // What the connection asks from when it is opened, or opened again after
      // a drop. Asking from zero would send the whole conversation a second
      // time, and fold it onto itself.
      since: () => seen.current,

      // The conversation as the sidecar built it — everything said before this
      // browser asked, in one frame. Only the tail is folded here.
      snapshot: (data) => {
        try {
          // Filled against a blank chat rather than trusted: the sidecar is a
          // process that outlives this page, so it can be older than the screen
          // and simply not send a list the screen draws (bw-7ks.22.16).
          draw(asView(JSON.parse(data) as Partial<SessionView>));
        } catch {
          // A frame this page cannot read leaves the transcript as it stands.
        }
      },

      event: (data) => {
        let event: WbpEvent;
        try {
          event = JSON.parse(data) as WbpEvent;
        } catch {
          return;
        }
        setDrawn((d) => {
          if (d.id !== sessionId) return d;
          const view = reduce(d.view, event);
          seen.current = view.lastSeq;
          return { id: d.id, view };
        });
      },
    });
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
