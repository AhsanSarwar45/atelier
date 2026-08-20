"use client";

import { memo, type ReactNode } from "react";

import { FolderOpen, Link2, MessageSquare } from "lucide-react";

import { BeadKindTag, BeadSystemTag, BeadTags } from "@/components/bead-tags";
import { CopyableText } from "@/components/copyable-text";
import { Badge } from "@/components/ui/badge";
import { useTheme } from "@/hooks/use-theme";
import { tagFor } from "@/lib/bead-labels";
import { formatBeadId, formatWorktreePath, isBlockedBy, truncate } from "@/lib/bead-utils";
import { getIssueTypeMeta } from "@/lib/issue-types";
import { cn } from "@/lib/utils";
import { standing } from "@/types";
import type { Bead, WorktreeStatus, StatusBadgeInfo } from "@/types";
import { CardLiveChat } from "@/workbench/card-live";

export interface BeadCardProps {
  bead: Bead;
  /**
   * Every bead's state by id, for asking whether this card is blocked. The
   * board builds it once: building one here meant a fresh map of the whole
   * board per card, on every pass.
   */
  statusById: ReadonlyMap<string, string>;
  ticketNumber?: number;
  /** Worktree status for the bead */
  worktreeStatus?: WorktreeStatus;
  isSelected?: boolean;
  onSelect: (bead: Bead) => void;
  /** Sits with the card's other facts, beside the comment count. */
  report?: ReactNode;
}

/**
 * Get worktree status color for the status box
 * Green: work is ahead of main and needs nothing from it
 * Red: needs rebase
 * Gray: no copy of the work, or nobody is waiting on the bead any more
 */
function getWorktreeStatusColor(worktreeStatus?: WorktreeStatus, beadStatus?: string): string {
  // Work nobody is waiting on gets no colour: the greens and ambers here say
  // "this is in flight", and dropped work is as settled as finished work. This
  // used to ask only whether the bead was closed, so a dropped one kept the
  // colours of live work.
  if (beadStatus !== undefined && !standing(beadStatus)) {
    return "bg-surface-overlay/50 border-b-default/50";
  }

  if (!worktreeStatus?.exists) {
    return "bg-surface-overlay/50 border-b-default/50";
  }

  // Check worktree ahead/behind
  const { ahead, behind } = worktreeStatus;

  if (ahead > 0 && behind > 0) {
    // Needs rebase - red
    return "bg-danger/10 border-danger/30";
  }

  if (ahead > 0 && behind === 0) {
    // Ahead of main with nothing to take back - green
    return "bg-success/10 border-success/30";
  }

  return "bg-surface-overlay/50 border-b-default/50";
}

/**
 * Get the display label for the bead type.
 * Delegates to the shared issue-type metadata (safe fallback to "Task").
 */
function getTypeLabel(bead: Bead): string {
  return getIssueTypeMeta(bead.issue_type).label;
}

/**
 * Get badge variant class for status badges based on severity.
 * warning = orange (blocked, unknown), muted = gray (deferred), info = blue (hooked/waiting)
 */
function getStatusBadgeClasses(variant: StatusBadgeInfo['variant']): string {
  switch (variant) {
    case 'warning':
      return 'bg-blocked-accent/15 text-blocked-accent border-blocked-accent/30';
    case 'muted':
      return 'bg-t-muted/15 text-t-tertiary border-t-muted/30';
    case 'info':
      return 'bg-info/15 text-info border-info/30';
  }
}

/**
 * Remembered against its own props: a board redraws whenever anything on it
 * moves, and without this every card on the screen was built again to say
 * exactly what it already said.
 */
