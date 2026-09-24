"use client";

import { memo, useState, useMemo } from "react";

import { Layers, MessageSquare } from "lucide-react";

import { BeadTags } from "@/components/bead-tags";
import { CopyableText } from "@/components/copyable-text";
import { DependencyBadge } from "@/components/dependency-badge";
import { SubtaskList } from "@/components/subtask-list";
import { Badge, BadgeDot } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useTheme } from "@/hooks/use-theme";
import { getStatusDotColor, isBlockedBy, truncate } from "@/lib/bead-utils";
import { commentCountOf } from "@/lib/beads-parser";
import { computeEpicProgress, progressPercent } from "@/lib/epic-parser";
import { cn } from "@/lib/utils";
import { CardLiveChat } from "@/workbench/card-live";
import { WORKING, standing } from "@/types";
import type { Bead, Epic } from "@/types";

export interface EpicCardProps {
  /** Epic bead with children */
  epic: Epic;
  /** Every bead by id, built once for the whole board. */
  beadById: ReadonlyMap<string, Bead>;
  /**
   * Every bead's state by id, for asking whether this card is blocked. The
   * board builds it once; a card that builds its own builds a map of the whole
   * board on every pass.
   */
  statusById: ReadonlyMap<string, string>;
  /** Whether this epic is selected */
  isSelected?: boolean;
  /** Callback when selecting this epic */
  onSelect: (epic: Epic) => void;
  /** Callback when clicking a child task */
  onChildClick: (child: Bead) => void;
  /** Callback when navigating to a dependency */
  onNavigateToDependency?: (beadId: string) => void;
  /** Project root path for fetching design docs */
  projectPath?: string;
  /** Callback after board changes */
  onUpdate?: () => void;
}

/**
 * Get progress bar indicator color based on completion percentage
 */
function getProgressIndicatorClass(percentage: number): string {
  if (percentage === 100) return "[&>*]:bg-progress-100";
  if (percentage >= 75) return "[&>*]:bg-progress-75";
  if (percentage >= 50) return "[&>*]:bg-progress-50";
  if (percentage >= 25) return "[&>*]:bg-progress-25";
  return "[&>*]:bg-progress-0";
}

/**
 * Larger epic card with distinctive styling
 *
 * Remembered against its own props, like the plain card: a job card resolves
 * its children out of the whole board, and doing that again on every pass of a
 * board that had not changed was the most expensive thing on the screen.
 */
