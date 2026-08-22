/**
 * What a session says about itself, in its own words, from beside its marker.
 *
 * The marker Claude Code writes carries one bit — busy or idle — and a chat
 * summarising itself, a chat stopped on a permission prompt and a chat halfway
 * through a command are all equally busy. That bit cannot be widened; it is the
 * tool's own file. What CAN be added is a line beside it, written by the
 * session itself as it enters a state worth naming, which is what a hook is
 * for (bw-jaoz.14.6).
 *
 * This is the told tier of {@link whatItIsDoing}: exact, because the session
 * emitted it, and never overridden by anything read off a record.
 *
 * **Everything here distrusts the file.** It is written by a hook script on a
 * machine we do not control, at a moment we do not choose, and a half-written
 * or abandoned one must read as "nothing said" rather than as a wrong word held
 * on the screen for ever.
 */
import type { Doing } from './chat-state';
import { DOING_WORD } from './chat-state.ts';

/** What a hook wrote, once it has been believed. */
export interface ToldDoing {
  doing: Doing;
  /** When the session entered that state, ms since the epoch. */
  since: number;
  /** Its own words for it — the trigger of a compaction, the tool being asked for. */
  detail: string | null;
}

/**
 * How long a told summarising claim is worth believing.
 *
 * There is no hook for the end of a compaction — only for its start — so the
 * end is inferred, and a session killed mid-compaction would otherwise leave a
 * bar filling on the screen until the marker went away. Fifteen minutes is far
 * past the longest run measured on this machine (371 seconds) and far short of
 * a wait anybody would sit through.
 */
export const TOLD_SUMMARY_LIFE_MS = 900_000;

/**
 * A permission prompt has no life at all: it stands until a person answers it,
 * and people go to lunch. The hook that clears it is the one that fires when
 * the turn ends.
 */
const NO_LIFE: ReadonlySet<Doing> = new Set<Doing>(['waiting']);

/** How far ahead of us a writer's clock may be before we stop believing it. */
const SKEW_MS = 60_000;

/**
 * What that file says, or nothing at all.
 *
 * Nothing at all covers every way it can be wrong: unreadable, not JSON, a word
 * we do not have, a clock from the future, or a claim old enough that the
 * session it describes has plainly moved on.
 */
export function toldDoing(text: string | null, now: number): ToldDoing | null {
  if (!text) return null;
  let said: unknown;
  try {
    said = JSON.parse(text);
  } catch {
    return null;
  }
  if (!said || typeof said !== 'object') return null;
  const row = said as { doing?: unknown; since?: unknown; detail?: unknown };
  const doing = typeof row.doing === 'string' && row.doing in DOING_WORD ? (row.doing as Doing) : null;
  // `unknown` is a word in the table and a refusal to answer everywhere else;
  // a file saying it is a file saying nothing.
  if (!doing || doing === 'unknown') return null;
  const since = typeof row.since === 'number' && Number.isFinite(row.since) ? row.since : null;
  if (since === null || since > now + SKEW_MS) return null;
  if (!NO_LIFE.has(doing) && now - since > TOLD_SUMMARY_LIFE_MS) return null;
  const detail = typeof row.detail === 'string' && row.detail.length > 0 ? row.detail : null;
  return { doing, since, detail };
}

/** The name of the line a session writes beside its own marker. */
export function toldFileName(sessionId: string): string {
  return `${sessionId}.doing.json`;
}

/** The session a `<id>.doing.json` beside a marker belongs to, or nothing. */
export function toldFileFor(name: string): string | null {
  const cut = name.endsWith('.doing.json') ? name.slice(0, -'.doing.json'.length) : null;
  return cut && cut.length > 0 ? cut : null;
}
