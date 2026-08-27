import { foldAll, type SessionView, type TranscriptTool } from '../../src/workbench/fold.ts';
import { whatItRan } from '../../src/workbench/said-what-it-ran.ts';
import { boundedEvent } from './bounded-event.ts';
import type { Store } from './store.ts';

/** User turns per server page. Their replies, tools and thinking come intact. */
export const TRANSCRIPT_WINDOW = 20;

/**
 * Fold one storage window without cutting it a second time.
 *
 * Storage has already selected complete row anchors. A message may fold into
 * two rows (its answer and its thinking), so slicing the folded result to the
 * same numeric limit can discard the message that owns a retained thinking
 * row. In practice that made the human half of older conversations disappear.
 */
export function transcriptPage(store: Store, sessionId: string, before: number | null): {
  items: SessionView['items']; cursor: number | null; hasOlder: boolean; newestSeq: number;
} {
  const page = store.transcriptWindow(sessionId, before, TRANSCRIPT_WINDOW);
  const folded = foldAll(page.events.map(boundedEvent));
  return {
    items: folded.items.map((item) => {
      if (item.kind !== 'tool') return item;
      const ran = whatItRan(item.name, item.input);
      return {
        ...item,
        input: {},
        output: null,
        diff: null,
        detailsDeferred: true,
        ranKind: ran?.kind,
        ranGrave: ran?.grave,
      } satisfies TranscriptTool;
    }),
    cursor: page.cursor,
    hasOlder: page.hasOlder,
    newestSeq: page.newestSeq,
  };
}
