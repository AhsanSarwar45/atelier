"use client";

import { useMemo, useRef, useState, useCallback, useEffect } from "react";

import { useSearchParams, useRouter } from "next/navigation";

import { ArrowLeft, EllipsisVertical } from "lucide-react";

import { ActivityTimeline } from "@/components/activity-timeline";
import { AgentsPanel } from "@/components/agents-panel";
import { BeadDetail } from "@/components/bead-detail";
import { CommentList } from "@/components/comment-list";
import { CreateBeadDialog } from "@/components/create-bead-dialog";
import { ErrorBoundary } from "@/components/error-boundary";
import { KanbanColumn } from "@/components/kanban-column";
import { MemoryPanel } from "@/components/memory-panel";
import { ProjectSettingsDialog } from "@/components/project-settings-dialog";
import { QuickFilterBar } from "@/components/quick-filter-bar";
import { ReportPanel } from "@/components/report-panel";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogClose,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useBeadDetail } from "@/hooks/use-bead-detail";
import { useBeadFilters } from "@/hooks/use-bead-filters";
import { useBeads } from "@/hooks/use-beads";
import { useGitHubStatus } from "@/hooks/use-github-status";
import { useKeyboardNavigation } from "@/hooks/use-keyboard-navigation";
import { useProject } from "@/hooks/use-project";
import { useTheme } from "@/hooks/use-theme";
import { useWorktreeStatuses } from "@/hooks/use-worktree-statuses";
import { columnFor, drawnInColumns, isBlocked, oldestFirst } from "@/lib/bead-utils";
import { getUnknownStatusBeads, getUnknownStatusNames } from "@/lib/beads-parser";
import { getIssueTypeMeta } from "@/lib/issue-types";
import type { IssueTypeFilter } from "@/lib/issue-types";
import { isDoltProject, projectDir } from "@/lib/utils";
import { STATES, type Bead, type BeadStatus } from "@/types";

/**
 * The columns, read off the one list of states. Their names and meanings are
 * the manager's, 2026-08-13: nobody on it; being worked in its own tree;
 * written and waiting for a second agent to read it; landed and waiting for his
 * own signature; final; dropped.
 */
const COLUMNS: { status: BeadStatus; title: string }[] =
  STATES.map((s) => ({ status: s.id, title: s.column }));

/**
 * Main Kanban board component with 4 columns, search, filter, and keyboard navigation
 */
