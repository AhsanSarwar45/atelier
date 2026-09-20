/**
 * Which projects a reader is offered as a quick way out of the one he is in.
 *
 * The bar's name opens this list (`src/components/project-switcher.tsx`). What
 * it answers is "where else have I been lately", so the order is the order the
 * server already keeps — `last_opened DESC`, written by the touch every visit
 * makes — and the list is short on purpose: a phone sheet of every project is
 * the project list screen, which the house beside the name already goes to.
 *
 * The sort is done here as well as in the query because this is what the rule
 * IS. A caller handing over a list from anywhere — a cache, a test, a future
 * endpoint that orders by name — gets the same answer as one handing over the
 * endpoint's own.
 */
import type { Project } from '@/types';

/** How many are offered before the list becomes a screen of its own. */
export const RECENT_LIMIT = 5;

export function recentOthers<T extends Pick<Project, 'id' | 'lastOpened' | 'archivedAt'>>(
  projects: readonly T[],
  currentId: string | null,
  limit: number = RECENT_LIMIT,
): T[] {
  return projects
    .filter((p) => p.id !== currentId && !p.archivedAt)
    .slice()
    .sort((a, b) => (b.lastOpened ?? '').localeCompare(a.lastOpened ?? ''))
    .slice(0, Math.max(0, limit));
}
