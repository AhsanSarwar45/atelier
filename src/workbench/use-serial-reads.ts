'use client';

/**
 * One read at a time, and never a queue of them (bw-g3o3.3).
 *
 * The rule the Git rail worked out first: a change on disk does not arrive as
 * one event but as a burst of them — a push writes several refs, a commit
 * writes several files, an `npm install` writes thousands. Reading once per
 * event would mean several runs racing each other, and the last one to *answer*
 * — not the last one to be asked — deciding what is on screen.
 *
 * So a read asked for while one is in flight queues exactly one more behind it,
 * which is enough: that queued read asks the server afresh, so it sees
 * everything the events before it were about.
 *
 * What each caller is asking about rides along. The repository readers ask
 * about nothing in particular (they re-read the whole of what they draw), and
 * the file tree asks about the paths that moved; whatever the queued asks
 * gathered while the first read was running is handed to the one run that
 * answers them all, so nothing a burst named is quietly dropped.
 */

import { useCallback, useRef } from 'react';

/**
 * Wrap `read` so it never runs twice at once.
 *
 * Keep `read` stable with `useCallback`, the way an effect's dependency wants;
 * it is depended on here.
 */
export function useSerialReads<T>(
  read: (gathered: T[]) => Promise<void>,
): (gather?: readonly T[]) => Promise<void> {
  const busyReading = useRef(false);
  const oneMore = useRef(false);
  const gathering = useRef<T[]>([]);

  return useCallback(
    async (gather?: readonly T[]) => {
      if (gather && gather.length > 0) gathering.current.push(...gather);
      if (busyReading.current) {
        oneMore.current = true;
        return;
      }
      busyReading.current = true;
      try {
        do {
          oneMore.current = false;
          const taken = gathering.current;
          gathering.current = [];
          await read(taken);
        } while (oneMore.current);
      } finally {
        busyReading.current = false;
      }
    },
    [read],
  );
}
