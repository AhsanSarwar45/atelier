/**
 * The cards a chat touched, named by the job rather than by every piece of it.
 *
 * A session that works one job touches a dozen of its pieces, and a column of
 * `bw-uiyz.1 bw-uiyz.8 bw-uiyz.7 …` says the same word a dozen times to say one
 * thing: this chat worked on bw-uiyz. The pieces are not lost — they ride in the
 * chip's tooltip, and the chip opens the job, which is where the pieces are
 * listed anyway.
 *
 * The rule is the app's own, already used to decide which reports belong to a
 * chat (chat-tab.tsx): everything before the first dot is the job, and the rest
 * is a piece of it. It needs no board lookup, which matters — the rail draws
 * before anything has been asked about the cards it is drawing.
 *
 * For DISPLAY only. Whatever matches links, reports or tests still works from
 * the full list (docs/agent-workbench.md §8.2.6).
 */

/** One chip's worth: the job, and the pieces of it this chat actually touched. */
export interface JobTouched {
  /** The card the chip names and opens. */
  id: string;
  /** The pieces folded into it, in the order they were touched. Empty when the chat touched the job itself. */
  pieces: string[];
}

/**
 * Folds a chat's cards onto their jobs, keeping the order they arrived in.
 *
 * A job the chat touched directly and pieces of the same job are one entry: the
 * chip is the job either way, and `pieces` says which pieces were seen.
 */
export function byJob(ids: string[]): JobTouched[] {
  const found = new Map<string, JobTouched>();
  for (const id of ids) {
    const job = id.split('.')[0]!;
    const already = found.get(job) ?? { id: job, pieces: [] };
    if (id !== job && !already.pieces.includes(id)) already.pieces.push(id);
    found.set(job, already);
  }
  return Array.from(found.values());
}

/** What the chip says when the pointer rests on it. */
export function jobTitle({ id, pieces }: JobTouched): string {
  if (pieces.length === 0) return `Open ${id}`;
  const many = pieces.length === 1 ? '1 piece' : `${pieces.length} pieces`;
  return `Open ${id} — this chat touched ${many} of it: ${pieces.join(', ')}`;
}
