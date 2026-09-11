/**
 * The lines he has sent that the server has not yet spoken back.
 *
 * The transcript is server-authored: a message is drawn from the events the
 * sidecar records, not from the act of pressing Enter. That is what keeps one
 * copy of the conversation rather than two, and it is what lets a send the
 * server refuses leave nothing behind. But it also meant the composer emptied
 * and then nothing happened at all until a whole round trip had finished — the
 * POST, the actor queue, the write, the stream back — so his own line arrived
 * about a second after he sent it (bw-2c0x).
 *
 * A sent line is drawn here in the meantime, and it stands only until the
 * server's own copy of it arrives. The two are matched by counting rather than
 * by id: the id is not known when the line is drawn, and the echo usually
 * reaches the browser BEFORE the reply that names it — the sidecar records the
 * line before it ever prompts the agent. So what is counted is how many user
 * messages the transcript has gained since the first outstanding send, and that
 * many sends are dropped from the front. Sends are answered in the order they
 * were made, so the count is enough to say which.
 */

import type { ImagePayload } from '@/workbench/protocol';
import type { TranscriptItem, TranscriptMessage } from '@/workbench/fold';

/** One line sent and drawn, waiting for the server to say it too. */
export interface PendingSend {
  /** This browser's own name for the row, which no server event ever carries. */
  key: string;
  text: string;
  images: ImagePayload[];
}

/**
 * Everything a transcript holds, as a send's starting mark.
 *
 * Every row, not only the reader's own: the mark has two jobs. It says which
 * user messages were already there, and — because the rows are in order — its
 * last member says where in the transcript the send was made. Older history
 * arriving lands entirely before that point and new rows entirely after it,
 * which is what lets one be told from the other (bw-ad3r.11).
 */
export function transcriptMark(items: readonly TranscriptItem[]): Set<string> {
  return new Set(items.map((item) => item.id));
}

/**
 * Those sends the transcript has not yet accounted for.
 *
 * `baseline` is the mark taken when the first of these sends went out. A user
 * message outside it is one of them come back — but only once it carries what
 * was written. The sidecar records a line as four rows, `message.started` first
 * and the words two later, and each reaches the browser on its own frame. A row
 * that has arrived but is still empty is not yet a copy of anything: standing
 * the drawn line down for it took the reader's words off the screen until the
 * `text.delta` landed, which is the blink this rules out (bw-w29l).
 *
 * `done` is honoured beside the text so that a line that completes empty — no
 * words at all, which nothing this composer sends can be, but which a chat
 * begun elsewhere might — still retires the row rather than stranding it.
 */
export function stillPending(
  pending: readonly PendingSend[],
  items: readonly TranscriptItem[],
  baseline: ReadonlySet<string>,
): PendingSend[] {
  if (pending.length === 0) return [];
  // Only what arrived after the send is a candidate for being its echo.
  //
  // Counting every user message outside the mark counted the wrong ones: the
  // reader scrolling up pulls older history in, that history is full of their
  // own messages, none of them are in the mark, and each one retired a line
  // that was still on its way — so a message vanished from under the person
  // who had just sent it (bw-ad3r.11). Older pages are prepended and new rows
  // appended, so the last row that was there when the send went out is the
  // divide, and only what sits after it is counted.
  let from = 0;
  for (let at = items.length - 1; at >= 0; at -= 1) {
    if (baseline.has(items[at]!.id)) {
      from = at + 1;
      break;
    }
  }
  let spokenFor = 0;
  for (let at = from; at < items.length; at += 1) {
    const item = items[at]!;
    if (item.kind !== 'message' || item.role !== 'user' || baseline.has(item.id)) continue;
    if (item.text !== '' || item.done) spokenFor += 1;
  }
  return pending.slice(spokenFor);
}

/**
 * A pending send as a transcript row.
 *
 * Drawn exactly as the server's copy will be, so the swap when it arrives
 * changes nothing on the screen. A row that announced itself as unsent would
 * put a flicker in the common case — the send that works — to mark the rare one.
 */
export function drawnAsSent(pending: PendingSend): TranscriptMessage {
  return {
    kind: 'message',
    id: pending.key,
    role: 'user',
    text: pending.text,
    images: pending.images,
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
 * Drawn, that is an empty bubble that fills a beat later — the other half of
 * the blink in bw-w29l, and worth nothing to the reader even where no line was
 * drawn ahead of it, as in a chat this browser did not send into.
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
