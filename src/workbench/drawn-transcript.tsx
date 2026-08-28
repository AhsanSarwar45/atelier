/**
 * The messages a conversation puts on the page: the newest screenfuls, and more
 * of the older ones as the reader pulls them down.
 *
 * A chat drew every message it had ever held. Two thousand of them is forty
 * thousand pieces of screen and just under three seconds before the first word
 * is readable — paid on every open, for a conversation whose reader is looking
 * at the last screenful of it (bw-2lzj.2, the half of bw-uiyz.10 that was
 * closed by merging it into another card and never built).
 *
 * Newest first is what a chat is: it opens at the bottom, and history is
 * reached by scrolling up. So the window is anchored at the END and grows
 * upwards — the same shape as the chat list's own screenful-at-a-time
 * (chat-sidebar.tsx), turned over.
 */
'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { Mentions } from '@/components/markdown-body';
import type { DrawnRow } from '@/workbench/machine-lines';
import type { LookableImage } from '@/workbench/protocol';
import { MachineLine, TranscriptRow } from '@/workbench/transcript-rows';

/**
 * How many rows are drawn at rest, and how many more each pull adds.
 *
 * Two screenfuls at the widest the chat is drawn: enough that the reader can
 * scroll a page back without waiting for anything to arrive.
 */
export const SCREENFUL = 40;
/** Ordinary conversations average one user and one assistant row per turn. */
export const TURNFUL = 20;

interface SemanticTurn {
  id: string;
  rows: DrawnRow[];
  anchor: number;
}

/**
 * Root user prompts are the stable navigation units. Commands, notifications,
 * thinking and child-agent rows belong to the turn after that prompt; their
 * volume must not decide how many conversational turns are reachable.
 */
export function semanticTurns(rows: DrawnRow[]): SemanticTurn[] {
  const starts = rows.flatMap((row, index) => row.row === 'other'
    && row.item.kind === 'message'
    && row.item.role === 'user'
    && row.item.parentId === null
    ? [index]
    : []);
  if (!starts.length) return [];
  return starts.map((start, index) => {
    const from = index === 0 ? 0 : start;
    const through = starts[index + 1] ?? rows.length;
    const prompt = rows[start]!;
    return {
      id: prompt.row === 'other' ? prompt.item.id : `turn-${start}`,
      rows: rows.slice(from, through),
      anchor: start - from,
    };
  });
}

interface DrawnTranscriptProps {
  rows: DrawnRow[];
  /** Which chat this is, so opening another starts at its own end. */
  sessionId: string;
  mentions: Mentions;
  onLook: (image: LookableImage) => void;
  /** The pane these rows scroll inside, whose place must be kept as they grow. */
  pane: React.RefObject<HTMLElement | null>;
  /** Whether the end of the conversation is what the reader is watching. */
  held: boolean;
  /** Fetches the preceding server window; null when the beginning is loaded. */
  onOlder?: (() => Promise<{ added: number; hasOlder: boolean }>) | null;
}

