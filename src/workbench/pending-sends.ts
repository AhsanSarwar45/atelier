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

/** The ids of the user messages a transcript holds, as a send's starting mark. */
export function userMessageIds(items: readonly TranscriptItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind === 'message' && item.role === 'user') ids.add(item.id);
  }
  return ids;
}

/**
 * Those sends the transcript has not yet accounted for.
 *
 * `baseline` is the mark taken when the first of these sends went out. A user
 * message outside it is one of them come back.
 */
export function stillPending(
  pending: readonly PendingSend[],
  items: readonly TranscriptItem[],
  baseline: ReadonlySet<string>,
): PendingSend[] {
  let spokenFor = 0;
  for (const item of items) {
    if (item.kind === 'message' && item.role === 'user' && !baseline.has(item.id)) spokenFor += 1;
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
  };
}
