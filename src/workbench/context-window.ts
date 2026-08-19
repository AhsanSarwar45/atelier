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

/** What a Claude model holds, unless it says otherwise. */
export const WINDOW = 200_000;

/** The wide window, which the kit asks for by suffixing the model's name. */
const WIDE = 1_000_000;

/**
 * The window this model is running with.
 *
 * The kit spells the wide context by appending `[1m]` to the model name it
 * reports, so the name is the only thing that tells us which one is in force.
 */
export function windowOf(model: string | null | undefined): number {
  return typeof model === 'string' && model.toLowerCase().includes('[1m]') ? WIDE : WINDOW;
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
  message?: { usage?: Usage | null; model?: string | null } | null;
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
  for (let i = messages.length - 1; i >= 0; i--) {
    const used = fullness(messages[i]?.message?.usage);
    if (used !== null) return { used, window: windowOf(messages[i]?.message?.model) };
  }
  return null;
}
