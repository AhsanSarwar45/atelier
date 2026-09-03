/**
 * A card, as a chip that opens it.
 *
 * One part wherever a card is named — the chat's rail, a message that mentions
 * one — so all of them open a card the one way the app opens cards: the card
 * panel slides over whatever tab is showing, and the reader is not thrown onto
 * the board to read it. The address carries it (`card=<id>`), so a chip works
 * from a chat, from the list, and from a link someone pasted —
 * docs/designs/app-shell.md §1.8.
 *
 * There is no crowding rule any more. The chips used to ride on the open chat's
 * own line, which is a row, and a row has to hide most of them; they are in a
 * column now and all of them are drawn (docs/agent-workbench.md §8.2.6).
 */
'use client';

import { useRouter, useSearchParams } from 'next/navigation';

import { CircleDot } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { addressWith, cardWasPushed } from '@/lib/address';
import { classesFor } from '@/lib/state-styles';
import { cn } from '@/lib/utils';
import type { BeadStatus } from '@/types';

/**
 * One card, as a chip that opens it. Drawn in the chat's rail and wherever a
 * message names a card in its own words (bw-4wcd.3), so both look the same and
 * both open the card the same way.
 */
export function BeadChip({
  id,
  projectId,
  size = 'sm',
  testId = 'bead-chip',
  title,
  className,
  status,
}: {
  id: string;
  projectId: string | null;
  size?: 'sm' | 'xs';
  testId?: string;
  /** What the pointer says, when the chip stands for more than the one card it names. */
  title?: string;
  className?: string;
  /** Its live board state, whose existing palette colors the chip. */
  status?: BeadStatus;
}) {
  const router = useRouter();
  const params = useSearchParams();
  return (
    /* The button inside takes `size="none"`: the chip around it is what sizes
       it. The badge already sets this element's height, its side padding and
       its type, and a second set of those from the button is what left the id
       with no room between it and its own border (bw-s5op.2). The button is
       here for what it does — the pointer, the focus ring, the disabled state
       — not for a box of its own. */
    <Badge
      asChild
      variant="primary"
      appearance="outline"
      size={size}
      shape="circle"
      className={cn('shrink-0 font-mono', status && classesFor(status).badge, className)}
    >
      <Button
        type="button"
        variant="foreground"
        size="none"
        className="relative font-inherit before:absolute before:-inset-2.5 before:content-['']"
        data-testid={testId}
        data-bead-id={id}
        data-bead-status={status}
        title={title ?? `Open ${id}`}
        onClick={(e) => {
          e.stopPropagation();
          // Pushed, and the rest of the address kept: the card opens over what he
          // was reading, and Back closes it again.
          cardWasPushed();
          router.push(addressWith(params, { id: projectId, card: id }));
        }}
      >
        {/* A card wears a picture the way a report does, so a line carrying both
            says which is which before either is read (bw-4wcd.7). */}
        <CircleDot className="mr-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
        {id}
      </Button>
    </Badge>
  );
}