export const EpicCard = memo(function EpicCard({
  epic,
  beadById,
  statusById,
  isSelected = false,
  onSelect,
  onChildClick,
  onNavigateToDependency,
}: EpicCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Resolve children from IDs (memoized to prevent unnecessary re-fetches)
  const children = useMemo(() =>
    (epic.children || [])
      .map(childId => beadById.get(childId))
      .filter((b): b is Bead => b !== undefined),
    [epic.children, beadById]
  );

  // Worked out once per change of the board, not once per redraw: this card
  // redraws on every poll, and walking the whole board each time cost more than
  // three times what the walk itself costs.
  const progress = useMemo(
    () => computeEpicProgress(epic, beadById, statusById),
    [epic, beadById, statusById],
  );
  const progressPercentage = progressPercent(progress);

  const commentCount = commentCountOf(epic);

  // Nobody is waiting on this job any more, so it is drawn back — the same
  // reading the plain cards beside it use. Without it a finished or dropped job
  // sat at full strength in the Done and Cancelled columns while every plain
  // card around it was dimmed, and the loudest cards on the board were the two
  // nobody needs to look at.
  const isSettled = !standing(epic.status);

  const { layout } = useTheme();

  // Selecting the card is one real button, kept out of sight, with the card's
  // ring drawn when it has focus. The whole card used to be the button, and a
  // button may not hold others: the copy, dependency, child and chat controls
  // inside it were read as part of its name, and a key pressed on any of them
  // could open the card as well (bw-lf8i.4). A press anywhere else on the card
  // still selects it.
  const interactionProps = {
    "data-bead-id": epic.id,
    // Which card the press was about, for a reader with several jobs standing
    // in his column and for the checks that time the answer.
    onClick: () => onSelect(epic),
  };
  const selectButton = (
    <button
      type="button"
      data-card-select
      aria-label={`Select epic: ${epic.title}`}
      className="sr-only"
      onClick={(e) => { e.stopPropagation(); onSelect(epic); }}
    />
  );

  /**
   * How much of the job is done: the count, the bar, and what stands behind
   * the numbers. Every shape draws this one, so a reader is told the same
   * things about the same job whichever theme he is on — the default shape
   * used to keep its own copy, and it was the only shape saying what was in
   * progress, what was blocked and what had been dropped.
   *
   * @param wordy - The default shape spells the count out in words; the two
   *   denser shapes have room for the fraction alone.
   */
  const progressBlock = (wordy: boolean) => (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-t-tertiary">
          {wordy
            ? `Progress: ${progress.completed}/${progress.total} completed`
            : `${progress.completed}/${progress.total}`}
        </span>
        <span className="font-semibold text-t-secondary">{progressPercentage}%</span>
      </div>
      <Progress
        value={progressPercentage}
        aria-label={`Epic progress: ${progress.completed} of ${progress.total} completed`}
        className={cn(
          "h-2 bg-surface-overlay",
          getProgressIndicatorClass(progressPercentage)
        )}
      />
      {/* Each of these says something that is happening to the job, so a zero
          is not news — a card with nothing in flight, nothing dropped and
          nothing blocked says none of it rather than three denials. The whole
          row goes with them: an empty row is a gap under the bar. */}
      {(progress.inProgress > 0 || progress.dropped > 0 || progress.blocked > 0) && (
        <div className="flex items-center gap-3 text-[10px] text-t-muted">
          {progress.inProgress > 0 && (
            <span className="flex items-center gap-1">
              {/* The In Progress colour, taken off the one list of states — it
                  wore the Todo colour, so the dot named another state. */}
              <BadgeDot size="sm" solid className={getStatusDotColor(WORKING)} aria-hidden="true" />
              {progress.inProgress} in progress
            </span>
          )}
          {/* Dropped pieces are outside every number beside them, and the list
              below holds them, so the card says how many rather than leaving a
              full bar over a longer list unexplained. */}
          {progress.dropped > 0 && (
            <span className="flex items-center gap-1">
              <BadgeDot size="sm" solid className={getStatusDotColor('cancelled')} aria-hidden="true" />
              {progress.dropped} dropped
            </span>
          )}
          {progress.blocked > 0 && (
            <span className="flex items-center gap-1">
              <BadgeDot size="sm" solid className="text-danger" aria-hidden="true" />
              {progress.blocked} blocked
            </span>
          )}
        </div>
      )}
    </div>
  );

  const progressSection = progressBlock(false);

  // Shared children section. The heading only names the list; the list opens
  // from its own "more" line. The heading used to be the toggle, and its
  // chevron and expanded state said "closed" over a list already showing its
  // first three pieces.
  const childrenSection = (
    <div className="pt-2 border-t border-b-strong">
      <p data-testid="child-tasks-heading" className="mb-2 text-xs font-semibold text-epic">
        {/* What the job is made of, and what it dropped — never the two added
            together, which is the number the bar deliberately does not count. */}
        Child Tasks ({progress.dropped > 0
          ? `${progress.total} · ${progress.dropped} dropped`
          : children.length})
      </p>
      <SubtaskList
        childTasks={children}
        onChildClick={onChildClick}
        maxCollapsed={3}
        isExpanded={isExpanded}
        onToggle={() => setIsExpanded((open) => !open)}
      />
    </div>
  );

  // ─── Layout: compact-row (Linear Minimal) ───
  if (layout === 'compact-row') {
    return (
      <div
        {...interactionProps}
        className={cn(
          "theme-card relative cursor-pointer p-2.5 bg-card border border-epic/20",
          "hover:bg-surface-overlay/50",
          "has-[[data-card-select]:focus-visible]:ring-2 has-[[data-card-select]:focus-visible]:ring-epic",
          isSettled && "opacity-45",
          isSelected && "bg-epic/5 outline outline-1 outline-epic/20"
        )}
      >
        {selectButton}
        <div className="flex items-start gap-2.5">
          <Layers className="h-4 w-4 text-epic shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-t-muted font-mono shrink-0">{epic.id}</span>
              <span className="text-[13px] font-semibold text-t-primary truncate">{epic.title}</span>
              <Badge variant="epic" appearance="light" size="xs" className="theme-badge font-semibold shrink-0">
                Epic
              </Badge>
              <BeadTags bead={epic} className="shrink-0" />
            </div>
            {progressSection}

            {childrenSection}
            <CardLiveChat beadId={epic.id} />
          </div>
        </div>
      </div>
    );
  }

  // ─── Layout: property-tags (Notion Warm / GitHub Clean) ───
  if (layout === 'property-tags') {
    return (
      <div
        {...interactionProps}
        className={cn(
          "theme-card relative cursor-pointer p-3 bg-card border border-epic/30",
          "hover:bg-surface-inset/30",
          "has-[[data-card-select]:focus-visible]:ring-2 has-[[data-card-select]:focus-visible]:ring-epic",
          isSettled && "opacity-45",
          isSelected && "ring-2 ring-epic ring-offset-2 ring-offset-surface-base"
        )}
      >
        {selectButton}
        <div className="space-y-2">
          {/* Title */}
          <h3 className="font-semibold text-sm leading-tight text-t-primary">
            {truncate(epic.title, 70)}
          </h3>

          {epic.description && (
            <p className="text-xs text-t-muted leading-relaxed">{truncate(epic.description, 80)}</p>
          )}

          {/* Property tags */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" appearance="light" size="xs" className="theme-badge font-mono">
              {epic.id}
            </Badge>
            <Badge variant="epic" appearance="light" size="xs" className="theme-badge font-semibold">
              Epic
            </Badge>
            <Badge variant="secondary" appearance="light" size="xs" className="theme-badge">
              {/* The count only. What was dropped is said once, by the block
                  below, which this badge sits directly above. */}
              {progressPercentage}% · {progress.dropped > 0 ? progress.total : children.length} tasks
            </Badge>
            <BeadTags bead={epic} />
            {commentCount > 0 && (
              <span className="text-[10px] text-t-faint">{commentCount} comments</span>
            )}
          </div>
            <CardLiveChat beadId={epic.id} />

          {progressSection}

          {childrenSection}
        </div>
      </div>
    );
  }

  // ─── Layout: standard (Default / Glassmorphism / Neo-Brutalist / Soft Light) ───
  return (
    <div
      {...interactionProps}
      className={cn(
        "theme-card relative cursor-pointer p-4",
        "bg-surface-raised/70",
        "border border-b-default/60 border-l-2 border-l-epic",
        "has-[[data-card-select]:focus-visible]:ring-2 has-[[data-card-select]:focus-visible]:ring-epic has-[[data-card-select]:focus-visible]:ring-offset-2 has-[[data-card-select]:focus-visible]:ring-offset-surface-base",
        isSettled && "opacity-45",
        isSelected && "ring-2 ring-epic ring-offset-2 ring-offset-surface-base"
      )}
    >
      {selectButton}
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-epic" aria-hidden="true" />
            <span className="text-xs font-mono text-t-tertiary">
              <CopyableText copyText={epic.id}>{epic.id}</CopyableText>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <DependencyBadge
              deps={epic.deps}
              blockers={epic.blockers}
              isBlocked={isBlockedBy(epic, statusById)}
              onNavigate={onNavigateToDependency}
            />
            {/* The library already has a name for what a job is coloured, and
                the theme decides whether the word is shouted (bw-dks8.7). */}
            <Badge variant="epic" appearance="light" size="xs" className="theme-badge font-semibold">
              Epic
            </Badge>
          </div>
        </div>

        <h3 className="font-bold text-base leading-tight text-t-primary">{truncate(epic.title, 60)}</h3>

        <BeadTags bead={epic} />

        {epic.description && (
          <p className="text-xs text-t-tertiary leading-relaxed">{truncate(epic.description, 100)}</p>
        )}

        {progressBlock(true)}


        {childrenSection}

        {commentCount > 0 && (
          <div className="flex items-center gap-2 pt-2">
            {commentCount > 0 && (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <MessageSquare className="h-3 w-3" aria-hidden="true" />
                {commentCount} {commentCount === 1 ? "comment" : "comments"}
              </span>
            )}
          </div>
        )}
        <div className="px-3 pb-2">
          <CardLiveChat beadId={epic.id} />
        </div>
      </div>
    </div>
  );
});
