/**
 * Bead counts by status for a project, one number per state in {@link STATES}.
 */
export type BeadCounts = Record<BeadStatus, number>;

/** Every state at nought, for a project whose counts have not been read yet. */
export const NO_COUNTS = (): BeadCounts =>
  Object.fromEntries(STATES.map((s) => [s.id, 0])) as BeadCounts;

/**
 * Cached per-project bead counts served by `GET /api/projects`.
 *
 * Populated by the backend after any successful `/api/beads` read and
 * used by the home page to render donut charts immediately on first
 * paint, before fresh counts finish loading.
 */
export interface CachedCounts extends BeadCounts {
  /** Source that produced these cached counts (e.g. 'dolt-direct', 'jsonl'). */
  dataSource?: string | null;
  /** ISO-8601 timestamp of when the cache row was last refreshed. */
  updatedAt: string;
}

/**
 * Project stored in local SQLite
 */
export interface Project {
  id: string;
  name: string;
  path: string;
  localPath?: string;
  tags: Tag[];
  lastOpened: string;
  createdAt: string;
  archivedAt?: string;
  beadCounts?: BeadCounts;
  dataSource?: string;
  beadError?: string;
  /**
   * Cached counts payload from the server. Present on responses from
   * `GET /api/projects` when a cache row exists, `null` for brand-new
   * projects that have never been read yet. Consumed by `useProjects`
   * to seed `beadCounts` on initial render for instant donut paint.
   */
  cachedCounts?: CachedCounts | null;
  /**
   * True once counts on this project have been seeded from either the
   * server cache OR an in-memory previous load. False while we are
   * showing an empty placeholder donut awaiting the first fetch.
   */
  countsLoaded?: boolean;
}

/**
 * Tag stored in local SQLite
 */
export interface Tag {
  id: string;
  name: string;
  color: string;
}

/**
 * The states a bead can be in, and everything the app needs to draw one.
 *
 * This list is the only place a state is declared. Menus, filters, shortcuts,
 * labels, colours, icons and the columns are all derived from it, so a state
 * added here appears everywhere at once — a copy of the list somewhere else is
 * a place that silently keeps four states while the board holds six.
 * `board-columns-agree.py` and `state-list.test.ts` are what hold that line.
 *
 * `column` is the heading on the board, `label` the state's own name on a card;
 * they differ because the manager named the columns for what is happening in
 * them. `tone` names a colour token (`--status-<tone>`), `key` the second press
 * of the `g` shortcut, `live` whether work is still standing in this state.
 *
 * `settled` is a state only the board itself writes, and only once no piece is
 * left standing: a card in one is drawn where its status says and its pieces
 * are not consulted. Everywhere else the pieces decide — corsetta
 * `docs/board.md#3a1`.
 *
 * `counts` is whether a piece in this state is part of the job's size at all.
 * Dropped work is not: a job of fourteen pieces with four dropped is a job of
 * ten, and it finishes when those ten are done. Manager's ruling, 2026-08-17.
 */
export const STATES = [
  { id: 'open',           label: 'Open',           column: 'Todo',           tone: 'open',      icon: 'circle',     key: 'o', live: true,  settled: false, counts: true  },
  { id: 'in_progress',    label: 'In Progress',    column: 'In Progress',    tone: 'progress',  icon: 'clock',      key: 'p', live: true,  settled: false, counts: true  },
  { id: 'inreview',       label: 'In Review',      column: 'Agent Review',   tone: 'review',    icon: 'file-check', key: 'r', live: true,  settled: true,  counts: true  },
  { id: 'manager_review', label: 'Manager Review', column: 'Manager Review', tone: 'manager',   icon: 'eye',        key: 'm', live: true,  settled: true,  counts: true  },
  { id: 'closed',         label: 'Closed',         column: 'Done',           tone: 'closed',    icon: 'check',      key: 'c', live: false, settled: true,  counts: true  },
  { id: 'cancelled',      label: 'Cancelled',      column: 'Cancelled',      tone: 'cancelled', icon: 'ban',        key: 'x', live: false, settled: true,  counts: false },
] as const;

/**
 * Bead status types (the 6 kanban columns), read off {@link STATES}.
 *
 * `cancelled` is a column but never a stored status: dropped work is closed and
 * marked, because a card that never closes blocks whatever waits on it forever.
 * {@link SET_BY} says what writing each state actually means.
 */
export type BeadStatus = (typeof STATES)[number]['id'];

/** A state, as {@link STATES} describes it. */
export type StateInfo = (typeof STATES)[number];

/** The state by its id, for the readers that have an id and want the rest. */
export const STATE_BY_ID = Object.fromEntries(
  STATES.map((s) => [s.id, s]),
) as Record<BeadStatus, StateInfo>;

/**
 * The states a card can be put in by reading the pieces under it, named so that
 * a reader working them out can say which it means without writing the word
 * again. Other checkouts of this repo import these by name.
 */
