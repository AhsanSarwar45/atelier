"use client";

import { useState, useCallback, useMemo } from "react";

import {
  ArrowLeft,
  Calendar,
  Circle,
  Flag,
  Link2,
  Plus,
} from "lucide-react";

import { CopyableText } from "@/components/copyable-text";
import { CreateBeadDialog } from "@/components/create-bead-dialog";
import { EditableField } from "@/components/editable-field";
import { MarkdownBody } from "@/components/markdown-body";
import { SubtaskList } from "@/components/subtask-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { toast } from "@/hooks/use-toast";
import * as api from "@/lib/api";
import {
  formatBeadId,
  formatShortDate,
  formatStatus,
  formatWorktreePath,
  getStatusDotColor,
  whyItStopped,
} from "@/lib/bead-utils";
import { updateTitle, updateDescription, updateStatus as cliUpdateStatus } from "@/lib/cli";
import { ISSUE_TYPES, getIssueTypeMeta } from "@/lib/issue-types";
import { cn, isDoltProject } from "@/lib/utils";
import { computeEpicProgress } from "@/lib/epic-parser";
import { SET_BY, STATES, standing, type Bead, type BeadStatus, type Epic, type WorktreeStatus } from "@/types";


/** Priority levels 0–4, displayed P0 (critical) … P4 (backlog). Single source for the editor options. */
const PRIORITY_OPTIONS = [
  { value: 0, label: "P0" },
  { value: 1, label: "P1" },
  { value: 2, label: "P2" },
  { value: 3, label: "P3" },
  { value: 4, label: "P4" },
] as const;

/**
 * The metadata row's pickers, worn thin.
 *
 * Four boxed triggers side by side are wider than a phone, and this row reads as
 * a sentence of facts rather than a form. Only the box is dropped: the list that
 * drops down is still the library's, which is the half a reader could tell apart
 * from the rest of the app at a glance.
 */
const INLINE_PICKER =
  "h-auto w-auto gap-1 border-0 bg-transparent p-0 text-sm text-t-tertiary shadow-none " +
  "hover:text-t-secondary focus:ring-0 focus:ring-offset-0";

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
  onUpdate?: () => void;
}

/**
 * How long a side panel takes to slide out, in milliseconds.
 *
 * The sheet's own closing duration, which it sets in src/components/ui/sheet.tsx.
 * The panel is mounted by whoever owns the address, so that owner has to keep it
 * alive for exactly this long after closing it or the slide out is cut off:
 * src/components/card-panel.tsx reads the same number.
 */
export const PANEL_SLIDE_MS = 300;

