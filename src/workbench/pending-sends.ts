/**
 * Where each line the reader has written is drawn while it is on its way.
 *
 * The transcript is server-authored: a message is drawn from the events the
 * sidecar records, not from the act of pressing Enter. But a whole round trip
 * — the POST, the actor queue, the write, the stream back — made his own line
 * arrive about a second after he sent it (bw-2c0x), so a sent line is drawn
 * straight away and stands until the server's own copy arrives.
 *
 * A line has one id from the moment it is written: the composer names it, the
 * server keeps that name for the held row and for the recorded message
 * (registry.rs, `message_id`). So each line is drawn in exactly one place, and
 * the place follows from what the server has said about that id:
 *
 * - recorded in the transcript: drawn there, and nowhere else;
 * - held and waiting: drawn in the queue;
 * - otherwise — just sent, or pushed into a turn that is ending for it: drawn
 *   as sent, at the end of the transcript.
 *
 * Nothing is matched by counting or by text, and a line never moves from the
 * transcript to the queue and back.
 */

import type { HeldMessage, ImagePayload } from '@/workbench/protocol';
import type { TranscriptItem, TranscriptMessage } from '@/workbench/fold';

/** One line sent and drawn, waiting for the server to say it too. */
export interface PendingSend {
  /** The message's id, chosen here and kept by the server. */
  id: string;
  text: string;
  images: ImagePayload[];
}

/** Where the reader's unrecorded lines are drawn. */
export interface LinesInFlight {
  /** Drawn as sent, after the transcript's own rows, in the order they were sent. */
  sent: TranscriptMessage[];
  /** Drawn in the queue. */
  waiting: HeldMessage[];
  /** The pending sends still drawn here; the rest can be let go. */
  outstanding: PendingSend[];
}

/** Places every line the reader has written that the transcript does not yet show. */
export function linesInFlight(
  pending: readonly PendingSend[],
  items: readonly TranscriptItem[],
  held: readonly HeldMessage[],
): LinesInFlight {
  const recorded = new Set(items.filter(worthDrawing).map((item) => item.id));
  const waiting = held.filter((line) => !line.pushed && !recorded.has(line.id));
  const inQueue = new Set(waiting.map((line) => line.id));
  const outstanding = pending.filter((line) => !recorded.has(line.id) && !inQueue.has(line.id));
  const drawn = new Set(outstanding.map((line) => line.id));
  // Pushed from another window, or before a reload: the server's word alone.
  const pushed = held.filter((line) => line.pushed && !recorded.has(line.id) && !drawn.has(line.id));
  return { sent: [...outstanding, ...pushed].map(drawnAsSent), waiting, outstanding };
}

/**
 * A line as a transcript row.
 *
 * Drawn exactly as the server's copy will be, so the swap when it arrives
 * changes nothing on the screen. A row that announced itself as unsent would
 * put a flicker in the common case — the send that works — to mark the rare one.
 */
function drawnAsSent(line: Pick<PendingSend, 'id' | 'text' | 'images'>): TranscriptMessage {
  return {
    kind: 'message',
    id: line.id,
    role: 'user',
    text: line.text,
    images: line.images,
    done: true,
    parentId: null,
    composedHere: true,
  };
}

/**
 * Whether a transcript row has anything to show yet.
 *
 * A user message is built from `message.started` before the frame carrying its
 * words arrives, so for a moment the transcript holds a row that says nothing.
 * Drawn, that is an empty bubble that fills a beat later (bw-w29l), and worth
 * nothing to the reader even where no line was drawn ahead of it, as in a chat
 * this browser did not send into. Until it says something, the line drawn for
 * it stands in its place.
 *
 * Only the reader's own rows are held back. An assistant message legitimately
 * begins empty and fills as it is written, and watching it do that is the point.
 * A row carrying pictures says something without words, and one that has
 * finished is as complete as it will ever be.
 */
export function worthDrawing(item: TranscriptItem): boolean {
  if (item.kind !== 'message' || item.role !== 'user') return true;
  return item.text !== '' || item.images.length > 0 || item.done;
}
