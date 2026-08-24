"use client";

import { useMemo, useRef, useState, useCallback, useEffect } from "react";

import { useSearchParams, useRouter } from "next/navigation";

import { CreateBeadDialog } from "@/components/create-bead-dialog";
import { KanbanColumn } from "@/components/kanban-column";
import { QuickFilterBar } from "@/components/quick-filter-bar";
import { useReportsByCard } from "@/components/reports";
import { TabTools } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { ReadFailed } from "@/components/ui/read-failed";
import { useBeadFilters } from "@/hooks/use-bead-filters";
import { useKeyboardNavigation } from "@/hooks/use-keyboard-navigation";
import { useProject } from "@/hooks/use-project";
import { addressWith, cardWasPushed, whereFrom } from "@/lib/address";
import { columnFor, drawnInColumns, oldestFirst } from "@/lib/bead-utils";
import { getUnknownStatusBeads, getUnknownStatusNames } from "@/lib/beads-parser";
import { getIssueTypeMeta } from "@/lib/issue-types";
import type { IssueTypeFilter } from "@/lib/issue-types";
import { cn, projectDir } from "@/lib/utils";
import { STATES, type Bead, type BeadStatus } from "@/types";

import { useBoardCards } from "./board-cards";

/**
 * The columns, read off the one list of states. Their names and meanings are
 * the manager's, 2026-08-13: nobody on it; being worked in its own tree;
 * written and waiting for a second agent to read it; landed and waiting for his
 * own signature; final; dropped.
 */
const COLUMNS: { status: BeadStatus; title: string }[] =
  STATES.map((s) => ({ status: s.id, title: s.column }));