/**
 * Bead detail panel — slides in from the right.
 * Displays full bead information with metadata, subtasks, and comments.
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
  onUpdate,
}: BeadDetailProps) {
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

  const handleStatusChange = useCallback(async (value: string) => {
    if (!projectPath) return;
    const newStatus = value as BeadStatus;
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

  const handleSaveIssueType = useCallback(async (newIssueType: string) => {
    if (!projectPath) return;
    try {
      await api.beads.update({ path: projectPath, id: bead.id, issue_type: newIssueType });
      onUpdate?.();
    } catch (err) {
      toast({ variant: "destructive", title: "Failed to update type", description: err instanceof Error ? err.message : "Unknown error" });
    }
  }, [bead.id, projectPath, onUpdate]);

  const handleSavePriority = useCallback(async (value: string) => {
    if (!projectPath) return;
    const newPriority = Number(value);
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
    () => computeEpicProgress(
      bead as Epic,
      allBeads ?? [],
      new Map((allBeads ?? []).map((b) => [b.id, b.status])),
    ),
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

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        {/* The panel carries its own way out, so the sheet leaves out the cross
            it would otherwise draw in the far corner (bw-81wt.6). The card's own
            words are the heading; there is no separate line describing it. */}
        <SheetContent
          side="right"
          hideClose
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // Left to itself the sheet lands on Back, which then wears a focus
            // ring the instant the panel appears — a bright box around the way
            // out, on a panel opened to read a card. The panel takes the focus
            // instead, so Tab still walks into it rather than back to the board.
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
          data-testid="bead-detail"
          data-bead-id={bead.id}
          className="w-full sm:max-w-lg md:max-w-xl overflow-y-auto bg-surface-base border-b-default p-4 sm:p-6"
        >
          {/* The one way out. There used to be two — this and a cross in the
              far corner — which on a phone is two controls saying the same
              thing at opposite ends of a screen you hold in one hand. The
              cross was the smaller and the less clear of the two, so this is
              what stayed, and it carries the cross's name (bw-81wt.6). */}
          <div className="flex items-center justify-between mb-6">
            <Button
              variant="ghost"
              size="sm"
              data-testid="bead-detail-close"
              aria-label="Close the card"
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
            <SheetTitle className="text-xl font-semibold leading-tight text-t-primary">
              <EditableField
                value={bead.title}
                onSave={handleSaveTitle}
                disabled={isReadOnly}
              />
            </SheetTitle>

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

          {/* Inline Metadata Row. It wraps: on a phone the four facts and the
              date are wider than the screen, and a row that will not wrap
              strings the date down the side three characters at a time. */}
          <div className="mt-6 flex flex-wrap justify-center items-center gap-x-3 gap-y-2 text-sm text-t-tertiary">
            <span className="flex items-center gap-1.5">
              <TypeIcon className="size-3.5" aria-hidden="true" />
              {isReadOnly ? (
                <span>{typeMeta.label}</span>
              ) : (
                <Select value={bead.issue_type} onValueChange={handleSaveIssueType}>
                  <SelectTrigger aria-label="Issue type" className={INLINE_PICKER}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ISSUE_TYPES.map((meta) => (
                      <SelectItem key={meta.value} value={meta.value}>{meta.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </span>
            <span className="text-t-faint" aria-hidden="true">•</span>
            <span className="flex items-center gap-1.5">
              <Circle className={cn("size-2 fill-current", getStatusDotColor(bead.status))} aria-hidden="true" />
              {isReadOnly ? (
                <span>{formatStatus(bead.status)}</span>
              ) : (
                <Select value={bead.status} onValueChange={handleStatusChange}>
                  <SelectTrigger aria-label="Status" className={INLINE_PICKER}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATES.map((state) => (
                      <SelectItem key={state.id} value={state.id}>{state.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </span>
            <span className="text-t-faint" aria-hidden="true">•</span>
            <span className="flex items-center gap-1.5">
              <Flag className="size-3.5" aria-hidden="true" />
              {isReadOnly ? (
                <span>P{bead.priority}</span>
              ) : (
                <Select value={String(bead.priority)} onValueChange={handleSavePriority}>
                  <SelectTrigger aria-label="Priority" className={INLINE_PICKER}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
              {formatStatus(bead.status as BeadStatus)}:{" "}
              <span className="text-t-tertiary">
                {whyItStopped(bead.status as BeadStatus, bead.close_reason)}
              </span>
            </div>
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
              <Panel inset="md">
                <div className="space-y-1">
                  {relatedTasks.map((related) => (
                    <Button
                      key={related.id}
                      variant="ghost"
                      onClick={() => onChildClick(related)}
                      aria-label={`Open related task: ${related.title}`}
                      className="group h-auto w-full justify-start gap-2 px-2 py-1.5 text-left font-normal"
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
                    </Button>
                  ))}
                </div>
              </Panel>
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
              <Panel inset="md">
                <SubtaskList
                  childTasks={childTasks}
                  onChildClick={onChildClick}
                  isExpanded={true}
                />
              </Panel>
            </div>
          )}

          {/* Children slot for comments + timeline */}
          {children && <div className="mt-6">{children}</div>}
        </SheetContent>
      </Sheet>

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
