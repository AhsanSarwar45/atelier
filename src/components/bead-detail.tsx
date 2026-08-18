"use client";

import { useState, useEffect, useCallback, useMemo } from "react";

import {
  ArrowLeft,
  Calendar,
  Circle,
  Flag,
  Link2,
  Plus,
  X,
} from "lucide-react";

import { BeadPRSection } from "@/components/bead-pr-section";
import { CopyableText } from "@/components/copyable-text";
import { CreateBeadDialog } from "@/components/create-bead-dialog";
import { EditableField } from "@/components/editable-field";
import { MarkdownBody } from "@/components/markdown-body";
import { SubtaskList } from "@/components/subtask-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/hooks/use-toast";
import * as api from "@/lib/api";
import {
  formatBeadId,
  formatShortDate,
  formatStatus,
  formatWorktreePath,
  getStatusDotColor,
} from "@/lib/bead-utils";
import { updateTitle, updateDescription, updateStatus as cliUpdateStatus } from "@/lib/cli";
import { ISSUE_TYPES, getIssueTypeMeta } from "@/lib/issue-types";
import { cn, isDoltProject } from "@/lib/utils";
import { computeEpicProgress } from "@/lib/epic-parser";
import { SET_BY, STATES, STATE_BY_ID, standing, type Bead, type BeadStatus, type Epic, type WorktreeStatus } from "@/types";


/** Priority levels 0–4, displayed P0 (critical) … P4 (backlog). Single source for the editor options. */
const PRIORITY_OPTIONS = [
  { value: 0, label: "P0" },
  { value: 1, label: "P1" },
  { value: 2, label: "P2" },
  { value: 3, label: "P3" },
  { value: 4, label: "P4" },
] as const;

export interface BeadDetailProps {
  bead: Bead;
  ticketNumber?: number;
  worktreeStatus?: WorktreeStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: React.ReactNode;
  projectPath?: string;
  allBeads?: Bead[];
  onChildClick?: (child: Bead) => void;
  onCleanup?: () => void;
  onUpdate?: () => void;
}

/**
 * How long a side panel takes to slide, in milliseconds.
 *
 * The panel is mounted by whoever owns the address, so that owner has to keep it
 * alive for exactly this long after closing it or the slide out is cut off:
 * src/components/card-panel.tsx reads the same number.
 */
export const PANEL_SLIDE_MS = 300;

/**
 * Bead detail panel — slides in from the right.
 * Displays full bead information with metadata, PR section, subtasks, and comments.
 */
