"use client";

import { PackageOpen } from "lucide-react";

import { BeadCard } from "@/components/bead-card";
import { EpicCard } from "@/components/epic-card";
import { CardReportLink, useCardReport } from "@/components/report-panel";
import { Badge } from "@/components/ui/badge";
import { classesFor, colorFor } from "@/lib/state-styles";
import { cn } from "@/lib/utils";
import type { Bead, BeadStatus, Epic } from "@/types";

export interface KanbanColumnProps {
  status: BeadStatus;
  title: string;
  beads: Bead[];
  /** All beads for resolving epic children */
  allBeads: Bead[];
  selectedBeadId?: string | null;
  ticketNumbers?: Map<string, number>;
  onSelectBead: (bead: Bead) => void;
  onChildClick?: (child: Bead) => void;
  onNavigateToDependency?: (beadId: string) => void;
  /** Project root path for fetching design docs */
  projectPath?: string;
  /** The project's directory on disk, which a Dolt-backed board's path is not. */
  fsPath?: string;
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
  ticketNumber?: number;
  isSelected: boolean;
  onSelectBead: (bead: Bead) => void;
  onChildClick?: (child: Bead) => void;
  onNavigateToDependency?: (beadId: string) => void;
  projectPath?: string;
  fsPath?: string;
  onUpdate?: () => void;
}

/**
 * One card in a column, handed its own report if it has one.
 *
 * The lookup is a hook, so it cannot live inside the column's map — which is
 * the whole reason this is a component rather than a few lines up there.
 */
function ColumnCard({
  bead,
  allBeads,
  ticketNumber,
  isSelected,
  onSelectBead,
  onChildClick,
  onNavigateToDependency,
  projectPath,
  fsPath,
  onUpdate,
}: ColumnCardProps) {
  const entry = useCardReport(bead.id);
  const report = entry
    ? <CardReportLink entry={entry} fsPath={fsPath ?? ""} />
    : undefined;

  // The card itself carries `data-bead-id`, so it needs no wrapper to be found.
  return isEpic(bead) ? (
    <EpicCard
      epic={bead}
      allBeads={allBeads}
      ticketNumber={ticketNumber}
      isSelected={isSelected}
      onSelect={onSelectBead}
      onChildClick={onChildClick ?? onSelectBead}
      onNavigateToDependency={onNavigateToDependency}
      projectPath={projectPath}
      onUpdate={onUpdate}
      report={report}
    />
  ) : (
    <BeadCard
      bead={bead}
      allBeads={allBeads}
      ticketNumber={ticketNumber}
      isSelected={isSelected}
      onSelect={onSelectBead}
      report={report}
    />
  );
}

/**
 * Reusable Kanban column component with header, count badge, and scrollable bead list
 * Renders EpicCard for epics and BeadCard for standalone tasks
 *
 * The column carries `data-column` and each card draws its own `data-bead-id`,
 * so what reached the screen can be read from outside and compared with what the
 * board says: scripts/board-columns-agree.py. A child drawn inside an epic card is
 * not one of these, which is what makes the comparison meaningful.
 */
export function KanbanColumn({
  status,
  title,
  beads,
  allBeads,
  selectedBeadId,
  ticketNumbers,
  onSelectBead,
  onChildClick,
  onNavigateToDependency,
  projectPath,
  fsPath,
  onUpdate,
}: KanbanColumnProps) {
  return (
    <div
      className={cn(
        "flex flex-col h-full min-h-0 theme-column",
        "bg-surface-raised/30 border border-b-default/50"
      )}
      data-column={status}
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

      {/* Scrollable Bead List */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        <div className="space-y-3">
          {beads.map((bead) => (
            <ColumnCard
              key={bead.id}
              bead={bead}
              allBeads={allBeads}
              ticketNumber={ticketNumbers?.get(bead.id)}
              isSelected={selectedBeadId === bead.id}
              onSelectBead={onSelectBead}
              onChildClick={onChildClick}
              onNavigateToDependency={onNavigateToDependency}
              projectPath={projectPath}
              fsPath={fsPath}
              onUpdate={onUpdate}
            />
          ))}
          {beads.length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 border-2 border-dashed border-b-strong/50 rounded-lg">
              <PackageOpen className="size-8 text-t-muted mb-2" aria-hidden="true" />
              <span className="text-t-muted text-sm">No beads</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
