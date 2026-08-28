/**
 * Provider-neutral decisions about complete native history.
 *
 * A provider adapter translates bytes, snapshots, or SDK objects. It does not
 * decide whether that complete history may replace or extend Atelier's
 * canonical timeline. Claude, Codex, and future providers all ask here.
 */
import { howToRead, type ReadingChoice } from '../../src/workbench/imported-history.ts';
import type { Store } from './store.ts';

type ReconciliationStore = Pick<Store, 'timelineCount' | 'wasDrivenHere'>;

export function completeHistoryChoice(
  store: ReconciliationStore,
  sessionId: string,
  readBy: number | null,
  live: boolean,
  recordReplaced = false,
): ReadingChoice {
  // A cursor beyond today's EOF names an old generation of the native record.
  // An external-only projection can be rebuilt from that replacement. A
  // locally-driven timeline cannot: it may hold turns that no native record
  // contains, so the ordinary ownership rule below still protects it.
  if (recordReplaced) {
    return store.timelineCount(sessionId) > 0 && store.wasDrivenHere(sessionId)
      ? 'keep-what-it-has'
      : 'read-it';
  }
  return howToRead({
    readBy,
    live,
    // Messages are not the timeline. A command-only turn, a notification, or
    // a helper lifecycle is just as real and must prevent a complete replay
    // from being pasted underneath it.
    drawn: () => store.timelineCount(sessionId),
    drivenHere: () => store.wasDrivenHere(sessionId),
  });
}