export const UNTOUCHED: BeadStatus = 'open';
export const WORKING: BeadStatus = 'in_progress';
export const FINISHED: BeadStatus = 'closed';

/**
 * The three readings of a piece that anything counting a job needs, taken off
 * {@link STATES} rather than by naming states again. A seventh state declares
 * which of these it is on the list, and every count follows it at once.
 */

/** Whether this piece is part of the job's size — dropped work is not. */
export function counted(status: string): boolean {
  return STATE_BY_ID[status as BeadStatus]?.counts ?? true;
}

/** Whether this piece is work that was done, as opposed to dropped or standing. */
export function finished(status: string): boolean {
  const state = STATE_BY_ID[status as BeadStatus];
  return state ? !state.live && state.counts : false;
}

/** Whether this piece is still work anyone is waiting on. */
export function standing(status: string): boolean {
  return STATE_BY_ID[status as BeadStatus]?.live ?? true;
}

/**
 * What setting a state means to the board underneath.
 *
 * Every state but one is a status bd stores. Cancelled is not: the board keeps
 * dropped work as a closed card carrying the `cancelled` label, so nothing
 * waiting on it waits forever. Writing the word would be refused, so the screen
 * writes what the board actually holds.
 */
export const SET_BY: Record<
  BeadStatus,
  { status: string; addLabel?: string; removeLabel?: string }
> = {
  open:           { status: 'open',            removeLabel: 'cancelled' },
  in_progress:    { status: 'in_progress',     removeLabel: 'cancelled' },
  inreview:       { status: 'in_review',       removeLabel: 'cancelled' },  // what bd calls this column
  manager_review: { status: 'manager_review',  removeLabel: 'cancelled' },
  closed:         { status: 'closed',          removeLabel: 'cancelled' },
  cancelled:      { status: 'closed', addLabel: 'cancelled' },
};

/**
 * All known statuses from the Beads CLI (bd v0.47.0+).
 * The backend can send any of these; they get mapped to BeadStatus columns.
 */
export type KnownRawStatus =
  | BeadStatus
  | 'in_review'
  | 'manager_review'
  | 'pinned'
  | 'blocked'
  | 'deferred'
  | 'tombstone'
  | 'hooked'
  | 'done'
  | 'resolved'
  | 'pending';

/**
 * Badge info for beads whose original status differs from their mapped column.
 */
export interface StatusBadgeInfo {
  /** Label shown on the badge */
  label: string;
  /** Tailwind color classes for the badge */
  variant: 'warning' | 'muted' | 'info';
}

/**
 * Mapping from known raw statuses to their column + optional badge.
 * tombstone maps to null (hidden).
 */
export const STATUS_MAP: Record<KnownRawStatus, { column: BeadStatus; badge?: StatusBadgeInfo } | null> = {
  // Native column statuses (no badge needed)
  open:        { column: 'open' },
  in_progress: { column: 'in_progress' },
  inreview:    { column: 'inreview' },
  closed:      { column: 'closed' },
  cancelled:   { column: 'cancelled' },
  // Synonyms
  in_review:   { column: 'inreview' },   // what bd writes for this column
  manager_review: { column: 'manager_review' },
  done:        { column: 'closed' },
  resolved:    { column: 'closed' },
  pending:     { column: 'open' },
  // Mapped with badges
  blocked:     { column: 'open',        badge: { label: 'Blocked',  variant: 'warning' } },
  deferred:    { column: 'open',        badge: { label: 'Deferred', variant: 'muted'   } },
  pinned:      { column: 'open',        badge: { label: 'Pinned',   variant: 'info'    } },
  hooked:      { column: 'in_progress', badge: { label: 'Waiting',  variant: 'info'    } },
  // Hidden
  tombstone:   null,
};

/**
 * Bead from .beads/issues.jsonl
 */
export interface Bead {
  id: string;
  title: string;
  description?: string;
  status: BeadStatus;
  priority: number;
  issue_type: string;
  owner: string;
  created_at: string;
  updated_at: string;
  comments: Comment[];
  // Epic support fields
  parent_id?: string;         // ID of parent epic (for child tasks)
  children?: string[];        // IDs of child tasks (for epics)
  design?: string;            // Inline design notes (bd --design)
  notes?: string;             // Supplementary notes (bd --notes)
  close_reason?: string;      // Reason set when closing (bd close --reason)
  deps?: string[];            // Dependency IDs (blocking this task)
  blockers?: string[];        // COMPUTED: Tasks this blocks (derived from deps relationships)
  relates_to?: string[];      // Bead IDs with relates-to links (bidirectional "see also")
  labels?: string[];          // Tags carried by the bead, e.g. area:board, kind:bug
  // Status mapping fields (set by beads-parser when raw status differs from column)
  _originalStatus?: string;   // The raw status from the backend before mapping
  _statusBadge?: StatusBadgeInfo; // Badge info if the bead was mapped to a different column
}

