"use client";

import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from "react";

import { CheckCircle2, ChevronDown, ChevronRight, Layers, Loader2, MessageSquare } from "lucide-react";

import { BeadTags } from "@/components/bead-tags";
import { CopyableText } from "@/components/copyable-text";
import { DependencyBadge } from "@/components/dependency-badge";
import { SubtaskList, ChildPRStatus } from "@/components/subtask-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useTheme } from "@/hooks/use-theme";
import * as api from "@/lib/api";
import { formatBeadId, getStatusDotColor, isBlockedBy, truncate } from "@/lib/bead-utils";
import { closeBead } from "@/lib/cli";
import { computeEpicProgress, progressPercent } from "@/lib/epic-parser";
import { cn, isDoltProject } from "@/lib/utils";
import { CardLiveChat } from "@/workbench/card-live";
import { WORKING, standing } from "@/types";
import type { Bead, Epic, EpicProgress } from "@/types";

export interface EpicCardProps {
  /** Epic bead with children */
  epic: Epic;
  /** All beads to resolve children */
  allBeads: Bead[];
  /**
   * Every bead's state by id, for asking whether this card is blocked. The
   * board builds it once; a card that builds its own builds a map of the whole
   * board on every pass.
   */
  statusById: ReadonlyMap<string, string>;
  /** Ticket number for display */
  ticketNumber?: number;
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
  /** Callback after epic is closed (to refresh board) */
  onUpdate?: () => void;
  /** Sits with the card's other facts, beside the comment count. */
  report?: ReactNode;
}

/**
 * Compute epic progress from children
 * Uses epic-parser utility for proper dependency resolution
 */
