/**
 * What a reader who has scrolled back keeps when the sidecar speaks again.
 *
 * The opening snapshot is the newest window the server holds, and publishing it
 * as-is threw away every older page this browser had already fetched — so a
 * reconnection, or a sidecar that restarted, jumped the transcript forwards and
 * took what they were reading with it (bw-ad3r.12).
 */
import { describe, expect, it } from 'vitest';

import { EMPTY, type SessionView } from '@/workbench/fold';
import { keepingHistoryAlreadyRead } from '@/workbench/use-session';

const said = (id: string): SessionView['items'][number] =>
  ({ kind: 'message', id, role: 'user', text: id, images: [], done: true, parentId: null }) as SessionView['items'][number];

const view = (ids: string[], rest: Partial<SessionView> = {}): SessionView =>
  ({ ...EMPTY, items: ids.map(said), ...rest });

describe('a snapshot arriving under history already read', () => {
  it('keeps the older pages above it, and how far back they reached', () => {
    const had = view(['page-back-1', 'page-back-2', 'window-1', 'window-2'], {
      historyCursor: 11,
      hasOlder: true,
    });
    const fresh = view(['window-1', 'window-2', 'window-3'], { historyCursor: 40, hasOlder: true, lastSeq: 9 });

    const joined = keepingHistoryAlreadyRead(had, fresh);

    expect(joined.items.map((item) => item.id)).toEqual([
      'page-back-1', 'page-back-2', 'window-1', 'window-2', 'window-3',
    ]);
    expect(joined.historyCursor).toBe(11);
    expect(joined.lastSeq).toBe(9);
  });

  it('stands alone when the new window reaches back no further than it does', () => {
    const had = view(['window-1', 'window-2']);
    const fresh = view(['window-1', 'window-2', 'window-3']);
    expect(keepingHistoryAlreadyRead(had, fresh).items.map((item) => item.id))
      .toEqual(['window-1', 'window-2', 'window-3']);
  });

  it('stands alone when the two do not meet at all', () => {
    const had = view(['long-ago-1', 'long-ago-2']);
    const fresh = view(['much-later-1', 'much-later-2']);
    expect(keepingHistoryAlreadyRead(had, fresh).items.map((item) => item.id))
      .toEqual(['much-later-1', 'much-later-2']);
  });

  it('stands alone on a chat opened for the first time', () => {
    const fresh = view(['window-1']);
    expect(keepingHistoryAlreadyRead(EMPTY, fresh).items.map((item) => item.id)).toEqual(['window-1']);
  });
});
