"use client";

import { memo } from "react";

import { FolderOpen, Link2, MessageSquare } from "lucide-react";

import { BeadKindTag, BeadSystemTag, BeadTags } from "@/components/bead-tags";
import { CopyableText } from "@/components/copyable-text";
import { SignOffButton, useSignOff } from "@/components/sign-off";
import { Badge } from "@/components/ui/badge";
import { BoardCard, BoardCardSelect } from "@/components/ui/card/board-card";
import { Panel } from "@/components/ui/panel";
import { useTheme } from "@/hooks/use-theme";
import { tagFor } from "@/lib/bead-labels";
import { formatWorktreePath, isBlockedBy, truncate } from "@/lib/bead-utils";
import { commentCountOf } from "@/lib/beads-parser";
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
  /** Worktree status for the bead */
  worktreeStatus?: WorktreeStatus;
  isSelected?: boolean;
  onSelect: (bead: Bead) => void;
  /** The project this card's board belongs to, for signing the card off. */
  projectPath?: string;
  /** Read the board again, after a sign-off has moved this card. */
  onUpdate?: () => void;
}

/**
 * What the copy of the work is saying, as one of the library's panel tones:
 * success when it is ahead of main and needs nothing from it, danger when it
 * needs rebasing, and the plain tone when there is no copy or nobody is
 * waiting on the bead any more.
 */
function getWorktreeTone(worktreeStatus?: WorktreeStatus, beadStatus?: string): "success" | "danger" | "default" {
  // Work nobody is waiting on gets no colour: the greens and ambers here say
  // "this is in flight", and dropped work is as settled as finished work. This
  // used to ask only whether the bead was closed, so a dropped one kept the
  // colours of live work.
  if (beadStatus !== undefined && !standing(beadStatus)) {
    return "default";
  }

  if (!worktreeStatus?.exists) {
    return "default";
  }

  // Check worktree ahead/behind
  const { ahead, behind } = worktreeStatus;

  if (ahead > 0 && behind > 0) {
    // Needs rebase
    return "danger";
  }

  if (ahead > 0 && behind === 0) {
    // Ahead of main with nothing to take back
    return "success";
  }

  return "default";
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
export const BeadCard = memo(function BeadCard({ bead, statusById, worktreeStatus, isSelected = false, onSelect, projectPath, onUpdate }: BeadCardProps) {
  const { layout } = useTheme();
  const { isMarking, signOff } = useSignOff(bead.id, bead.title, projectPath, onUpdate, bead.metadata?.manager_review_tree);
  const blocked = isBlockedBy(bead, statusById);
  const commentCount = commentCountOf(bead);
  const relatedCount = (bead.relates_to ?? []).length;

  // Issue-type metadata (icon + theme color) from the shared source of truth
  const typeMeta = getIssueTypeMeta(bead.issue_type);
  const TypeIcon = typeMeta.icon;

  const hasWorktree = worktreeStatus?.exists ?? false;

  // Selecting the card is BoardCardSelect, one real button kept out of sight
  // (bw-lf8i.4); a press anywhere else on the card still selects it.
  const interactionProps = {
    "data-bead-id": bead.id,
    // Which card the press was about, for a reader with several cards standing
    // in the manager's column and for the checks that time the answer.
    "data-marking": isMarking ? "true" : undefined,
    "aria-busy": isMarking,
    onClick: () => onSelect(bead),
  };

  // Shared worktree section
  const worktreeSection = hasWorktree && worktreeStatus?.worktree_path && (
    <Panel tone={getWorktreeTone(worktreeStatus, bead.status)} inset="none" className="p-2 space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <FolderOpen className="size-3 shrink-0" aria-hidden="true" />
        <span className="font-mono truncate">
          {formatWorktreePath(worktreeStatus.worktree_path)}
        </span>
      </div>
    </Panel>
  );

  // A card nobody is waiting on is dimmed and struck through, whether the work
  // was finished or dropped. Dimming only the finished ones drew abandoned work
  // as the live work of the board, and all three shapes say it the same way:
  // one of them struck the title and the other two did not, so the same card
  // read as two different things depending on the theme in use.
  const isSettled = !standing(bead.status);

  // Approval belongs to the exact proposed tree and does not move work to Done.
  const canSignOff = bead.status === 'manager_review' && !!bead.metadata?.manager_review_tree
    && bead.metadata.manager_approved_tree !== bead.metadata.manager_review_tree;
  /**
   * @param className - Each shape gives the button its own room: the two block
   *   shapes hand it the width of the card, the dense row keeps it beside the
   *   badges on the right.
   */
  const signOffButton = (className: string) => canSignOff && (
    <SignOffButton isMarking={isMarking} onPress={signOff} className={className} />
  );

  // ─── Layout: compact-row (Linear Minimal) ───
  if (layout === 'compact-row') {
    return (
      <BoardCard
        {...interactionProps}
        shape="compact-row"
        selected={isSelected}
        settled={isSettled}
      >
        <BoardCardSelect label={`Select card: ${bead.title}`} onSelect={() => onSelect(bead)} />
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
              {bead.id}
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
          {signOffButton("shrink-0")}
          <BeadTags bead={bead} />
          {commentCount > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] text-t-faint">
              <MessageSquare className="size-3" aria-hidden="true" />
              {commentCount}
            </span>
          )}
        </div>
        <CardLiveChat beadId={bead.id} />
      </BoardCard>
    );
  }

  // ─── Layout: property-tags (Notion Warm / GitHub Clean) ───
  if (layout === 'property-tags') {
    return (
      <BoardCard
        {...interactionProps}
        shape="property-tags"
        selected={isSelected}
        settled={isSettled} blocked={blocked}
      >
        <BoardCardSelect label={`Select card: ${bead.title}`} onSelect={() => onSelect(bead)} />
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
            {bead.id}
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
        </div>
        {canSignOff && <div className="pt-2">{signOffButton("w-full")}</div>}
        <CardLiveChat beadId={bead.id} />
      </BoardCard>
    );
  }

  // ─── Layout: standard (Default / Glassmorphism / Neo-Brutalist / Soft Light) ───
  return (
    <BoardCard
      {...interactionProps}
      shape="standard"
      selected={isSelected}
      settled={isSettled} blocked={blocked}
    >
      <BoardCardSelect label={`Select card: ${bead.title}`} onSelect={() => onSelect(bead)} />
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
              <CopyableText copyText={bead.id}>
                {bead.id}
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

        {/* Footer: comment and relationship counts. */}
        {(commentCount > 0 || relatedCount > 0) && (
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
          </div>
        )}
        {canSignOff && <div className="px-3 pb-2">{signOffButton("w-full")}</div>}
        <div className="px-3 pb-2">
          <CardLiveChat beadId={bead.id} />
        </div>
      </div>
    </BoardCard>
  );
});