export const BeadCard = memo(function BeadCard({ bead, statusById, ticketNumber, worktreeStatus, isSelected = false, onSelect, report }: BeadCardProps) {
  const { layout } = useTheme();
  const blocked = isBlockedBy(bead, statusById);
  const commentCount = (bead.comments ?? []).length;
  const relatedCount = (bead.relates_to ?? []).length;

  // Issue-type metadata (icon + theme color) from the shared source of truth
  const typeMeta = getIssueTypeMeta(bead.issue_type);
  const TypeIcon = typeMeta.icon;

  const hasWorktree = worktreeStatus?.exists ?? false;

  // Shared interaction props
  const interactionProps = {
    "data-bead-id": bead.id,
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Select bead: ${bead.title}`,
    onClick: () => onSelect(bead),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(bead);
      }
    },
  };

  // Shared worktree section
  const worktreeSection = hasWorktree && worktreeStatus?.worktree_path && (
    <div
      className={cn(
        "rounded-md border p-2 space-y-1.5",
        getWorktreeStatusColor(worktreeStatus, bead.status)
      )}
    >
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <FolderOpen className="size-3 shrink-0" aria-hidden="true" />
        <span className="font-mono truncate">
          {formatWorktreePath(worktreeStatus.worktree_path)}
        </span>
      </div>
    </div>
  );

  // A card nobody is waiting on is dimmed and struck through, whether the work
  // was finished or dropped. Dimming only the finished ones drew abandoned work
  // as the live work of the board, and all three shapes say it the same way:
  // one of them struck the title and the other two did not, so the same card
  // read as two different things depending on the theme in use.
  const isSettled = !standing(bead.status);

  // ─── Layout: compact-row (Linear Minimal) ───
  if (layout === 'compact-row') {
    return (
      <div
        {...interactionProps}
        className={cn(
          "theme-card cursor-pointer p-2 flex items-start gap-2.5",
          "bg-card border border-transparent",
          "hover:bg-surface-overlay/50",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isSettled && "opacity-40",
          isSelected && "bg-info/5 outline outline-1 outline-info/20"
        )}
      >
        {/* Priority bar */}
        <div className={cn(
          "w-1 h-4 rounded-sm shrink-0 mt-0.5",
          bead.priority === 0 ? "bg-danger" :
          bead.priority === 1 ? "bg-blocked-accent" :
          bead.priority === 2 ? "bg-t-faint" : "bg-surface-inset"
        )} />

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-t-muted font-mono shrink-0 tabular-nums">
              {formatBeadId(bead.id)}
            </span>
            <span className={cn(
              "text-[13px] font-medium text-t-primary truncate",
              isSettled && "line-through decoration-t-faint"
            )}>
              {bead.title}
            </span>
          </div>
          {(blocked || bead.description) && (
            <div className="flex items-center gap-2 mt-0.5">
              {blocked && (
                <Badge variant="destructive" appearance="light" size="xs">BLOCKED</Badge>
              )}
              {bead.description && (
                <span className="text-xs text-t-muted truncate">
                  {truncate(bead.description, 60)}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right badges */}
        <div className="flex items-center gap-1.5 shrink-0">
          <BeadTags bead={bead} />
          {commentCount > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] text-t-faint">
              <MessageSquare className="size-3" aria-hidden="true" />
              {commentCount}
            </span>
          )}
          {report}
        </div>
        <CardLiveChat beadId={bead.id} />
      </div>
    );
  }

  // ─── Layout: property-tags (Notion Warm / GitHub Clean) ───
  if (layout === 'property-tags') {
    return (
      <div
        {...interactionProps}
        className={cn(
          "theme-card cursor-pointer p-3 bg-card border border-b-default/60",
          "hover:bg-surface-inset/30",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          blocked && "border-l-3 border-l-danger",
          isSettled && "opacity-45",
          isSelected && "ring-2 ring-ring ring-offset-2 ring-offset-surface-base"
        )}
      >
        {/* Title first */}
        <div className={cn(
          "text-sm font-medium leading-snug text-t-primary mb-1.5",
          isSettled && "line-through decoration-t-faint"
        )}>
          {truncate(bead.title, 70)}
        </div>

        {/* Description */}
        {bead.description && (
          <p className="text-xs text-t-muted leading-relaxed mb-2">
            {truncate(bead.description, 80)}
          </p>
        )}

        {/* Property tags row */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary" appearance="light" size="xs" className="theme-badge font-mono">
            {ticketNumber !== undefined && `#${ticketNumber} `}{formatBeadId(bead.id)}
          </Badge>
          {blocked && (
            <Badge variant="destructive" appearance="light" size="xs" className="theme-badge font-semibold">
              Blocked
            </Badge>
          )}
          <BeadSystemTag bead={bead} />
          {tagFor(bead, "kind") ? (
            <BeadKindTag bead={bead} />
          ) : (
            <Badge variant="secondary" appearance="light" size="xs" className="theme-badge gap-1">
              <TypeIcon className={cn("size-3 shrink-0", typeMeta.colorClass)} aria-hidden="true" />
              {getTypeLabel(bead)}
            </Badge>
          )}
          {bead.priority !== undefined && bead.priority <= 2 && (
            <Badge
              size="xs"
              appearance="light"
              variant={bead.priority === 0 ? "destructive" : bead.priority === 1 ? "warning" : "secondary"}
              className="theme-badge"
            >
              P{bead.priority}
            </Badge>
          )}
          {commentCount > 0 && (
            <span className="text-[10px] text-t-faint px-1">
              {commentCount} {commentCount === 1 ? "comment" : "comments"}
            </span>
          )}
          {report}
        </div>
        <CardLiveChat beadId={bead.id} />
      </div>
    );
  }

  // ─── Layout: standard (Default / Glassmorphism / Neo-Brutalist / Soft Light) ───
  return (
    <div
      {...interactionProps}
      className={cn(
        "theme-card cursor-pointer bg-card border border-border/40 flex",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        isSettled && "opacity-45",
        blocked ? "border-l-4 border-l-danger" : "",
        isSelected && "ring-2 ring-ring ring-offset-2 ring-offset-background"
      )}
    >
      {/* Priority bar (visible when --priority-bar-w > 0, i.e. brutalist) */}
      <div
        className={cn(
          "theme-priority-bar shrink-0",
          bead.priority === 0 ? "bg-danger" :
          bead.priority === 1 ? "bg-blocked-accent" :
          bead.priority === 2 ? "bg-t-faint" :
          "bg-surface-inset"
        )}
      />

      <div className="flex-1 min-w-0">
        <div className="p-3 space-y-1.5">
          {/* Row 1: ID (left) + Type Badge (right) */}
          <div className="flex items-center justify-between">
            <div className="text-xs font-mono text-muted-foreground">
              {ticketNumber !== undefined && (
                <CopyableText copyText={`#${ticketNumber}`} className="font-semibold text-foreground">
                  #{ticketNumber}
                </CopyableText>
              )}
              {ticketNumber !== undefined && " "}
              <CopyableText copyText={bead.id}>
                {formatBeadId(bead.id)}
              </CopyableText>
            </div>
            <div className="flex items-center gap-1.5">
              {blocked && (
                <Badge variant="destructive" appearance="light" size="xs" className="theme-badge">BLOCKED</Badge>
              )}
              {bead._statusBadge && !(blocked && bead._originalStatus === 'blocked') && (
                <Badge
                  variant="outline"
                  size="xs"
                  className={cn("theme-badge", getStatusBadgeClasses(bead._statusBadge.variant))}
                >
                  {bead._statusBadge.label}
                </Badge>
              )}
              {/* The kind of work stands where the issue type used to: on this
                  board every card is a task or an epic, so the type said nothing. */}
              {tagFor(bead, "kind") ? (
                <BeadKindTag bead={bead} />
              ) : (
                <Badge variant="outline" size="xs" className="theme-badge">
                  <TypeIcon className={cn("shrink-0", typeMeta.colorClass)} aria-hidden="true" />
                  {getTypeLabel(bead)}
                </Badge>
              )}
            </div>
          </div>

          {/* Row 2: Title */}
          <div className={cn(
            "font-semibold text-sm leading-tight",
            isSettled && "line-through decoration-t-faint"
          )}>
            {truncate(bead.title, 60)}
          </div>

          <BeadSystemTag bead={bead} />

          {/* Description */}
          {bead.description && (
            <p className="text-xs text-muted-foreground leading-relaxed text-pretty card-desc-text">
              {truncate(bead.description, 80)}
            </p>
          )}
        </div>

        {/* Worktree status box */}
        {worktreeSection && (
          <div className="px-3 pb-3">{worktreeSection}</div>
        )}

        {/* Footer: comment count + related count + this card's report */}
        {(commentCount > 0 || relatedCount > 0 || report) && (
          <div className="flex items-center p-3 pt-0 gap-2 text-muted-foreground card-footer-text">
            {commentCount > 0 && (
              <span className="flex items-center gap-1 text-[10px]">
                <MessageSquare className="size-3" aria-hidden="true" />
                {commentCount} {commentCount === 1 ? "comment" : "comments"}
              </span>
            )}
            {relatedCount > 0 && (
              <span className="flex items-center gap-1 text-[10px]">
                <Link2 className="size-3" aria-hidden="true" />
                {relatedCount} related
              </span>
            )}
            {report}
          </div>
        )}
        <div className="px-3 pb-2">
          <CardLiveChat beadId={bead.id} />
        </div>
      </div>
    </div>
  );
});
