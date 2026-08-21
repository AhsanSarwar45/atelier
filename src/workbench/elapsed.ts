/**
 * How long something has been going, said the way a clock says it.
 *
 * One function for the whole app. Every screen that counted was free to phrase
 * it and three of them chose bare seconds, so a chat two minutes into a turn
 * read `109s` and one left running overnight read five figures — a number
 * nobody converts in their head (bw-jaoz.6).
 *
 * Minutes keep their seconds, because a helper is usually gone for two or three
 * of them and `2m` for anything between two and three minutes is the whole
 * scale a reader has. Hours drop them: at that length the seconds are noise.
 */
export function forHowLong(seconds: number): string {
  const secs = Math.max(0, Math.round(seconds));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}
