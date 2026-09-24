/**
 * A card on the board: a task or a job, in the shape the theme draws it.
 *
 * Each theme picks one of three shapes — a dense row, a card of property tags,
 * the standard block — and a job is drawn in the epic's colour where a task is
 * drawn in the plain one. The two card files used to spell out all six
 * surfaces for themselves, each a div copying a card's paint with a raw button
 * hidden inside it (bw-weih.9). The paint is written here once, exactly as the
 * cards had it, so moving onto the library changed nothing a reader can see.
 *
 * Selecting the card is one real button, kept out of sight, with the card's
 * ring drawn when it has focus. The whole card used to be the button, and a
 * button may not hold others: the copy, dependency, child and chat controls
 * inside it were read as part of its name, and a key pressed on any of them
 * could open the card as well (bw-lf8i.4). A press anywhere else on the card
 * still selects it.
 */
import * as React from 'react';

import { cn } from '@/lib/utils';

export type BoardCardShape = 'compact-row' | 'property-tags' | 'standard';
export type BoardCardKind = 'bead' | 'epic';

interface Look {
  surface: string;
  focus: string;
  settled: string;
  selected: string;
  /** The danger edge of a blocked card, where the shape draws one. */
  blocked?: string;
}

const RING = 'has-[[data-card-select]:focus-visible]:ring-2';

const LOOKS: Record<BoardCardKind, Record<BoardCardShape, Look>> = {
  bead: {
    'compact-row': {
      surface: 'p-2 flex items-start gap-2.5 bg-card border border-transparent hover:bg-surface-overlay/50',
      focus: `${RING} has-[[data-card-select]:focus-visible]:ring-ring`,
      settled: 'opacity-40',
      selected: 'bg-info/5 outline outline-1 outline-info/20',
    },
    'property-tags': {
      surface: 'p-3 bg-card border border-b-default/60 hover:bg-surface-inset/30',
      focus: `${RING} has-[[data-card-select]:focus-visible]:ring-ring`,
      blocked: 'border-l-3 border-l-danger',
      settled: 'opacity-45',
      selected: 'ring-2 ring-ring ring-offset-2 ring-offset-surface-base',
    },
    standard: {
      surface: 'bg-card border border-border/40 flex',
      focus: `${RING} has-[[data-card-select]:focus-visible]:ring-ring has-[[data-card-select]:focus-visible]:ring-offset-2 has-[[data-card-select]:focus-visible]:ring-offset-background`,
      blocked: 'border-l-4 border-l-danger',
      settled: 'opacity-45',
      selected: 'ring-2 ring-ring ring-offset-2 ring-offset-background',
    },
  },
  epic: {
    'compact-row': {
      surface: 'p-2.5 bg-card border border-epic/20 hover:bg-surface-overlay/50',
      focus: `${RING} has-[[data-card-select]:focus-visible]:ring-epic`,
      settled: 'opacity-45',
      selected: 'bg-epic/5 outline outline-1 outline-epic/20',
    },
    'property-tags': {
      surface: 'p-3 bg-card border border-epic/30 hover:bg-surface-inset/30',
      focus: `${RING} has-[[data-card-select]:focus-visible]:ring-epic`,
      settled: 'opacity-45',
      selected: 'ring-2 ring-epic ring-offset-2 ring-offset-surface-base',
    },
    standard: {
      surface: 'p-4 bg-surface-raised/70 border border-b-default/60 border-l-2 border-l-epic',
      focus: `${RING} has-[[data-card-select]:focus-visible]:ring-epic has-[[data-card-select]:focus-visible]:ring-offset-2 has-[[data-card-select]:focus-visible]:ring-offset-surface-base`,
      settled: 'opacity-45',
      selected: 'ring-2 ring-epic ring-offset-2 ring-offset-surface-base',
    },
  },
};

const BoardCard = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    shape: BoardCardShape;
    kind?: BoardCardKind;
    /** The card the detail pane is showing. */
    selected?: boolean;
    /** Finished or dropped: nobody is waiting on it, so it is dimmed. */
    settled?: boolean;
    /** Waiting on another card, for the shapes that draw a danger edge. */
    blocked?: boolean;
  }
>(function BoardCard({ shape, kind = 'bead', selected, settled, blocked, className, ...props }, ref) {
  const look = LOOKS[kind][shape];
  return (
    <div
      ref={ref}
      data-slot="board-card"
      className={cn(
        'theme-card relative cursor-pointer',
        look.surface,
        look.focus,
        blocked && look.blocked,
        settled && look.settled,
        selected && look.selected,
        className,
      )}
      {...props}
    />
  );
});
BoardCard.displayName = 'BoardCard';

/** The out-of-sight button that selects the card, and draws its ring on focus. */
function BoardCardSelect({ label, onSelect }: { label: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      data-card-select
      aria-label={label}
      className="sr-only"
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
    />
  );
}

export { BoardCard, BoardCardSelect };
