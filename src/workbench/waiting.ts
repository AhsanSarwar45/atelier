/**
 * What waits on the owner besides a chat's own permission question: a task in
 * review, a task proposal, a plan change, a grid draft and an N/A request
 * (server, `workbench::waiting`).
 *
 * One list for the whole app, read once and kept current from the live feed,
 * so the composer bar, the rail, the project list and the Tasks tab cannot
 * disagree about what is waiting. Every change to a task or grid is announced
 * on the `workbench` feed, and any of them can start or end a wait, so any of
 * them reads the list again; a dropped connection may have missed one, so the
 * first frame after it does too.
 */
'use client';

import { useSyncExternalStore } from 'react';

import { request } from '@/lib/api';
import { onWorkbench } from '@/workbench/live-wire';

export type WaitingKind = 'review' | 'proposal' | 'amend' | 'grid_draft' | 'na';

/** One thing waiting on the owner, as the server hands it over. */
export interface Waiting {
  /** One occurrence of it: a task handed in again is a new key. */
  key: string;
  kind: WaitingKind;
  projectId: string;
  /** The chat the answer goes back to, when one does. */
  sessionId: string | null;
  task: number | null;
  proposal: number | null;
  grid: string | null;
  row: string | null;
  col: string | null;
  title: string;
  /** "#11 is ready for review", "Proposal: …", "Plan change for #4", … */
  says: string;
  /** The shorter words the tray uses beside the chat's name. */
  short: string;
  /** When it started waiting, in milliseconds. */
  since: number;
}

export async function readWaiting(projectId?: string): Promise<Waiting[]> {
  const query = projectId ? `?project=${encodeURIComponent(projectId)}` : '';
  const answer = await request(`/api/workbench/waiting${query}`);
  if (!answer.ok) throw new Error(`what is waiting could not be read: ${answer.status}`);
  return (await answer.json()) as Waiting[];
}

const NONE: Waiting[] = [];
let items: Waiting[] = NONE;
const listeners = new Set<() => void>();
let stopFeed: (() => void) | null = null;
let missed = false;
let asking: Promise<void> | null = null;
let again = false;

function tell() {
  for (const listener of listeners) listener();
}

/** Read the list again; a change arriving mid-read reads once more after. */
function reload(): void {
  if (asking) {
    again = true;
    return;
  }
  asking = readWaiting()
    .then((found) => {
      // Only what reads as an item: a list that is not one draws nothing.
      items = Array.isArray(found) ? found.filter((item) => typeof item?.key === 'string' && typeof item?.kind === 'string') : NONE;
      tell();
    })
    .catch(() => {
      // Kept as it was: a list that cannot be read is not an empty one, and
      // the next change asks again.
    })
    .finally(() => {
      asking = null;
      if (again) {
        again = false;
        reload();
      }
    });
}

/** Whether a frame on the feed can have started or ended a wait. */
export function changesWaiting(data: string): boolean {
  return data.includes('tasks.changed') || data.includes('grids.changed');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopFeed) {
    stopFeed = onWorkbench({
      frame: (data) => {
        if (missed || changesWaiting(data)) {
          missed = false;
          reload();
        }
      },
      dropped: () => { missed = true; },
    });
    reload();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopFeed) {
      stopFeed();
      stopFeed = null;
    }
  };
}

/** Ask again now, for a screen that has just answered one. */
export function refreshWaiting(): void {
  if (stopFeed) reload();
}

/** Everything waiting on the owner, in every project, oldest first. */
export function useWaiting(): Waiting[] {
  return useSyncExternalStore(subscribe, () => items, () => NONE);
}

/** For tests: start over with nothing read. */
export function resetWaitingForTests(next: Waiting[] = NONE): void {
  items = next;
  tell();
}

export function waitingInChat(all: Waiting[], sessionId: string | null | undefined): Waiting[] {
  return sessionId ? all.filter((item) => item.sessionId === sessionId) : NONE;
}

export function waitingInProject(all: Waiting[], projectId: string | null | undefined): Waiting[] {
  return projectId ? all.filter((item) => item.projectId === projectId) : NONE;
}

/** How many wait in each project, by id. */
export function countsByProject(all: Waiting[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of all) counts.set(item.projectId, (counts.get(item.projectId) ?? 0) + 1);
  return counts;
}

/**
 * The word a chat's row says: "Review" for one review and nothing else,
 * otherwise "Waiting for you". Null when nothing waits.
 */
export function badgeWord(inChat: Waiting[]): string | null {
  if (inChat.length === 0) return null;
  return inChat.length === 1 && inChat[0].kind === 'review' ? 'Review' : 'Waiting for you';
}
