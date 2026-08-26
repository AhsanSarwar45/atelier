"use client";

import { memo } from "react";

import { PackageOpen } from "lucide-react";

import { BeadCard } from "@/components/bead-card";
import { EpicCard } from "@/components/epic-card";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { useDrawnRows } from "@/hooks/use-drawn-rows";
import { classesFor, colorFor } from "@/lib/state-styles";
import { cn } from "@/lib/utils";
import type { Bead, BeadStatus, Epic } from "@/types";

/** What a card is worth before it has been drawn once, and the space between two. */
const CARD_HEIGHT = 160;
const CARD_GAP = 12;

export interface KanbanColumnProps {
  status: BeadStatus;
  title: string;
  beads: Bead[];
  /** All beads for resolving epic children */
  allBeads: Bead[];
  /**
   * Every bead's state by id, built once by the board. A card asks it whether
   * it is blocked; building one per card was a fresh map of the whole board
   * for each of the cards on it, on every pass.
   */
  statusById: ReadonlyMap<string, string>;
  selectedBeadId?: string | null;
  ticketNumbers?: Map<string, number>;
  onSelectBead: (bead: Bead) => void;
  onChildClick?: (child: Bead) => void;
  onNavigateToDependency?: (beadId: string) => void;
  /** Project root path for fetching design docs */
  projectPath?: string;
  /** The project's directory on disk, which a Dolt-backed board's path is not. */
  /** Callback after data changes (to refresh board) */
  onUpdate?: () => void;
}


/**
 * Type guard to check if a bead is an epic
 */
function isEpic(bead: Bead): bead is Epic {
  return bead.issue_type === 'epic';
}

interface ColumnCardProps {
  bead: Bead;
  allBeads: Bead[];
  statusById: ReadonlyMap<string, string>;
  ticketNumber?: number;
  isSelected: boolean;
  onSelectBead: (bead: Bead) => void;
  onChildClick?: (child: Bead) => void;
  onNavigateToDependency?: (beadId: string) => void;
  projectPath?: string;
  onUpdate?: () => void;
}

/**
 * One card in a column.
 *
 * Remembered against its own props: a column redraws whenever anything on the
 * board moves, and without this every card on it was built again to say the
 * same thing.
 */
const ColumnCard = memo(function ColumnCard({
  bead,
  allBeads,
  statusById,
  ticketNumber,
  isSelected,
  onSelectBead,
  onChildClick,
  onNavigateToDependency,
  projectPath,
  onUpdate,
}: ColumnCardProps) {
  // The card itself carries `data-bead-id`, so it needs no wrapper to be found.
  return isEpic(bead) ? (
    <EpicCard
      epic={bead}
      allBeads={allBeads}
      statusById={statusById}
      ticketNumber={ticketNumber}
      isSelected={isSelected}
      onSelect={onSelectBead}
      onChildClick={onChildClick ?? onSelectBead}
      onNavigateToDependency={onNavigateToDependency}
      projectPath={projectPath}
      onUpdate={onUpdate}
    />
  ) : (
    <BeadCard
      bead={bead}
      statusById={statusById}
      ticketNumber={ticketNumber}
      isSelected={isSelected}
      onSelect={onSelectBead}
    />
  );
});

/**
 * Reusable Kanban column component with header, count badge, and scrollable bead list
 * Renders EpicCard for epics and BeadCard for standalone tasks
 *
 * Only the cards inside the scrolling pane are drawn — a column of a hundred and
 * fifty cards showed five of them and paid for all of them. The count in the
 * header and the filtering above it are over the whole column, never over the
 * handful on the screen, and the column names every card it holds in
 * `data-cards` so what it holds can still be read from outside.
 *
 * The column carries `data-column` and each drawn card its own `data-bead-id`,
 * so what reached the screen can be read and compared with what the board says:
 * scripts/board-columns-agree.py. A child drawn inside an epic card is not one
 * of these, which is what makes the comparison meaningful.
 */
export const KanbanColumn = memo(function KanbanColumn({
  status,
  title,
  beads,
  allBeads,
  statusById,
  selectedBeadId,
  ticketNumbers,
  onSelectBead,
  onChildClick,
  onNavigateToDependency,
  projectPath,
  onUpdate,
}: KanbanColumnProps) {
  const { rows, height, paneRef, rowRef } = useDrawnRows(
    beads.map((bead) => bead.id),
    { estimate: CARD_HEIGHT, gap: CARD_GAP, show: selectedBeadId },
  );

  return (
    <Panel
      inset="none"
      // The frame is the library's, so a column is the same face as every other
      // boxed thing in the app; `theme-column` is the hook the eleven themes
      // dress it through, and it still wins the rounding (bw-dks8.6).
      className="flex flex-col h-full min-h-0 theme-column"
      data-column={status}
      data-cards={beads.map((bead) => bead.id).join(" ")}
      style={{ '--column-accent': colorFor(status) } as React.CSSProperties}
    >
      {/* Column Header - fixed height with colored accent border */}
      <div className={cn(
        "flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-b-default/50 brutalist-column-header",
        classesFor(status).borderTop
      )}>
        <h2 className={cn("font-semibold text-sm column-title-text", classesFor(status).text)}>{title}</h2>
        <Badge
          variant="secondary"
          className={cn("text-xs px-2 py-0.5 column-count-badge", classesFor(status).badge)}
        >
          {beads.length}
        </Badge>
      </div>

      {/* Scrollable Bead List. The inner block stands as tall as every card in
          the column would, so the scrollbar says how much there is rather than
          how much is drawn, and each drawn card sits at its own place in it. */}
      <div ref={paneRef} data-testid="column-scroll" className="flex-1 min-h-0 overflow-y-auto p-3">
        {beads.length === 0 ? (
          <Panel inset="none" className="flex flex-col items-center justify-center py-8 border-dashed">
            <PackageOpen className="size-8 text-t-muted mb-2" aria-hidden="true" />
            <span className="text-t-muted text-sm">No cards</span>
          </Panel>
        ) : (
          <div className="relative" style={{ height }}>
            {rows.map(({ index, key, top }) => (
              <div
                key={key}
                ref={rowRef(key)}
                className="absolute inset-x-0"
                style={{ top }}
              >
                <ColumnCard
                  bead={beads[index]}
                  allBeads={allBeads}
                  statusById={statusById}
                  ticketNumber={ticketNumbers?.get(key)}
                  isSelected={selectedBeadId === key}
                  onSelectBead={onSelectBead}
                  onChildClick={onChildClick}
                  onNavigateToDependency={onNavigateToDependency}
                  projectPath={projectPath}
                  onUpdate={onUpdate}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
});
