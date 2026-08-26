import type { HeldChat } from '@/workbench/chat-state';
import type { RestoreRow } from '@/workbench/protocol';

/**
 * Add provider-process facts only to conversations Atelier has never opened.
 *
 * A marker names a provider conversation, not an Atelier session. After an
 * unclean app exit it can outlive the driver which produced it. Copying it
 * onto one of our rows makes a closed chat grow a command timer forever, and
 * talks over an active chat's honest `idle` state after a restart. App rows
 * already get their state from the session store and live stream.
 */
export function withOutsideHolds(rows: RestoreRow[], outside: readonly HeldChat[]): RestoreRow[] {
  const byId = new Map(outside.map((hold) => [hold.id.toLowerCase(), hold]));
  return rows.map((row) => {
    if (row.sessionId !== null || row.externalId === null) {
      return { ...row, runningElsewhere: false, held: null };
    }
    const held = byId.get(row.externalId.toLowerCase()) ?? null;
    return { ...row, runningElsewhere: held !== null, held };
  });
}
