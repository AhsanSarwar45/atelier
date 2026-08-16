/**
 * The cards a chat has touched, as chips that open them.
 *
 * One part for the open chat's line and for a row in the list, so both crowd by
 * the same rule (src/workbench/cards-on-the-line.ts) and both open a card the
 * one way the app opens cards: a card opens where cards live — the board, with
 * its detail panel on that one. The address carries it
 * (src/app/project/kanban-board.tsx reads `bead`), so a chip works from a chat,
 * from the list, and from a link someone pasted.
 */
'use client';

import { useRouter } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { CARDS_ON_A_ROW, CARDS_ON_THE_LINE, cardsOnTheLine } from '@/workbench/cards-on-the-line';

/** Where the chips are drawn, which sets how many fit and what they are called. */
export type ChipPlace = 'line' | 'row';

const PLACES = {
  line: { room: CARDS_ON_THE_LINE, size: 'sm', chip: 'bead-chip', more: 'bead-chip-more' },
  row: { room: CARDS_ON_A_ROW, size: 'xs', chip: 'row-bead-chip', more: 'row-bead-more' },
} as const;

export function beadHref(projectId: string | null, beadId: string): string {
  return `/project?id=${projectId ?? ''}&tab=board&bead=${encodeURIComponent(beadId)}`;
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
  const router = useRouter();
  const spec = PLACES[place];
  const { shown, rest } = cardsOnTheLine(ids, spec.room);
  if (!ids.length) return null;

  const chip = (id: string, testid: string) => (
    <Badge
      key={id}
      asChild
      variant="primary"
      appearance="outline"
      size={spec.size}
      shape="circle"
      className="shrink-0 font-mono"
    >
      <button
        type="button"
        data-testid={testid}
        data-bead-id={id}
        title={`Open ${id}`}
        onClick={(e) => {
          e.stopPropagation();
          router.push(beadHref(projectId, id));
        }}
      >
        {id}
      </button>
    </Badge>
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