export default function KanbanBoard() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const projectId = searchParams.get('id');

  // Fetch project data from SQLite
  const {
    project,
    isLoading: projectLoading,
    error: projectError,
    refetch: refetchProject,
  } = useProject(projectId);

  // Fetch beads from project path
  const {
    beads,
    ticketNumbers,
    isLoading: beadsLoading,
    error: beadsError,
    refresh: refreshBeads,
  } = useBeads(project?.path ?? "");

  // Use the bead filters hook with 300ms debounce
  const {
    filters,
    setFilters,
    filteredBeads,
    clearFilters,
    hasActiveFilters,
    availableOwners,
    availableTags,
  } = useBeadFilters(beads, ticketNumbers, 300);

  // Issue type filter state ("all" or a specific issue type)
  const [typeFilter, setTypeFilter] = useState<IssueTypeFilter>("all");

  // Dolt project detection and filesystem path resolution
  const isDolt = isDoltProject(project?.path);
  const isDoltOnly = isDolt && !project?.localPath;
  const fsPath = projectDir(project);

  // GitHub status check
  const { hasRemote, isAuthenticated, isLoading: githubStatusLoading } = useGitHubStatus(
    fsPath || null
  );

  // Track whether the GitHub warning has been dismissed (session-only)
  const [githubWarningDismissed, setGithubWarningDismissed] = useState(false);

  // Theme
  const { theme } = useTheme();

  // Memory panel state
  const [isMemoryOpen, setIsMemoryOpen] = useState(false);

  // Agents panel state
  const [isAgentsOpen, setIsAgentsOpen] = useState(false);

  // Reports panel state
  const [isReportsOpen, setIsReportsOpen] = useState(false);

  // Create bead dialog state
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  // Project settings dialog state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Show GitHub warning if project loaded, status checked, and either no remote or not authenticated
  const showGitHubWarning = !projectLoading &&
    !githubStatusLoading &&
    project !== null &&
    !githubWarningDismissed &&
    (!hasRemote || !isAuthenticated);

  /**
   * Toggle a status in the filter
   */
  const toggleStatus = useCallback((status: BeadStatus) => {
    const newStatuses = filters.statuses.includes(status)
      ? filters.statuses.filter(s => s !== status)
      : [...filters.statuses, status];
    setFilters({ statuses: newStatuses });
  }, [filters.statuses, setFilters]);

  /**
   * Toggle an owner in the filter
   */
  const toggleOwner = useCallback((owner: string) => {
    const newOwners = filters.owners.includes(owner)
      ? filters.owners.filter(o => o !== owner)
      : [...filters.owners, owner];
    setFilters({ owners: newOwners });
  }, [filters.owners, setFilters]);

  /**
   * Toggle a tag in the filter
   */
  const toggleTag = useCallback((tag: string) => {
    const newTags = filters.tags.includes(tag)
      ? filters.tags.filter(t => t !== tag)
      : [...filters.tags, tag];
    setFilters({ tags: newTags });
  }, [filters.tags, setFilters]);

  // Filter out closed beads to avoid unnecessary polling for finalized tasks
  const beadIds = useMemo(() => beads.filter(b => b.status !== 'closed').map(b => b.id), [beads]);

  // Worktree statuses for PR workflow (skip for dolt-only projects)
  const { statuses: worktreeStatuses } = useWorktreeStatuses(
    isDoltOnly ? "" : fsPath,
    isDoltOnly ? [] : beadIds
  );

  /**
   * The cards the columns draw (drawnInColumns owns which those are), then the
   * issue type filter ("all" or a specific type). Unknown/missing issue types
   * resolve to "task" via getIssueTypeMeta.
   */
  const topLevelBeads = useMemo(() => {
    const topLevel = drawnInColumns(filteredBeads);

    // Apply issue type filter
    if (typeFilter === "all") return topLevel;
    return topLevel.filter(b => getIssueTypeMeta(b.issue_type).value === typeFilter);
  }, [filteredBeads, typeFilter]);

  /**
   * Group the drawn beads into columns. A card sits where the pieces directly
   * under it put it (columnFor), so a started job is not left in Todo and an
   * untouched one is never drawn as waiting on a reader.
   * Defensive: falls back to 'open' for any column not among the 6.
   */
  const filteredBeadsByStatus = useMemo(() => {
    const grouped: Record<BeadStatus, Bead[]> = {
      open: [],
      in_progress: [],
      inreview: [],
      manager_review: [],
      closed: [],
      cancelled: [],
    };
    const byId = new Map(beads.map(b => [b.id, b]));
    for (const bead of topLevelBeads) {
      const live = columnFor(bead, byId) as BeadStatus;
      const column = grouped[live] ? live : 'open';
      grouped[column].push(bead);
    }
    grouped.manager_review = oldestFirst(grouped.manager_review);
    return grouped;
  }, [topLevelBeads, beads]);

  /**
   * Detect beads with truly unknown statuses for the warning indicator.
   */
  const unknownStatusBeads = useMemo(() => getUnknownStatusBeads(beads), [beads]);
  const unknownStatusNames = useMemo(() => getUnknownStatusNames(beads), [beads]);

  // Detail panel state
  const {
    detailBead,
    isDetailOpen,
    openBead,
    handleDetailOpenChange,
    navigateToBead,
  } = useBeadDetail(beads);

  // Ref for search input (keyboard navigation)
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Keyboard navigation (use top-level beads for navigation)
  const { selectedId } = useKeyboardNavigation({
    beads: topLevelBeads,
    beadsByStatus: filteredBeadsByStatus,
    selectedId: null,
    onSelect: () => {
      // Just highlight, don't open detail
    },
    onOpen: (bead) => {
      openBead(bead);
    },
    onClose: () => {
      handleDetailOpenChange(false);
    },
    searchInputRef,
    isDetailOpen,
  });

  // Redirect if no project ID
  useEffect(() => {
    if (!projectId) {
      router.replace("/");
    }
  }, [projectId, router]);


  // Redirect state while no project ID
  if (!projectId) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-surface-base">
        <p className="text-t-muted">Redirecting…</p>
      </div>
    );
  }

  // Show loading state
  if (projectLoading) {
    return (
      <div className="flex items-center justify-center min-h-dvh bg-surface-base">
        <div role="status" className="text-t-muted">Loading project…</div>
      </div>
    );
  }

  // Show project error state
  if (projectError) {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh bg-surface-base gap-4">
        <div role="alert" className="text-danger">Error: {projectError.message}</div>
        <Button variant="outline" asChild>
          <a href="/">Back to projects</a>
        </Button>
      </div>
    );
  }

  // Project not found
  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center min-h-dvh bg-surface-base gap-4">
        <div className="text-t-muted">Project not found</div>
        <Button variant="outline" asChild>
          <a href="/">Back to projects</a>
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-surface-base flex flex-col">
      {/* Header — terminal variant for neo-brutalist, standard otherwise */}
      {theme.headerVariant === 'terminal' ? (
        <div className="flex items-center justify-between px-6 py-4 terminal-header">
          <h1 className="font-mono text-xl font-bold tracking-wide">
            <a href="/" className="hover:opacity-80">&gt;</a>{' '}
            <span className="uppercase">{project.name}_</span>
          </h1>
          <span className="font-mono text-xs text-t-muted uppercase tracking-widest">
            {beads.length} beads // {beads.filter(b => b.issue_type === 'epic').length} epics // {beads.filter(b => isBlocked(b, beads)).length} blocked
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-4 py-2">
          <Button variant="ghost" size="icon" asChild>
            <a href="/">
              <ArrowLeft className="h-4 w-4" />
              <span className="sr-only">Back to projects</span>
            </a>
          </Button>
          <h1 className="text-lg font-semibold truncate">{project.name}</h1>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            aria-label="Project settings"
            onClick={() => setIsSettingsOpen(true)}
          >
            <EllipsisVertical className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* Quick Filter Bar */}
      <div className="flex justify-center px-4 pb-3">
        <QuickFilterBar
          // Search
          search={filters.search}
          onSearchChange={(value) => setFilters({ search: value })}
          searchInputRef={searchInputRef}
          // Type filter
          typeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
          // Today
          todayOnly={filters.todayOnly}
          onTodayOnlyChange={(value) => setFilters({ todayOnly: value })}
          // Sort
          sortField={filters.sortField}
          sortDirection={filters.sortDirection}
          onSortChange={(field, direction) => setFilters({ sortField: field, sortDirection: direction })}
          // Status/Owner filters
          statuses={filters.statuses}
          onStatusToggle={toggleStatus}
          owners={filters.owners}
          onOwnerToggle={toggleOwner}
          availableOwners={availableOwners}
          // Tag filter
          tags={filters.tags}
          onTagToggle={toggleTag}
          onTagsClear={() => setFilters({ tags: [] })}
          availableTags={availableTags}
          onClearFilters={clearFilters}
          hasActiveFilters={hasActiveFilters}
          // Memory
          isMemoryOpen={isMemoryOpen}
          onMemoryToggle={() => setIsMemoryOpen((prev) => !prev)}
          // Agents
          isAgentsOpen={isAgentsOpen}
          onAgentsToggle={() => setIsAgentsOpen((prev) => !prev)}
          isReportsOpen={isReportsOpen}
          onReportsToggle={() => setIsReportsOpen((prev) => !prev)}
          // Filesystem features require a real project path
          hasProjectPath={!isDoltOnly}
          // Unknown status warning
          unknownStatusCount={unknownStatusBeads.length}
          unknownStatusNames={unknownStatusNames}
          onNewBead={() => setIsCreateOpen(true)}
        />
      </div>

      {/* Kanban Columns. A column narrower than --column-min is unreadable, so
          past that the board scrolls sideways instead of cramming every column
          into the window. */}
      <main className="flex-1 overflow-x-auto overflow-y-hidden p-4">
        {beadsLoading ? (
          <div className="flex items-center justify-center h-full">
            <div role="status" className="text-t-muted">Loading beads…</div>
          </div>
        ) : beadsError ? (
          <div className="flex items-center justify-center h-full">
            <div role="alert" className="text-danger">Error loading beads: {beadsError.message}</div>
          </div>
        ) : (
          <div
            className="grid h-full"
            style={{
              gap: 'var(--column-gap)',
              gridAutoFlow: 'column',
              gridAutoColumns: 'minmax(var(--column-min), 1fr)',
            }}
          >
            {COLUMNS.map(({ status, title }) => (
              <KanbanColumn
                key={status}
                status={status}
                title={title}
                beads={filteredBeadsByStatus[status] || []}
                allBeads={beads}
                selectedBeadId={selectedId}
                ticketNumbers={ticketNumbers}
                onSelectBead={openBead}
                onChildClick={openBead}
                onNavigateToDependency={navigateToBead}
                projectPath={project?.path}
                fsPath={fsPath}
                onUpdate={refreshBeads}
              />
            ))}
          </div>
        )}
      </main>

      {/* Bead Detail Sheet */}
      <ErrorBoundary label="Bead Detail">
      {detailBead && (
        <BeadDetail
          bead={detailBead}
          ticketNumber={ticketNumbers.get(detailBead.id)}
          worktreeStatus={isDoltOnly ? undefined : worktreeStatuses[detailBead.id]}
          open={isDetailOpen}
          onOpenChange={handleDetailOpenChange}
          projectPath={project?.path ?? ""}
          allBeads={beads}
          onChildClick={openBead}
          onUpdate={refreshBeads}
        >
          <CommentList
            comments={detailBead.comments}
            beadId={detailBead.id}
            projectPath={project?.path ?? ""}
            onCommentAdded={refreshBeads}
          />
          <ActivityTimeline
            bead={detailBead}
            comments={detailBead.comments}
            childBeads={(detailBead.children || [])
              .map(id => beads.find(b => b.id === id))
              .filter((b): b is Bead => !!b)}
          />
        </BeadDetail>
      )}
      </ErrorBoundary>

      {/* Reports Panel */}
      <ErrorBoundary label="Reports Panel">
        <ReportPanel
          open={isReportsOpen}
          onOpenChange={setIsReportsOpen}
          fsPath={fsPath ?? ""}
        />
      </ErrorBoundary>

      {/* Memory Panel (requires filesystem path) */}
      <ErrorBoundary label="Memory Panel">
      {fsPath && !isDoltOnly && (
        <MemoryPanel
          open={isMemoryOpen}
          onOpenChange={setIsMemoryOpen}
          projectPath={fsPath}
        />
      )}
      </ErrorBoundary>

      {/* Agents Panel (requires filesystem path) */}
      <ErrorBoundary label="Agents Panel">
      {fsPath && !isDoltOnly && (
        <AgentsPanel
          open={isAgentsOpen}
          onOpenChange={setIsAgentsOpen}
          projectPath={fsPath}
        />
      )}
      </ErrorBoundary>

      {/* Project Settings Dialog */}
      {project && (
        <ProjectSettingsDialog
          open={isSettingsOpen}
          onOpenChange={setIsSettingsOpen}
          projectId={project.id}
          projectName={project.name}
          projectPath={project.path}
          projectLocalPath={project.localPath}
          onUpdated={refetchProject}
        />
      )}

      {/* Create Bead Dialog */}
      {project?.path && (
        <CreateBeadDialog
          open={isCreateOpen}
          onOpenChange={setIsCreateOpen}
          projectPath={project.path}
          onCreated={refreshBeads}
        />
      )}

      {/* GitHub Integration Warning Dialog */}
      <AlertDialog open={showGitHubWarning} onOpenChange={(open) => !open && setGithubWarningDismissed(true)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>GitHub Integration Unavailable</AlertDialogTitle>
            <AlertDialogDescription>
              {!hasRemote
                ? "This repository doesn't have a GitHub remote configured."
                : "GitHub CLI is not authenticated."}
              {" "}PR features (Create PR, Merge PR, status checks) will not be available.
              You can still work on tasks locally.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button>Continue Without GitHub</Button>} />
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
