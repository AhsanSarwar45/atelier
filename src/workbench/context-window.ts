/**
 * How full the conversation is.
 *
 * An agent's memory of its own job is finite, and the moment it fills the kit
 * compacts it — the session keeps running but forgets most of what it worked
 * out. A reader watching one work had no way to see that coming, so a chat
 * would quietly lose its thread mid-job with nothing on screen to explain it
 * (bw-4wcd.4).
 *
 * Shared: the sidecar reads this off the live stream, and reads the same fields
 * out of the kit's own record for a chat that began in a terminal. It therefore
 * imports nothing — the sidecar runs it through Node's strip-only TypeScript.
 */

/** What the kit reports it spent on one call. Every field may be missing. */
export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** What a Claude model holds, unless the kit says otherwise. */
export const WINDOW = 200_000;

/** A message the kit may have stated the window on. */
interface Stated {
  context_usage?: { raw_max_tokens?: unknown } | null;
}

/**
 * The window the kit itself named, or null when this message does not name one.
 *
 * A model's name never carries it. This used to look for a `[1m]` suffix on the
 * name, on the belief that the kit spelled a wide context into it; the kit does
 * no such thing — it reports a plain model id, and the wide window is asked for
 * by a start option this app passes nowhere, so the test could only ever be
 * false (bw-4wcd.15). The one place the kit states the window outright is the
 * structured twin of its own context report, which rides beside a message
 * rather than inside it and gives the window it is itself measuring against —
 * a smaller compaction window included. Believe that when it comes, and use the
 * ordinary window until it does.
 */
export function windowNamed(message: unknown): number | null {
  if (message === null || typeof message !== 'object') return null;
  const stated = (message as Stated).context_usage?.raw_max_tokens;
  return typeof stated === 'number' && Number.isFinite(stated) && stated > 0 ? stated : null;
}

/**
 * What the last call carried, which is what the next one starts from.
 *
 * Everything counts: the words sent, the words already cached (they are still
 * in the prompt — the cache saves money, not room), and the answer, which is in
 * the prompt from the next turn on. Nothing to count comes back as null so a
 * caller can tell "not known yet" from "empty".
 */
export function fullness(usage: Usage | null | undefined): number | null {
  if (!usage) return null;
  const parts = [
    usage.input_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
    usage.output_tokens,
  ].filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  if (!parts.length) return null;
  const total = parts.reduce((sum, n) => sum + n, 0);
  return total > 0 ? total : null;
}

/**
 * The figure as it reads on the chat's own line: `128k/200k`.
 *
 * Rounded to whole thousands, because a number that moves in the hundreds on
 * every frame reads as noise and the question being asked is "how close am I".
 */
export function reads(used: number, window: number): string {
  return `${Math.round(used / 1000)}k/${Math.round(window / 1000)}k`;
}

/** Past this much of the window, the kit is close to compacting. */
export const TIGHT = 0.8;

/* ------------------------------------------------------------------ *
 * The same question asked of a chat's own record on disk.
 * ------------------------------------------------------------------ */

/** As much of a recorded turn as this needs: what it spent and on what. */
export interface Recorded {
  /**
   * Whatever the kit calls a message. Deliberately unknown: the SDK's own
   * `SessionMessage` types this as `unknown`, and a shape declared here that
   * the SDK does not promise would be a lie the compiler enforced.
   */
  message?: unknown;
}

/** The one field this reads off a recorded message, if the record has it. */
interface Turn {
  usage?: Usage | null;
}

function turnOf(message: unknown): Turn | null {
  return message !== null && typeof message === 'object' ? (message as Turn) : null;
}

/**
 * How full a conversation stood at the end of a record.
 *
 * Read backwards, because only the turns the model itself answered carry a
 * usage and the tail of a record is usually the reader's own words. Null when
 * no turn in it says — a chat that has never been answered has no figure, and
 * drawing a zero there would read as an empty conversation rather than an
 * unknown one.
 */
export function latest(messages: readonly Recorded[]): { used: number; window: number } | null {
  // The window is asked of the record as a whole, not of the turn that carries
  // the count: the kit states it only when it was asked for its own context
  // report, which is rarely the last thing in a chat (bw-4wcd.15).
  let window = WINDOW;
  for (let i = messages.length - 1; i >= 0; i--) {
    const named = windowNamed(messages[i]);
    if (named !== null) {
      window = named;
      break;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const used = fullness(turnOf(messages[i]?.message)?.usage);
    if (used !== null) return { used, window };
  }
  return null;
}
