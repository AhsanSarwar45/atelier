/**
 * The cards this project actually has, shared by every part of chat that needs
 * to recognise an id or colour it by status.
 *
 * There is one small store, one board subscription and one read per project.
 * A board-change frame refreshes the map and React redraws every chip that
 * reads it; individual transcript badges never poll or subscribe.
 *
 * The store keeps up with the board the way the board page does (bw-pq2a.2):
 * after the first read it asks only for what changed since, and on a board
 * kept in Dolt it asks again every few seconds whether or not a change frame
 * arrived. The helper only re-reads a Dolt board when a screen asks for
 * it, so a chat left open with no board tab beside it would otherwise wear the
 * colours it was born with for as long as it stayed open.
 */
'use client';

import { useCallback, useSyncExternalStore } from 'react';

import * as api from '@/lib/api';
import { loadProjectBeads } from '@/lib/beads-parser';
import { isDoltProject } from '@/lib/utils';
import type { BeadStatus } from '@/types';

/** How often a Dolt-backed board is asked again, the same period the board page uses. */
export const BACKSTOP_POLL_MS = 15_000;

/** Keep an unused answer briefly so switching chats does not reread the board. */
const KEPT_MS = BACKSTOP_POLL_MS;

interface CardIndex {
  ids: ReadonlySet<string>;
  statuses: ReadonlyMap<string, BeadStatus>;
}

interface CardStore {
  snapshot: CardIndex;
  listeners: Set<() => void>;
  loadedAt: number;
  /** The newest stamp seen so far, so the next read asks only for what moved since. */
  lastUpdated: string | null;
  /** Where the board came from, as the helper reports it (`cli`, `dolt`, ...). */
  source: string | null;
  loading: Promise<void> | null;
  changedWhileLoading: boolean;
  stop: (() => void) | null;
  backstop: ReturnType<typeof setInterval> | null;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_STATUSES: ReadonlyMap<string, BeadStatus> = new Map<string, BeadStatus>();
const EMPTY: CardIndex = { ids: EMPTY_IDS, statuses: EMPTY_STATUSES };
const stores = new Map<string, CardStore>();

function storeFor(projectPath: string): CardStore {
  let store = stores.get(projectPath);
  if (!store) {
    store = {
      snapshot: EMPTY,
      listeners: new Set(),
      loadedAt: 0,
      lastUpdated: null,
      source: null,
      loading: null,
      changedWhileLoading: false,
      stop: null,
      backstop: null,
    };
    stores.set(projectPath, store);
  }
  return store;
}

/**
 * Whether this board is one the helper re-reads only when asked. A board kept
 * in a `.beads/issues.jsonl` file is watched reliably; one kept in Dolt — by a
 * server, by beads itself (which the helper reads through `bd` and reports as
 * `cli`), or addressed as `dolt://` — is not, so it is asked again on a clock.
 * The helper answers from the board it holds and reads behind that answer, so
 * asking costs it one real read per memo period, however many chats ask.
 */
function needsBackstop(projectPath: string, store: CardStore): boolean {
  if (isDoltProject(projectPath)) return true;
  return store.source !== null && store.source !== 'jsonl';
}

function read(projectPath: string, store: CardStore, force = false): Promise<void> {
  if (store.loading) {
    if (force) store.changedWhileLoading = true;
    return store.loading;
  }
  if (!force && store.loadedAt && Date.now() - store.loadedAt < KEPT_MS) return Promise.resolve();

  const updatedAfter = store.loadedAt ? store.lastUpdated ?? undefined : undefined;
  store.loading = loadProjectBeads(projectPath, { withSource: true, updatedAfter })
    .then(({ beads, source }) => {
      // The first answer is the whole board; every later one is only what
      // moved since, folded into what was already known.
      const statuses = updatedAfter ? new Map(store.snapshot.statuses) : new Map<string, BeadStatus>();
      let newest = store.lastUpdated ?? '';
      for (const bead of beads) {
        statuses.set(bead.id, bead.status);
        const stamp = bead.updated_at || bead.created_at || '';
        if (stamp > newest) newest = stamp;
      }
      store.snapshot = { ids: new Set(statuses.keys()), statuses };
      store.loadedAt = Date.now();
      store.lastUpdated = newest || null;
      store.source = source ?? null;
      store.listeners.forEach((notify) => notify());
      keepAsking(projectPath, store);
    })
    // An unreadable board leaves the last good answer on screen. On first
    // paint that answer is empty, so ordinary words are still drawn plainly.
    .catch(() => undefined)
    .finally(() => {
      store.loading = null;
      if (store.changedWhileLoading) {
        store.changedWhileLoading = false;
        void read(projectPath, store, true);
      }
    });
  return store.loading;
}

/** Starts the backstop once the board has said where it comes from, while anyone is listening. */
function keepAsking(projectPath: string, store: CardStore): void {
  if (store.backstop || store.listeners.size === 0 || !needsBackstop(projectPath, store)) return;
  store.backstop = setInterval(() => {
    void read(projectPath, store, true);
  }, BACKSTOP_POLL_MS);
}

function stopAsking(store: CardStore): void {
  if (store.backstop) clearInterval(store.backstop);
  store.backstop = null;
}

function subscribe(projectPath: string, notify: () => void): () => void {
  const store = storeFor(projectPath);
  store.listeners.add(notify);
  if (!store.stop) {
    store.stop = api.watch.beads(projectPath, () => {
      void read(projectPath, store, true);
    });
  }
  keepAsking(projectPath, store);
  void read(projectPath, store);

  return () => {
    store.listeners.delete(notify);
    if (store.listeners.size === 0) {
      store.stop?.();
      store.stop = null;
      stopAsking(store);
    }
  };
}

function useCardIndex(projectPath: string | null): CardIndex {
  const listen = useCallback(
    (notify: () => void) => projectPath ? subscribe(projectPath, notify) : () => {},
    [projectPath],
  );
  const snapshot = useCallback(
    () => projectPath ? storeFor(projectPath).snapshot : EMPTY,
    [projectPath],
  );
  return useSyncExternalStore(
    listen,
    snapshot,
    () => EMPTY,
  );
}

/** The ids, empty until the shared board read arrives. */
export function useKnownCards(projectPath: string | null): ReadonlySet<string> {
  return useCardIndex(projectPath).ids;
}

/** Current status by id, updated from the window's shared board-change wire. */
export function useKnownCardStatuses(projectPath: string | null): ReadonlyMap<string, BeadStatus> {
  return useCardIndex(projectPath).statuses;
}