/**
 * Main Kanban board component: one column per state in STATES, search, filter,
 * and keyboard navigation
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

  // The one card list the project screen holds, shared with the card panel so an
  // edit in the panel moves the card behind it (src/app/project/board-cards.tsx).
  const {
    beads,
    ticketNumbers,
    isLoading: beadsLoading,
    error: beadsError,
    refresh: refreshBeads,
  } = useBoardCards();

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

  // The folder a card's reports are read from
  const fsPath = projectDir(project);

  // Theme

  // Reports panel state

  // Create bead dialog state
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  // Project settings dialog state

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

  // The worktree of a card is read by the panel that shows it, for the one card
  // it is showing — the board itself draws none of it, and polling every open
  // card's tree to fill a panel that is not on screen was work for nobody.

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
   * Every bead's state by id, built once for the whole board.
   *
   * Each card asks it whether it is blocked. Building one per card meant a
   * fresh map of the entire board for every card drawn, on every pass.
   */
  const statusById = useMemo(
    () => new Map(beads.map(b => [b.id, b.status] as const)),
    [beads],
  );

  /**
   * The report each card carries, looked up once for the whole board rather
   * than once per card.
   */
  const reportFor = useReportsByCard();

  /**
   * Detect beads with truly unknown statuses for the warning indicator.
   */
  const unknownStatusBeads = useMemo(() => getUnknownStatusBeads(beads), [beads]);
  const unknownStatusNames = useMemo(() => getUnknownStatusNames(beads), [beads]);

  // A card is in the address and nowhere else: the panel over the board is the
  // one the project screen mounts, and a click here says which card that is
  // (docs/designs/app-shell.md §1.8). Pushed, so Back closes it.
  const openCard = whereFrom(searchParams).card;
  const isDetailOpen = openCard !== null;
  const openBead = useCallback(
    (bead: Bead) => {
      cardWasPushed();
      router.push(addressWith(searchParams, { card: bead.id }));
    },
    [router, searchParams],
  );
  const navigateToBead = useCallback(
    (beadId: string) => {
      cardWasPushed();
      router.push(addressWith(searchParams, { card: beadId }));
    },
    [router, searchParams],
  );
  // Ref for search input (keyboard navigation)
  const searchInputRef = useRef<HTMLInputElement>(null);

  /**
   * Which column a phone is showing, and how to get to another one.
   *
   * A phone is one column wide, so five of the six are off the side of the
   * screen with nothing to say they exist. The strip snaps, so a swipe always
   * lands on a column squarely rather than halfway between two, and the row of
   * names above it says which one you are on and jumps to any other. On a
   * screen wide enough for several columns none of this applies: the names are
   * hidden, the snapping is off, and the board is what it always was
   * (bw-81wt.3).
   */
  const stripRef = useRef<HTMLElement | null>(null);
  const namesRef = useRef<HTMLElement | null>(null);
  const [columnOn, setColumnOn] = useState(0);

  const goToColumn = useCallback((index: number) => {
    const strip = stripRef.current;
    const column = strip?.firstElementChild?.children[index] as HTMLElement | undefined;
    if (!strip || !column) return;
    strip.scrollTo({ left: column.offsetLeft - strip.offsetLeft, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    // Read off the strip rather than kept in step with it: the reader scrolls
    // with a thumb as well as with these buttons, and only the strip knows
    // where a thumb left it.
    const onScroll = () => {
      const columns = Array.from(strip.firstElementChild?.children ?? []) as HTMLElement[];
      if (!columns.length) return;
      const middle = strip.scrollLeft + strip.clientWidth / 2;
      let nearest = 0;
      let best = Infinity;
      columns.forEach((column, i) => {
        const distance = Math.abs(column.offsetLeft - strip.offsetLeft + column.offsetWidth / 2 - middle);
        if (distance < best) { best = distance; nearest = i; }
      });
      setColumnOn(nearest);
    };
    strip.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => strip.removeEventListener('scroll', onScroll);
  }, [beadsLoading]);

  // The names row is itself too wide for a phone, so it follows the strip: the
  // name of the column you are on is never the one hanging off the side.
  useEffect(() => {
    const name = namesRef.current?.children[columnOn] as HTMLElement | undefined;
    name?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [columnOn]);


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
    // Escape belongs to the panel itself, which waits for its own slide before
    // it lets go of the address. A second path here tore the panel out of the
    // page mid-slide, and only on this tab (bw-m8o.13).
    onClose: () => {},
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
      <div className="flex flex-col items-center justify-center min-h-dvh bg-surface-base">
        <ReadFailed
          data-testid="project-error"
          what="This project could not be read."
          why={projectError.message}
          onRetry={() => void refetchProject()}
        >
          <Button variant="ghost" size="sm" asChild>
            <a href="/">Back to projects</a>
          </Button>
        </ReadFailed>
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
    <div className="flex min-h-0 flex-1 flex-col bg-surface-base">
      {/* The board's own tools, drawn in the shell's second bar. */}
      <TabTools tab="board">
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
          // Unknown status warning
          unknownStatusCount={unknownStatusBeads.length}
          unknownStatusNames={unknownStatusNames}
          onNewBead={() => setIsCreateOpen(true)}
        />
      </TabTools>

      {/* The column names, on a screen too narrow to show them all at once.
          Each says how much is in it, and takes you there. */}
      <nav
        ref={namesRef}
        data-testid="column-tabs"
        aria-label="Columns"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border/40 px-2 py-1 sm:hidden"
      >
        {COLUMNS.map(({ status, title }, i) => (
          <Button
            key={status}
            type="button"
            variant="ghost"
            size="sm"
            selected={i === columnOn}
            aria-current={i === columnOn ? 'true' : undefined}
            onClick={() => goToColumn(i)}
            className="min-h-[40px] shrink-0"
          >
            {title}
            <span className="tabular-nums opacity-60">{(filteredBeadsByStatus[status] || []).length}</span>
          </Button>
        ))}
      </nav>

      {/* Kanban Columns. A column narrower than --column-min is unreadable, so
          past that the board scrolls sideways instead of cramming every column
          into the window. On a phone --column-min is the window itself, so
          "narrower than one column" is every phone and the board is a stack of
          full-width columns you swipe between. */}
      <main
        ref={stripRef}
        data-testid="board-scroll"
        className="min-h-0 flex-1 snap-x snap-mandatory scroll-pl-4 overflow-x-auto overflow-y-hidden p-4 [--column-min:calc(100vw_-_2rem)] sm:snap-none sm:[--column-min:20rem]"
      >
        {beadsLoading ? (
          <div className="flex items-center justify-center h-full">
            <div role="status" className="text-t-muted">Loading cards…</div>
          </div>
        ) : beadsError ? (
          <div className="flex items-center justify-center h-full">
            <ReadFailed
              data-testid="board-error"
              what="This project’s cards could not be read."
              why={beadsError.message}
              onRetry={() => void refreshBeads()}
            />
          </div>
        ) : (
          <div
            className="grid h-full"
            style={{
              gap: 'var(--column-gap)',
              gridAutoFlow: 'column',
              gridAutoColumns: 'minmax(var(--column-min), 1fr)',
              // The one row is the height of the board and no more. Left to
              // itself a row is as tall as the tallest thing in it, so a column
              // of five hundred cards made the row five hundred cards tall, the
              // column with it, and the pane inside the column never had
              // anything to scroll: every card past the first screenful was
              // drawn below the window with no way to reach it (bw-57eg).
              gridTemplateRows: 'minmax(0, 1fr)',
            }}
          >
            {COLUMNS.map(({ status, title }) => (
              // The snap point is this wrapper rather than the column itself,
              // so where a swipe lands is the board's business and the column
              // stays a column.
              <div key={status} className="h-full min-w-0 snap-start sm:snap-align-none">
              <KanbanColumn
                status={status}
                title={title}
                beads={filteredBeadsByStatus[status] || []}
                allBeads={beads}
                statusById={statusById}
                reportFor={reportFor}
                selectedBeadId={selectedId}
                ticketNumbers={ticketNumbers}
                onSelectBead={openBead}
                onChildClick={openBead}
                onNavigateToDependency={navigateToBead}
                projectPath={project?.path}
                fsPath={fsPath}
                onUpdate={refreshBeads}
              />
              </div>
            ))}
          </div>
        )}
      </main>

      {/* The card panel is not mounted here: the project screen mounts the one
          panel for the whole app, over whichever tab is showing, and reads which
          card from the address (docs/designs/app-shell.md §1.8). */}

      {/* No reports drawer: reports are a tab of this project, in the bar
          directly above this board (bw-7ks.21.14). */}

      {/* Create Bead Dialog */}
      {project?.path && (
        <CreateBeadDialog
          open={isCreateOpen}
          onOpenChange={setIsCreateOpen}
          projectPath={project.path}
          onCreated={refreshBeads}
        />
      )}

    </div>
  );
}
