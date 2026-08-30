/**
 * The cards this project actually has, shared by every part of chat that needs
 * to recognise an id or colour it by status.
 *
 * There is one small store, one board subscription and one read per project.
 * A board-change frame refreshes the map and React redraws every chip that
 * reads it; individual transcript badges never poll or subscribe.
 */
'use client';

import { useCallback, useSyncExternalStore } from 'react';

import * as api from '@/lib/api';
import { loadProjectBeads } from '@/lib/beads-parser';
import type { BeadStatus } from '@/types';

/** Keep an unused answer briefly so switching chats does not reread the board. */
const KEPT_MS = 60_000;

interface CardIndex {
  ids: ReadonlySet<string>;
  statuses: ReadonlyMap<string, BeadStatus>;
}

interface CardStore {
  snapshot: CardIndex;
  listeners: Set<() => void>;
  loadedAt: number;
  loading: Promise<void> | null;
  changedWhileLoading: boolean;
  stop: (() => void) | null;
}

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_STATUSES: ReadonlyMap<string, BeadStatus> = new Map<string, BeadStatus>();
const EMPTY: CardIndex = { ids: EMPTY_IDS, statuses: EMPTY_STATUSES };
const stores = new Map<string, CardStore>();

function storeFor(projectPath: string): CardStore {
  let store = stores.get(projectPath);
  if (!store) {
    store = { snapshot: EMPTY, listeners: new Set(), loadedAt: 0, loading: null, changedWhileLoading: false, stop: null };
    stores.set(projectPath, store);
  }
  return store;
}

function read(projectPath: string, store: CardStore, force = false): Promise<void> {
  if (store.loading) {
    if (force) store.changedWhileLoading = true;
    return store.loading;
  }
  if (!force && store.loadedAt && Date.now() - store.loadedAt < KEPT_MS) return Promise.resolve();

  store.loading = loadProjectBeads(projectPath)
    .then((beads) => {
      const statuses = new Map(beads.map((bead) => [bead.id, bead.status]));
      store.snapshot = { ids: new Set(statuses.keys()), statuses };
      store.loadedAt = Date.now();
      store.listeners.forEach((notify) => notify());
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

function subscribe(projectPath: string, notify: () => void): () => void {
  const store = storeFor(projectPath);
  store.listeners.add(notify);
  if (!store.stop) {
    store.stop = api.watch.beads(projectPath, () => {
      void read(projectPath, store, true);
    });
  }
  void read(projectPath, store);

  return () => {
    store.listeners.delete(notify);
    if (store.listeners.size === 0) {
      store.stop?.();
      store.stop = null;
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
