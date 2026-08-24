"use client";

import { Ban, Check, Circle, Clock, Eye, FileCheck, Link2, type LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { truncate } from "@/lib/bead-utils";
import { classesFor } from "@/lib/state-styles";
import { cn } from "@/lib/utils";
import { STATE_BY_ID, standing, type Bead, type BeadStatus, type StateInfo } from "@/types";

export interface SubtaskListProps {
  /** Child tasks to display */
  childTasks: Bead[];
  /** Callback when clicking a child task */
  onChildClick: (child: Bead) => void;
  /** Maximum number of children to show when collapsed */
  maxCollapsed?: number;
  /** Whether the list is expanded */
  isExpanded?: boolean;
}

/**
 * The drawings behind the icon names the one list of states gives. A name it
 * does not answer for falls back to the open circle rather than nothing.
 */
const ICONS: Record<StateInfo['icon'], LucideIcon> = {
  circle: Circle,
  clock: Clock,
  'file-check': FileCheck,
  eye: Eye,
  check: Check,
  ban: Ban,
};

/**
 * Get status icon based on bead status
 */
function getStatusIcon(status: BeadStatus) {
  const state = STATE_BY_ID[status];
  const Icon = ICONS[state?.icon] ?? Circle;
  return <Icon className={cn("h-3.5 w-3.5", getStatusColor(status))} aria-hidden="true" />;
}

/**
 * Get status text color
 */
function getStatusColor(status: BeadStatus): string {
  return STATE_BY_ID[status] ? classesFor(status).text : "text-t-muted";
}

/**
 * Compact list of child tasks within epic card
 */
export function SubtaskList({
  childTasks,
  onChildClick,
  maxCollapsed = 3,
  isExpanded = false,
}: SubtaskListProps) {
  if (childTasks.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic">
        No child tasks
      </div>
    );
  }

  const displayChildren = isExpanded ? childTasks : childTasks.slice(0, maxCollapsed);
  const hasMore = childTasks.length > maxCollapsed && !isExpanded;

  return (
    <div className="space-y-1">
      {displayChildren.map((child) => (
        <Button
          key={child.id}
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onChildClick(child);
          }}
          aria-label={`Open task: ${child.title}`}
          className="h-auto w-full items-start justify-start gap-2 px-2 py-1.5 text-left font-normal"
        >
          <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
            {getStatusIcon(child.status)}
          </div>
          <div className="flex-1 min-w-0">
            {/* A piece nobody is waiting on is struck through and muted,
                whether it was finished or dropped. Reading the strike as
                "finished" and drawing dropped work like live work made the
                one list of pieces disagree with the count above it. */}
            <p className={cn(
              "text-xs font-medium group-hover:underline",
              standing(child.status) ? "text-t-secondary" : "line-through text-t-muted"
            )}>
              {truncate(child.title, 50)}
            </p>
            {child.description && (
              <p className="text-[10px] text-t-muted mt-0.5">
                {truncate(child.description, 60)}
              </p>
            )}
          </div>
          {(child.relates_to ?? []).length > 0 && (
            <span className="flex items-center gap-0.5 flex-shrink-0 text-muted-foreground">
              <Link2 className="size-3" aria-hidden="true" />
              <span className="text-[9px] tabular-nums">{child.relates_to!.length}</span>
            </span>
          )}
          <div className={cn(
            "flex-shrink-0 text-[9px] font-medium uppercase tracking-wide",
            getStatusColor(child.status)
          )}>
            {child.status.replace('_', ' ')}
          </div>
        </Button>
      ))}
      {hasMore && (
        <p className="text-[10px] text-muted-foreground text-center py-1">
          +{childTasks.length - maxCollapsed} more
        </p>
      )}
    </div>
  );
}