/**
 * Comment from .beads/issues.jsonl
 */
export interface Comment {
  id: number | string;
  issue_id: string;
  author: string;
  text: string;
  created_at: string;
}

/**
 * Kanban column configuration
 */
export interface KanbanColumn {
  id: BeadStatus;
  title: string;
  beads: Bead[];
}

/**
 * GitHub PR info (legacy - for backward compatibility)
 * @deprecated Use PRInfo from the PR Status Types section instead
 */
export interface LegacyPRInfo {
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  statusCheckRollup: { state: 'SUCCESS' | 'FAILURE' | 'PENDING' } | null;
}

/**
 * Epic progress metrics (computed from children)
 */
export interface EpicProgress {
  total: number;       // Pieces that count towards the job — dropped ones do not
  completed: number;   // Counted pieces that are finished work
  inProgress: number;  // Counted pieces being worked on
  blocked: number;     // Counted pieces waiting on something still standing
  dropped: number;     // Pieces dropped, and so outside every number above
}

/**
 * Epic-specific bead type
 */
export interface Epic extends Bead {
  issue_type: 'epic';
  children: string[];     // Epics always have children (required, not optional)
}

// ============================================================================
// Worktree Types
// ============================================================================

/**
 * Worktree status from GET /api/git/worktree-status
 */
export interface WorktreeStatus {
  /** Whether the worktree exists */
  exists: boolean;
  /** Path to the worktree (null if doesn't exist) */
  worktree_path: string | null;
  /** Branch name (null if doesn't exist) */
  branch: string | null;
  /** Number of commits ahead of main */
  ahead: number;
  /** Number of commits behind main */
  behind: number;
  /** Whether there are uncommitted changes */
  dirty: boolean;
  /** Last modification time of the worktree (ISO 8601 string) */
  last_modified: string | null;
}

/**
 * Worktree entry from GET /api/git/worktrees list
 */
export interface WorktreeEntry {
  /** Path to the worktree */
  path: string;
  /** Branch name */
  branch: string;
  /** Extracted bead ID (if matches bd-{ID} pattern) */
  bead_id?: string;
}

// ============================================================================
// PR Status Types
// ============================================================================

/**
 * CI checks status for a PR
 */
export interface PRChecks {
  /** Total number of checks */
  total: number;
  /** Number of passed checks */
  passed: number;
  /** Number of failed checks */
  failed: number;
  /** Number of pending checks */
  pending: number;
  /** Overall status */
  status: 'success' | 'failure' | 'pending';
}

/**
 * GitHub API rate limit information
 */
export interface RateLimit {
  /** Remaining API calls */
  remaining: number;
  /** Total limit */
  limit: number;
  /** Reset time (ISO 8601 string) */
  reset_at: string;
}

/**
 * PR state type
 */
export type PRState = 'open' | 'merged' | 'closed';

/**
 * PR information
 */
export interface PRInfo {
  /** PR number */
  number: number;
  /** PR URL */
  url: string;
  /** PR state */
  state: PRState;
  /** CI checks status */
  checks: PRChecks;
  /** Whether the PR is mergeable */
  mergeable: boolean;
}

/**
 * PR status response from GET /api/git/pr-status
 */
export interface PRStatus {
  /** Whether the repo has a remote */
  has_remote: boolean;
  /** Whether the branch has been pushed */
  branch_pushed: boolean;
  /** PR information (null if no PR exists) */
  pr: PRInfo | null;
  /** Rate limit information */
  rate_limit: RateLimit;
}

// ============================================================================
// PR Files Types
// ============================================================================

/**
 * File status from GitHub API for PR file changes
 */
export type PRFileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

/**
 * A single file entry in a PR's changed files list
 */
export interface PRFileEntry {
  filename: string;
  status: PRFileStatus;
  additions: number;
  deletions: number;
  changes: number;
}

/**
 * Response from GET /api/git/pr-files
 */
export interface PRFilesResponse {
  files: PRFileEntry[];
  total_additions: number;
  total_deletions: number;
  total_files: number;
}

// ============================================================================
// Memory Types
// ============================================================================

/**
 * A single memory entry from bd memories
 */
export interface MemoryEntry {
  key: string;
  content: string;
}

// ============================================================================
// Agent Types
// ============================================================================

/**
 * Supported model names for Claude agents
 */
export type AgentModel = "opus" | "sonnet" | "haiku";

/**
 * An agent definition from .claude/agents/*.md
 */
export interface Agent {
  /** Filename of the agent markdown file (e.g. "reviewer.md") */
  filename: string;
  /** Display name of the agent */
  name: string;
  /** Model the agent uses */
  model: AgentModel;
  /** Description of the agent's role */
  description: string;
  /** List of allowed tools, or "*" for all tools */
  tools: string[] | "*";
  /** Optional nickname for the agent */
  nickname: string | null;
}
