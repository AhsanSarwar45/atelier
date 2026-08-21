/**
 * The one thing every screen draws about a chat.
 *
 * A moving mark and its own verb while something is happening, one word where
 * it stands otherwise, and — beside it, never instead of it — the badge that
 * says another program is holding it. The reading behind it is
 * {@link chatState}; this file is only how it looks (bw-96is).
 *
 * The seconds come off one clock for the whole page. A list of forty rows drew
 * forty intervals before, each one waking React on its own second, and the
 * number they were all counting is the same number.
 */
'use client';

import { useSyncExternalStore } from 'react';

import { Hand, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ChatState, Holder } from '@/workbench/chat-state';

/** What the badge's tooltip calls each kind of holder. */
const HOLDER_WORD: Record<Holder, string> = {
  terminal: 'Somebody is working in this chat in a terminal.',
  program: 'Another program is working in this chat.',
};

const listeners = new Set<() => void>();
let beat: ReturnType<typeof setInterval> | null = null;
let tick = Date.now();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!beat) {
    beat = setInterval(() => {
      tick = Date.now();
      listeners.forEach((f) => f());
    }, 1000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size > 0 || !beat) return;
    clearInterval(beat);
    beat = null;
  };
}

/** The current second, shared by every chip on the page. */
function useSecond(): number {
  return useSyncExternalStore(
    subscribe,
    () => tick,
    () => 0,
  );
}

/** How long it has been at it, or an empty string when nothing is counting. */
function seconds(since: number | null, now: number): string {
  if (!since) return '';
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return `${s}s`;
}

/**
 * The chip.
 *
 * `size` is the only thing that varies between the places it is drawn: a row in
 * the list, the open chat's own line, and the small print on a board card.
 */
export function ChatStateChip({
  state,
  size = 'row',
  testId = 'chat-state',
  className,
}: {
  state: ChatState;
  size?: 'row' | 'line' | 'inline';
  testId?: string;
  className?: string;
}) {
  const now = useSecond();
  const count = state.working ? seconds(state.since, now) : '';
  // Nothing is known and nothing is claimed: the external badge beside this is
  // the whole of what the screen can honestly say.
  if (!state.word) return null;

  const body = (
    <>
      {state.working && <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />}
      {state.waiting && <Hand className="size-3 shrink-0 animate-pulse" aria-hidden="true" />}
      <span className="truncate">{state.word}</span>
      {count && <span className="shrink-0 font-mono tabular-nums opacity-70">{count}</span>}
    </>
  );

  if (size === 'inline') {
    return (
      <span
        data-testid={testId}
        data-working={state.working ? 'yes' : 'no'}
        data-word={state.word}
        className={cn('flex min-w-0 items-center gap-1.5 text-[11px]', className)}
      >
        {body}
      </span>
    );
  }

  return (
    <Badge
      variant={state.working ? 'primary' : state.waiting ? 'warning' : 'secondary'}
      appearance="light"
      size={size === 'line' ? 'sm' : 'xs'}
      shape="circle"
      data-testid={testId}
      data-working={state.working ? 'yes' : 'no'}
      data-word={state.word}
      className={cn('shrink-0 gap-1.5', className)}
    >
      {body}
    </Badge>
  );
}

/**
 * The badge that says this conversation is somebody else's right now.
 *
 * Never in place of the chip: a held chat that is answering says both, which is
 * the whole correction — the word it replaced said "occupied" and was read as
 * "working" (bw-96is).
 */
export function ExternalBadge({
  holder,
  size = 'row',
  className,
}: {
  holder: Holder;
  size?: 'row' | 'line';
  className?: string;
}) {
  return (
    <Badge
      variant="secondary"
      appearance="outline"
      size={size === 'line' ? 'sm' : 'xs'}
      shape="circle"
      data-testid="chat-external"
      data-holder={holder}
      title={HOLDER_WORD[holder]}
      className={cn('shrink-0', className)}
    >
      external
    </Badge>
  );
}
