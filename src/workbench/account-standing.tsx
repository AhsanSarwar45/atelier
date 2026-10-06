/**
 * Whether each account a picker lists is signed in, and the mark that says so.
 *
 * The Accounts screen was the only place that asked, so a chat could be
 * started on an account whose login had lapsed and fail on its first message.
 * Every list of accounts draws the same mark beside a signed-out one now.
 *
 * Asking costs a process per account on the server, and several pickers can be
 * on screen at once, so one answer per brand is shared and kept for a short
 * while. A finished sign-in forgets it, so the mark goes as soon as it is wrong.
 */
'use client';

import { useEffect, useState } from 'react';

import { TriangleAlert } from 'lucide-react';

import { Tooltip } from '@/components/ui/tooltip';
import type { Brand, ProfileStanding } from '@/workbench/protocol';
import { sendCommand } from '@/workbench/use-session';

type Standing = Record<string, ProfileStanding>;

/** How long one answer is trusted before it is asked again. */
const KEPT_MS = 30_000;

const asked = new Map<Brand, { at: number; answer: Promise<Standing> }>();
const listeners = new Set<() => void>();

function ask(brand: Brand): Promise<Standing> {
  const held = asked.get(brand);
  if (held && Date.now() - held.at < KEPT_MS) return held.answer;
  const answer = sendCommand<{ standing: Standing }>({ type: 'profiles.standing', brand }).then(
    (r) => r.standing ?? {},
  );
  asked.set(brand, { at: Date.now(), answer });
  // A failed question is not kept, so the next picker asks again.
  answer.catch(() => {
    if (asked.get(brand)?.answer === answer) asked.delete(brand);
  });
  return answer;
}

/** Drop what is known, after a sign-in has changed it, and ask again. */
export function forgetStanding() {
  asked.clear();
  for (const listener of listeners) listener();
}

/**
 * Each of `brand`'s accounts' standing, by profile id. `null` until it is known
 * and when it cannot be read: not knowing is never drawn as signed out.
 */
export function useStanding(brand: Brand | null | undefined, when = true): Standing | null {
  const [standing, setStanding] = useState<{ brand: Brand; standing: Standing } | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const listener = () => setRound((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (!brand || !when) return;
    let live = true;
    ask(brand)
      .then((next) => live && setStanding({ brand, standing: next }))
      .catch(() => live && setStanding(null));
    return () => {
      live = false;
    };
  }, [brand, when, round]);
  return standing && standing.brand === brand ? standing.standing : null;
}

/** Signed out, as the provider said it. A provider that said nothing is not. */
export function signedOut(standing: ProfileStanding | undefined): boolean {
  return Boolean(standing && !standing.signedIn && !standing.unknown);
}

/** A warning beside an account's name, said in full on hover. */
export function SignedOutMark({ standing }: { standing: ProfileStanding | undefined }) {
  if (!signedOut(standing)) return null;
  return (
    <Tooltip label="Signed out. Sign in from Settings > Accounts.">
      <span
        className="inline-flex shrink-0 items-center text-warning"
        role="img"
        aria-label="Signed out"
        data-testid="signed-out-mark"
      >
        <TriangleAlert className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
