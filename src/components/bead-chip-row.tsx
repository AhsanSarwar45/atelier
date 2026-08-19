/**
 * The cards a chat has touched, as chips that open them.
 *
 * One part for the open chat's line and for a row in the list, so both crowd by
 * the same rule (src/workbench/cards-on-the-line.ts) and both open a card the
 * one way the app opens cards: the card panel slides over whatever tab is
 * showing, and the reader is not thrown onto the board to read it. The address
 * carries it (`card=<id>`), so a chip works from a chat, from the list, and from
 * a link someone pasted — docs/designs/app-shell.md §1.8.
 */
'use client';

import { useRouter, useSearchParams } from 'next/navigation';

import { CircleDot } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { addressWith, cardWasPushed } from '@/lib/address';
import { cn } from '@/lib/utils';
import { CARDS_ON_A_ROW, CARDS_ON_THE_LINE, cardsOnTheLine } from '@/workbench/cards-on-the-line';

/** Where the chips are drawn, which sets how many fit and what they are called. */
export type ChipPlace = 'line' | 'row';

const PLACES = {
  line: { room: CARDS_ON_THE_LINE, size: 'sm', chip: 'bead-chip', more: 'bead-chip-more' },
  row: { room: CARDS_ON_A_ROW, size: 'xs', chip: 'row-bead-chip', more: 'row-bead-more' },
} as const;

/**
 * One card, as a chip that opens it. Drawn on a chat's line, on a row in the
 * list, and wherever a message names a card in its own words (bw-4wcd.3), so
 * all three look the same and all three open the card the same way.
 */
export function BeadChip({
  id,
  projectId,
  size = 'sm',
  testId = 'bead-chip',
  className,
}: {
  id: string;
  projectId: string | null;
  size?: 'sm' | 'xs';
  testId?: string;
  className?: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  return (
    <Badge
      asChild
      variant="primary"
      appearance="outline"
      size={size}
      shape="circle"
      className={cn('shrink-0 font-mono', className)}
    >
      <button
        type="button"
        data-testid={testId}
        data-bead-id={id}
        title={`Open ${id}`}
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
      </button>
    </Badge>
  );
}

export function BeadChipRow({
  ids,
  projectId,
  place = 'line',
  className,
}: {
  ids: string[];
  projectId: string | null;
  place?: ChipPlace;
  className?: string;
}) {
  const spec = PLACES[place];
  const { shown, rest } = cardsOnTheLine(ids, spec.room);
  if (!ids.length) return null;

  const chip = (id: string, testid: string) => (
    <BeadChip key={id} id={id} projectId={projectId} size={spec.size} testId={testid} />
  );

  return (
    <span data-testid="bead-chips" className={className}>
      {shown.map((id) => chip(id, spec.chip))}
      {rest.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <Badge
              asChild
              variant="secondary"
              appearance="light"
              size={spec.size}
              shape="circle"
              className="shrink-0 font-mono"
            >
              <button
                type="button"
                data-testid={spec.more}
                data-more={rest.length}
                title={`${rest.length} more`}
                onClick={(e) => e.stopPropagation()}
              >
                +{rest.length}
              </button>
            </Badge>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto max-w-sm p-2" data-testid="bead-chip-more-list">
            <div className="flex max-h-64 flex-wrap gap-1 overflow-y-auto">
              {rest.map((id) => chip(id, 'bead-chip-hidden'))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </span>
  );
}