function computeProgress(epic: Epic, allBeads: Bead[]): EpicProgress {
  return computeEpicProgress(epic, allBeads);
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

/** Auto-refresh interval for PR statuses (30 seconds) */
const PR_STATUS_REFRESH_INTERVAL = 30_000;

/**
 * Larger epic card with distinctive styling
 */

export function EpicCard({
  epic,
  allBeads,
  statusById,
  ticketNumber,
  isSelected = false,
  onSelect,
  onChildClick,
  onNavigateToDependency,
  projectPath,
  onUpdate,
  report
}: EpicCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  // PR status for child tasks
  const [childPRStatuses, setChildPRStatuses] = useState<Map<string, ChildPRStatus>>(new Map());
  const isMountedRef = useRef(true);

  // Resolve children from IDs (memoized to prevent unnecessary re-fetches)
  const children = useMemo(() =>
    (epic.children || [])
      .map(childId => allBeads.find(b => b.id === childId))
      .filter((b): b is Bead => b !== undefined),
    [epic.children, allBeads]
  );

  // Fetch PR status for all children
  const fetchChildPRStatuses = useCallback(async () => {
    if (!projectPath || isDoltProject(projectPath) || children.length === 0) return;

    const statusMap = new Map<string, ChildPRStatus>();

    // Only pieces still standing can have work in flight: a finished one needs
    // no reading, and a dropped one is work nobody is doing, so asking the code
    // host about it is a request per piece every thirty seconds for an answer
    // that would be drawn against abandoned work.
    const results = await Promise.all(
      children.filter(c => standing(c.status)).map(async (child) => {
        try {
          const prStatus = await api.git.prStatus(projectPath, child.id);
          if (prStatus.pr) {
            return {
              id: child.id,
              status: {
                state: prStatus.pr.state,
                checks: { status: prStatus.pr.checks.status },
              } as ChildPRStatus,
            };
          }
        } catch {
          // Ignore errors for individual children
        }
        return null;
      })
    );

    // Build the map from results
    for (const result of results) {
      if (result) {
        statusMap.set(result.id, result.status);
      }
    }

    // Only update state if component is still mounted
    if (isMountedRef.current) {
      setChildPRStatuses(statusMap);
    }
  }, [projectPath, children]);

  // Fetch PR statuses on mount and set up auto-refresh interval
  useEffect(() => {
    isMountedRef.current = true;

    // Initial fetch
    fetchChildPRStatuses();

    // Set up auto-refresh interval
    const intervalId = setInterval(() => {
      fetchChildPRStatuses();
    }, PR_STATUS_REFRESH_INTERVAL);

    return () => {
      isMountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [fetchChildPRStatuses]);

  const progress = computeProgress(epic, allBeads);
  const progressPercentage = progressPercent(progress);

  const commentCount = (epic.comments ?? []).length;

  // Nobody is waiting on this job any more, so it is drawn back — the same
  // reading the plain cards beside it use. Without it a finished or dropped job
  // sat at full strength in the Done and Cancelled columns while every plain
  // card around it was dimmed, and the loudest cards on the board were the two
  // nobody needs to look at.
  const isSettled = !standing(epic.status);

  // Manager Review is the one column a session may not move a card out of, so the
  // screen is the only place a job there can be finished. Agent Review draws no
  // such button: a job waiting to be read has not been signed by anyone yet.
  // Asked of the pieces, not of the percentage: a job of two hundred with one
  // still open rounds to a hundred, and offering the sign-off there is offering
  // it on unfinished work.
  const allDone = progress.total > 0 && progress.completed === progress.total;
  const canCloseEpic = allDone && epic.status === 'manager_review';

  /**
   * Handle closing the epic
   */
  const handleCloseEpic = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isClosing) return;

    setIsClosing(true);
    try {
      await closeBead(epic.id, projectPath);
      onUpdate?.();
    } catch (error) {
      console.error('Failed to close epic:', error);
    } finally {
      setIsClosing(false);
    }
  };

  const { layout } = useTheme();

  // Shared interaction props
  const interactionProps = {
    "data-bead-id": epic.id,
    role: "button" as const,
    tabIndex: 0,
    "aria-label": `Select epic: ${epic.title}`,
    onClick: () => onSelect(epic),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(epic);
      }
    },
  };

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
              <div className={cn("w-2 h-2 rounded-full bg-current", getStatusDotColor(WORKING))} aria-hidden="true" />
              {progress.inProgress} in progress
            </span>
          )}
          {/* Dropped pieces are outside every number beside them, and the list
              below holds them, so the card says how many rather than leaving a
              full bar over a longer list unexplained. */}
          {progress.dropped > 0 && (
            <span className="flex items-center gap-1">
              <div className={cn("w-2 h-2 rounded-full bg-current", getStatusDotColor('cancelled'))} aria-hidden="true" />
              {progress.dropped} dropped
            </span>
          )}
          {progress.blocked > 0 && (
            <span className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-danger" aria-hidden="true" />
              {progress.blocked} blocked
            </span>
          )}
        </div>
      )}
    </div>
  );

  const progressSection = progressBlock(false);

  // Shared children section
  const childrenSection = (
    <div className="pt-2 border-t border-b-strong">
      <button
        onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} child tasks`}
        className="flex items-center gap-1 text-xs font-semibold text-epic hover:text-epic/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-epic rounded mb-2"
      >
        {isExpanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
        {/* What the job is made of, and what it dropped — never the two added
            together, which is the number the bar deliberately does not count. */}
        Child Tasks ({progress.dropped > 0
          ? `${progress.total} · ${progress.dropped} dropped`
          : children.length})
      </button>
      <SubtaskList
        childTasks={children}
        onChildClick={onChildClick}
        maxCollapsed={3}
        isExpanded={isExpanded}
        childPRStatuses={childPRStatuses}
      />
    </div>
  );

  // The manager's sign-off, named for what he is doing rather than for the card
  // it acts on.
  const closeButton = canCloseEpic && (
    <div className="pt-2">
      <Button
        variant="outline"
        size="xs"
        onClick={handleCloseEpic}
        disabled={isClosing}
        className="w-full border-success/30 text-success hover:bg-success/10 hover:text-success/80"
      >
        {isClosing ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="size-3" aria-hidden="true" />}
        {isClosing ? 'Marking…' : 'Mark Done'}
      </Button>
    </div>
  );

  // ─── Layout: compact-row (Linear Minimal) ───
  if (layout === 'compact-row') {
    return (
      <div
        {...interactionProps}
        className={cn(
          "theme-card cursor-pointer p-2.5 bg-card border border-epic/20",
          "hover:bg-surface-overlay/50",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-epic",
          isSettled && "opacity-45",
          isSelected && "bg-epic/5 outline outline-1 outline-epic/20"
        )}
      >
        <div className="flex items-start gap-2.5">
          <Layers className="h-4 w-4 text-epic shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-t-muted font-mono shrink-0">{formatBeadId(epic.id)}</span>
              <span className="text-[13px] font-semibold text-t-primary truncate">{epic.title}</span>
              <span className="text-[10px] font-semibold text-epic shrink-0">EPIC</span>
              <BeadTags bead={epic} className="shrink-0" />
            </div>
            {progressSection}
            {closeButton}
            {childrenSection}
            {report}
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
          "theme-card cursor-pointer p-3 bg-card border border-epic/30",
          "hover:bg-surface-inset/30",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-epic",
          isSettled && "opacity-45",
          isSelected && "ring-2 ring-epic ring-offset-2 ring-offset-surface-base"
        )}
      >
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
              {ticketNumber !== undefined && `#${ticketNumber} `}{formatBeadId(epic.id)}
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
            {report}
          </div>
            <CardLiveChat beadId={epic.id} />

          {progressSection}
          {closeButton}
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
        "theme-card cursor-pointer p-4",
        "bg-surface-raised/70",
        "border border-b-default/60 border-l-2 border-l-epic",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-epic focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
        isSettled && "opacity-45",
        isSelected && "ring-2 ring-epic ring-offset-2 ring-offset-surface-base"
      )}
    >
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-epic" aria-hidden="true" />
            <span className="text-xs font-mono text-t-tertiary">
              {ticketNumber !== undefined && (
                <CopyableText copyText={`#${ticketNumber}`} className="font-semibold text-t-primary">
                  #{ticketNumber}
                </CopyableText>
              )}
              {ticketNumber !== undefined && " "}
              <CopyableText copyText={epic.id}>{formatBeadId(epic.id)}</CopyableText>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <DependencyBadge
              deps={epic.deps}
              blockers={epic.blockers}
              isBlocked={isBlockedBy(epic, statusById)}
              onNavigate={onNavigateToDependency}
            />
            <Badge variant="outline" className="text-[10px] px-2 py-0.5 border-epic/30 text-epic bg-epic/20 font-semibold">EPIC</Badge>
          </div>
        </div>

        <h3 className="font-bold text-base leading-tight text-t-primary">{truncate(epic.title, 60)}</h3>

        <BeadTags bead={epic} />

        {epic.description && (
          <p className="text-xs text-t-tertiary leading-relaxed">{truncate(epic.description, 100)}</p>
        )}

        {progressBlock(true)}

        {closeButton}
        {childrenSection}

        {(commentCount > 0 || report) && (
          <div className="flex items-center gap-2 pt-2">
            {commentCount > 0 && (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <MessageSquare className="h-3 w-3" aria-hidden="true" />
                {commentCount} {commentCount === 1 ? "comment" : "comments"}
              </span>
            )}
            {report}
          </div>
        )}
        <div className="px-3 pb-2">
          <CardLiveChat beadId={epic.id} />
        </div>
      </div>
    </div>
  );
}