export function BeadDetail({
  bead,
  ticketNumber,
  worktreeStatus,
  open,
  onOpenChange,
  children,
  projectPath,
  allBeads,
  onChildClick,
  onCleanup,
  onUpdate,
}: BeadDetailProps) {
  /**
   * Whether the panel has been told to move yet.
   *
   * The panel is mounted at the same moment it is asked to open, so binding the
   * slide to `open` paints it already arrived and the browser has nothing to
   * animate from — that is why this one appeared instantly while every other
   * panel slid. Starting here at false parks it for the first paint, and the
   * effect below lets it go on the next one.
   */
  const [slid, setSlid] = useState(false);
  useEffect(() => {
    if (!open) {
      setSlid(false);
      return;
    }
    setSlid(true);
  }, [open]);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  const isReadOnly = !projectPath;
  const isDolt = projectPath ? isDoltProject(projectPath) : false;
  const typeMeta = getIssueTypeMeta(bead.issue_type);
  const TypeIcon = typeMeta.icon;

  const handleSaveTitle = useCallback(async (newTitle: string) => {
    if (!projectPath) return;
    try {
      if (isDolt) {
        await api.beads.update({ path: projectPath, id: bead.id, title: newTitle });
      } else {
        await updateTitle(bead.id, newTitle, projectPath);
      }
      onUpdate?.();
    } catch (err) {
      toast({ variant: "destructive", title: "Failed to update title", description: err instanceof Error ? err.message : "Unknown error" });
      throw err;
    }
  }, [bead.id, projectPath, isDolt, onUpdate]);

  const handleSaveDescription = useCallback(async (newDesc: string) => {
    if (!projectPath) return;
    try {
      if (isDolt) {
        await api.beads.update({ path: projectPath, id: bead.id, description: newDesc });
      } else {
        await updateDescription(bead.id, newDesc, projectPath);
      }
      onUpdate?.();
    } catch (err) {
      toast({ variant: "destructive", title: "Failed to update description", description: err instanceof Error ? err.message : "Unknown error" });
      throw err;
    }
  }, [bead.id, projectPath, isDolt, onUpdate]);

  const handleStatusChange = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (!projectPath) return;
    const newStatus = e.target.value as BeadStatus;
    const write = SET_BY[newStatus];
    try {
      if (isDolt) {
        await api.beads.update({
          path: projectPath, id: bead.id,
          status: write.status, add_label: write.addLabel,
          remove_label: write.removeLabel,
        });
      } else {
        await cliUpdateStatus(bead.id, newStatus, projectPath);
      }
      onUpdate?.();
    } catch (err) {
      toast({ variant: "destructive", title: "Failed to update status", description: err instanceof Error ? err.message : "Unknown error" });
    }
  }, [bead.id, projectPath, isDolt, onUpdate]);

  const handleSaveIssueType = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (!projectPath) return;
    const newIssueType = e.target.value;
    try {
      await api.beads.update({ path: projectPath, id: bead.id, issue_type: newIssueType });
      onUpdate?.();
    } catch (err) {
      toast({ variant: "destructive", title: "Failed to update type", description: err instanceof Error ? err.message : "Unknown error" });
    }
  }, [bead.id, projectPath, onUpdate]);

  const handleSavePriority = useCallback(async (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (!projectPath) return;
    const newPriority = Number(e.target.value);
    try {
      await api.beads.update({ path: projectPath, id: bead.id, priority: newPriority });
      onUpdate?.();
    } catch (err) {
      toast({ variant: "destructive", title: "Failed to update priority", description: err instanceof Error ? err.message : "Unknown error" });
    }
  }, [bead.id, projectPath, onUpdate]);

  const [isAddSubtaskOpen, setIsAddSubtaskOpen] = useState(false);
  const hasWorktree = worktreeStatus?.exists ?? false;
  const isEpic = bead.children && bead.children.length > 0;

  // Resolve children from IDs
  const childTasks = useMemo(() => {
    if (!isEpic || !allBeads) return [];
    return (bead.children || [])
      .map(childId => allBeads.find(b => b.id === childId))
      .filter((b): b is Bead => b !== undefined);
  }, [isEpic, bead.children, allBeads]);

  /**
   * The job's size, from the one counter the card reads. Working it out here
   * as well is how the panel and the card came to state two different sizes
   * for one job in the first place.
   */
  const progress = useMemo(
    () => computeEpicProgress(bead as Epic, allBeads ?? []),
    [bead, allBeads],
  );

  // Resolve related tasks from IDs
  const relatedTasks = useMemo(() => {
    if (!allBeads || !bead.relates_to || bead.relates_to.length === 0) return [];
    const beadMap = new Map(allBeads.map(b => [b.id, b]));
    return bead.relates_to
      .map(id => beadMap.get(id))
      .filter((b): b is Bead => b !== undefined);
  }, [bead.relates_to, allBeads]);

  // PR status for child tasks (epics only)
  const [childPRStatuses, setChildPRStatuses] = useState<Map<string, { state: "open" | "merged" | "closed"; checks: { status: "success" | "failure" | "pending" } }>>(new Map());

  const fetchChildPRStatuses = useCallback(async () => {
    if (!projectPath || isDoltProject(projectPath) || childTasks.length === 0) return;

    // Only pieces still standing can have work in flight — a dropped one is
    // work nobody is doing, so the code host is never asked about it.
    const results = await Promise.all(
      childTasks.filter(c => standing(c.status)).map(async (child) => {
        try {
          const prStatus = await api.git.prStatus(projectPath, child.id);
          if (prStatus.pr) {
            return { id: child.id, status: { state: prStatus.pr.state, checks: { status: prStatus.pr.checks.status } } };
          }
        } catch { /* ignore */ }
        return null;
      })
    );

    const statusMap = new Map<string, { state: "open" | "merged" | "closed"; checks: { status: "success" | "failure" | "pending" } }>();
    for (const result of results) {
      if (result) statusMap.set(result.id, result.status);
    }
    setChildPRStatuses(statusMap);
  }, [projectPath, childTasks]);

  useEffect(() => {
    if (!open || !isEpic || !projectPath || childTasks.length === 0) return;
    fetchChildPRStatuses();
    const intervalId = setInterval(fetchChildPRStatuses, 30_000);
    return () => clearInterval(intervalId);
  }, [open, isEpic, projectPath, childTasks, fetchChildPRStatuses]);

  return (
    <>
      {/* Overlay */}
      <div
        className={cn(
          "fixed inset-0 z-50 bg-black/80 transition-opacity ease-in-out",
          slid ? "opacity-100" : "opacity-0 pointer-events-none"
        )}
        style={{ transitionDuration: `${PANEL_SLIDE_MS}ms` }}
        onClick={() => onOpenChange(false)}
      />
      {/* Slide-in panel */}
      <div
        data-testid="bead-detail"
        data-bead-id={bead.id}
        className={cn(
          "fixed inset-y-0 right-0 z-50 w-full sm:max-w-lg md:max-w-xl overflow-y-auto bg-surface-base border-l border-b-default p-6 shadow-lg transition-transform ease-in-out",
          slid ? "translate-x-0" : "translate-x-full"
        )}
        style={{ transitionDuration: `${PANEL_SLIDE_MS}ms` }}
      >
          {/* Header with Back button */}
          <div className="flex items-center justify-between mb-6">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="gap-1.5 -ml-2"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back
            </Button>
          </div>

          <div className="space-y-4">
            {/* Ticket Number + Bead ID */}
            <p className="text-xs font-mono text-t-muted">
              {ticketNumber !== undefined && (
                <CopyableText copyText={`#${ticketNumber}`} className="font-semibold text-t-secondary">
                  #{ticketNumber}
                </CopyableText>
              )}
              {ticketNumber !== undefined && " "}
              <CopyableText copyText={bead.id}>
                {formatBeadId(bead.id, 8)}
              </CopyableText>
            </p>

            {/* Title */}
            <h2 className="text-xl font-semibold leading-tight text-t-primary">
              <EditableField
                value={bead.title}
                onSave={handleSaveTitle}
                disabled={isReadOnly}
              />
            </h2>

            {/* Worktree path */}
            {bead.issue_type !== "epic" && hasWorktree && worktreeStatus?.worktree_path && (
              <div className={cn(
                "font-mono text-xs text-t-muted",
                !standing(bead.status) && "opacity-40"
              )}>
                {formatWorktreePath(worktreeStatus.worktree_path)}
              </div>
            )}
          </div>

          {/* Inline Metadata Row */}
          <div className="mt-6 flex justify-center items-center gap-3 text-sm text-t-tertiary">
            <span className="flex items-center gap-1.5">
              <TypeIcon className="size-3.5" aria-hidden="true" />
              {isReadOnly ? (
                <span>{typeMeta.label}</span>
              ) : (
                <select
                  value={bead.issue_type}
                  onChange={handleSaveIssueType}
                  aria-label="Issue type"
                  className="bg-transparent border-none text-sm text-t-tertiary cursor-pointer hover:text-t-secondary focus:outline-none appearance-none"
                >
                  {ISSUE_TYPES.map((meta) => (
                    <option key={meta.value} value={meta.value}>{meta.label}</option>
                  ))}
                </select>
              )}
            </span>
            <span className="text-t-faint" aria-hidden="true">•</span>
            <span className="flex items-center gap-1.5">
              <Circle className={cn("size-2 fill-current", getStatusDotColor(bead.status))} aria-hidden="true" />
              {isReadOnly ? (
                <span>{formatStatus(bead.status)}</span>
              ) : (
                <select
                  value={bead.status}
                  onChange={handleStatusChange}
                  className="bg-transparent border-none text-sm text-t-tertiary cursor-pointer hover:text-t-secondary focus:outline-none appearance-none"
                >
                  {STATES.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              )}
            </span>
            <span className="text-t-faint" aria-hidden="true">•</span>
            <span className="flex items-center gap-1.5">
              <Flag className="size-3.5" aria-hidden="true" />
              {isReadOnly ? (
                <span>P{bead.priority}</span>
              ) : (
                <select
                  value={bead.priority}
                  onChange={handleSavePriority}
                  aria-label="Priority"
                  className="bg-transparent border-none text-sm text-t-tertiary cursor-pointer hover:text-t-secondary focus:outline-none appearance-none"
                >
                  {PRIORITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              )}
            </span>
            <span className="text-t-faint" aria-hidden="true">•</span>
            <span className="flex items-center gap-1.5">
              <Calendar className="size-3.5" aria-hidden="true" />
              <span>{formatShortDate(bead.created_at)}</span>
            </span>
          </div>

          {/* Why the work stopped. Dropped work is settled the same as finished
              work and an agent writes down why it dropped it, so asking for the
              finished state by name is what threw that reason away unread. */}
          {!standing(bead.status) && bead.close_reason && (
            <div className="mt-2 text-center text-xs text-t-muted">
              {STATE_BY_ID[bead.status as BeadStatus]?.label ?? "Closed"}:{" "}
              <span className="text-t-tertiary">{bead.close_reason}</span>
            </div>
          )}

          {/* Worktree & PR Section */}
          {hasWorktree && projectPath && (
            <BeadPRSection
              bead={bead}
              worktreeStatus={worktreeStatus}
              projectPath={projectPath}
              open={open}
              onCleanup={onCleanup}
            />
          )}

          {/* Description */}
          {(bead.description || !isReadOnly) && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold mb-2 text-t-secondary">Description</h3>
              <div className="h-px bg-b-default mb-3" />
              <div className="text-sm text-t-tertiary leading-relaxed">
                <EditableField
                  value={bead.description ?? ""}
                  onSave={handleSaveDescription}
                  disabled={isReadOnly}
                  multiline
                  placeholder="Add a description…"
                  renderValue={(v) => <MarkdownBody>{v}</MarkdownBody>}
                />
              </div>
            </div>
          )}

          {/* Design (collapsed by default; rendered as Markdown) */}
          {bead.design && (
            <details className="mt-6 group">
              <summary className="text-sm font-semibold text-t-secondary cursor-pointer list-none flex items-center gap-1.5 hover:text-t-primary">
                <span className="inline-block transition-transform group-open:rotate-90">▸</span>
                Design
              </summary>
              <div className="h-px bg-b-default my-2" />
              <MarkdownBody>{bead.design}</MarkdownBody>
            </details>
          )}

          {/* Notes (collapsed by default; rendered as Markdown) */}
          {bead.notes && (
            <details className="mt-6 group">
              <summary className="text-sm font-semibold text-t-secondary cursor-pointer list-none flex items-center gap-1.5 hover:text-t-primary">
                <span className="inline-block transition-transform group-open:rotate-90">▸</span>
                Notes
              </summary>
              <div className="h-px bg-b-default my-2" />
              <MarkdownBody>{bead.notes}</MarkdownBody>
            </details>
          )}

          {/* Related Tasks */}
          {relatedTasks.length > 0 && onChildClick && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold mb-2 text-t-secondary flex items-center gap-1.5">
                <Link2 className="size-3.5" aria-hidden="true" />
                Related Tasks ({relatedTasks.length})
              </h3>
              <div className="h-px bg-b-default mb-3" />
              <div className="rounded-lg border border-b-default bg-surface-raised/50 p-3">
                <div className="space-y-1">
                  {relatedTasks.map((related) => (
                    <button
                      key={related.id}
                      onClick={() => onChildClick(related)}
                      aria-label={`Open related task: ${related.title}`}
                      className={cn(
                        "w-full flex items-center gap-2 px-2 py-1.5 rounded-md",
                        "hover:bg-b-default transition-colors text-left",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-t-tertiary",
                        "group"
                      )}
                    >
                      <Circle
                        className={cn("size-2 flex-shrink-0 fill-current", getStatusDotColor(related.status))}
                        aria-hidden="true"
                      />
                      <span className="text-[10px] font-mono text-t-muted flex-shrink-0">
                        {formatBeadId(related.id)}
                      </span>
                      {/* Struck through when nobody is waiting on it, finished
                          or dropped alike — the same reading as everywhere. */}
                      <span className={cn(
                        "text-xs font-medium flex-1 min-w-0 truncate group-hover:underline",
                        standing(related.status) ? "text-t-secondary" : "line-through text-t-muted"
                      )}>
                        {related.title}
                      </span>
                      <Badge variant="outline" size="xs" className="flex-shrink-0">
                        {formatStatus(related.status)}
                      </Badge>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Subtasks (for epics) */}
          {isEpic && onChildClick && (
            <div className="mt-6">
              <div className="flex items-center justify-between mb-2">
                {/* The same size the card states: what the job is made of and
                    what it dropped, never the two added together. Two screens
                    giving one job two sizes is what this reads against. */}
                <h3 className="text-sm font-semibold text-t-secondary">
                  Subtasks ({progress.dropped > 0
                    ? `${progress.total} · ${progress.dropped} dropped`
                    : childTasks.length})
                </h3>
                {projectPath && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsAddSubtaskOpen(true)}
                    className="h-7 px-2 gap-1 text-xs text-success hover:text-success"
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    Add subtask
                  </Button>
                )}
              </div>
              <div className="h-px bg-b-default mb-3" />
              <div className="rounded-lg border border-b-default bg-surface-raised/50 p-3">
                <SubtaskList
                  childTasks={childTasks}
                  onChildClick={onChildClick}
                  isExpanded={true}
                  childPRStatuses={childPRStatuses}
                />
              </div>
            </div>
          )}

          {/* Children slot for comments + timeline */}
          {children && <div className="mt-6">{children}</div>}

        {/* Close button */}
        <button
          data-testid="bead-detail-close"
          aria-label="Close the card"
          onClick={() => onOpenChange(false)}
          className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        >
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </button>
      </div>

      {/* Add Subtask Dialog (for epics) */}
      {projectPath && isEpic && (
        <CreateBeadDialog
          open={isAddSubtaskOpen}
          onOpenChange={setIsAddSubtaskOpen}
          projectPath={projectPath}
          onCreated={() => onUpdate?.()}
          parentId={bead.id}
        />
      )}
    </>
  );
}
