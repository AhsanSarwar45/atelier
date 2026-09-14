/**
 * The arrow in a screen's bar: back where the reader came from, not back to
 * the front door.
 *
 * Written as a link to `href` and turned into a step back through the history
 * at the moment it is pressed, so it draws the same before and after the
 * browser takes it over, a middle-click still opens `href` in its own tab, and
 * a screen with nothing of ours behind it — a pasted address, a fresh tab —
 * still has a way out (bw-zhgh, bw-430t). A held key is the reader asking for a
 * second tab, so that too is left to the link underneath.
 *
 * One component rather than one idiom per screen: the settings screen used to
 * be a plain anchor to the list, which threw the whole visit away and reloaded
 * the document to do it (bw-2t1c.1).
 */
'use client';

import { useCallback, type MouseEvent } from 'react';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { ArrowLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { somewhereBehind } from '@/lib/address';
import { cn } from '@/lib/utils';

export function BackLink({
  href,
  label = 'Back',
  className,
  steps = 1,
  ...rest
}: {
  /** Where the link goes when there is nothing of ours behind this screen. */
  href: string;
  /**
   * How many entries back "where the reader came from" is. A screen that
   * pushed an entry for each of its own sections steps over all of them;
   * zero means nothing of ours was pushed and the link is simply followed.
   */
  steps?: number | (() => number);
  /** What a screen reader hears. */
  label?: string;
  className?: string;
  'data-testid'?: string;
}) {
  const router = useRouter();
  const stepBack = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const n = typeof steps === 'function' ? steps() : steps;
      if (n < 1 || !somewhereBehind()) return;
      e.preventDefault();
      if (n === 1) router.back();
      else window.history.go(-n);
    },
    [router, steps],
  );
  return (
    // Ink named from the app's own text scale: the quiet button style is written
    // in borrowed colour names that three skins paint the same as the bar, and
    // the picture carries its own strength because the button dims any picture
    // inside it (see src/components/global-settings-button.tsx).
    <Button
      variant="ghost"
      size="icon"
      className={cn('shrink-0 text-t-tertiary hover:bg-surface-overlay hover:text-t-primary', className)}
      asChild
    >
      <Link href={href} data-testid={rest['data-testid'] ?? 'back-arrow'} onClick={stepBack}>
        <ArrowLeft className="h-4 w-4 opacity-100" />
        <span className="sr-only">{label}</span>
      </Link>
    </Button>
  );
}