export function DrawnTranscript({ rows, sessionId, mentions, onLook, pane, held, onOlder = null }: DrawnTranscriptProps) {
  const turns = semanticTurns(rows);
  const semantic = turns.length > 0;
  const many = semantic ? turns.length : rows.length;
  const batch = semantic ? TURNFUL : SCREENFUL;
  const [shown, setShown] = useState(batch);
  const [turnCaps, setTurnCaps] = useState<Record<string, number>>({});
  const head = useRef<HTMLDivElement | null>(null);
  /** How tall the pane's contents were when the last batch was asked for. */
  const wasTall = useRef<number | null>(null);
  /** A visible head is one request, even when prepending rows redraws it. */
  const atHead = useRef(false);
  const loading = useRef(false);
  const current = useRef({ shown, many, onOlder, batch });
  current.current = { shown, many, onOlder, batch };
  /** Which conversation these rows were, and how many of them, on the last frame. */
  const was = useRef({ sessionId, many, semantic });

  // A window of the last N rows slides forward as messages arrive: every one
  // that joins the bottom pushes one off the top. For a reader watching the end
  // that is invisible and is the whole point of it — but a reader who has
  // scrolled up is reading rows near that top edge, and they were being deleted
  // out from under him while the pane stayed exactly where it was (bw-n6yh.7).
  // So while he is away the window's TOP is what is held still, and it takes
  // back whatever arrived; coming back to the end lets it start sliding again.
  let count = shown;
  if (was.current.sessionId !== sessionId || was.current.semantic !== semantic) count = batch;
  else if (!held && many > was.current.many) count = shown + (many - was.current.many);
  was.current = { sessionId, many, semantic };
  if (count !== shown) setShown(count);
  const hasHead = count < many || onOlder !== null;

  useEffect(() => setTurnCaps({}), [sessionId]);

  useEffect(() => {
    atHead.current = false;
    loading.current = false;
    const mark = head.current;
    if (!mark) return;
    const watch = new IntersectionObserver((entries) => {
      const touching = entries.some((e) => e.isIntersecting);
      if (!touching) {
        atHead.current = false;
        return;
      }
      if (atHead.current || loading.current) return;
      atHead.current = true;
      wasTall.current = pane.current?.scrollHeight ?? null;
      if (current.current.shown < current.current.many) {
        setShown((n) => n + current.current.batch);
        return;
      }
      if (!current.current.onOlder) return;
      loading.current = true;
      void (async () => {
        // One visit to the head should reveal a useful batch, not one tiny
        // storage page. Cursor loading remains single-flight in use-session;
        // this bounded loop only fills one screenful and can never replay the
        // whole transcript in one visit.
        let added = 0;
        while (added < SCREENFUL) {
          const older = current.current.onOlder;
          if (!older) break;
          wasTall.current ??= pane.current?.scrollHeight ?? null;
          const page = await older();
          if (page.added <= 0) break;
          added += page.added;
          if (!page.hasOlder) break;
        }
      })().finally(() => {
        loading.current = false;
      });
    });
    watch.observe(mark);
    return () => watch.disconnect();
  }, [sessionId, pane, hasHead]);

  // Older messages arrive ABOVE where the reader is looking, which would slide
  // the words he is reading down the screen by however tall they are. Put back
  // exactly what was added, before the browser has drawn a frame.
  useLayoutEffect(() => {
    const box = pane.current;
    const before = wasTall.current;
    wasTall.current = null;
    if (!box || before === null) return;
    box.scrollTop += box.scrollHeight - before;
  }, [shown, rows.length, pane]);

  const selectedTurns = semantic
    ? (count >= turns.length ? turns : turns.slice(turns.length - count))
    : [];
  const window = semantic ? [] : count >= rows.length ? rows : rows.slice(rows.length - count);

  const draw = (drawnRow: DrawnRow) =>
    drawnRow.row === 'machine' ? (
      <MachineLine key={drawnRow.id} row={drawnRow} />
    ) : (
      <TranscriptRow
        key={drawnRow.item.id}
        item={drawnRow.item}
        sessionId={sessionId}
        mentions={mentions}
        onLook={onLook}
      />
    );

  return (
    <>
      {hasHead && (
        <div ref={head} data-testid="older-messages" className="h-px shrink-0" aria-hidden="true" />
      )}
      {semantic ? selectedTurns.map((turn) => {
        const cap = turnCaps[turn.id] ?? SCREENFUL;
        const anchor = turn.rows[turn.anchor]!;
        const clipped = turn.rows.length > cap;
        const tail = clipped ? turn.rows.slice(-(cap - 1)) : turn.rows;
        const shownRows = clipped && !tail.includes(anchor) ? [anchor, ...tail] : tail;
        const hidden = turn.rows.length - shownRows.length;
        return (
          <div key={turn.id} data-testid="semantic-turn" data-turn-id={turn.id} className="contents">
            {hidden > 0 && (
              <button
                type="button"
                data-testid="hidden-turn-rows"
                className="w-full py-1 text-left text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setTurnCaps((caps) => ({ ...caps, [turn.id]: cap + SCREENFUL }))}
              >
                Show {Math.min(SCREENFUL, hidden)} more of {hidden} earlier operations in this turn
              </button>
            )}
            {shownRows.map(draw)}
          </div>
        );
      }) : window.map(draw)}
    </>
  );
}
