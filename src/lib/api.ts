/**
 * Frontend API layer for Atelier
 * Replaces Tauri invoke() calls with HTTP fetch to backend
 */

import { apiUrl } from '@/lib/api-base';
import { onBoard, onFolder, onRepository, type WatchEvent } from '@/workbench/live-wire';
import { BeadsResponseSchema, WorktreeStatusSchema } from '@/lib/api-schemas';
import type { Project, Tag, Bead, WorktreeStatus, WorktreeEntry, CachedCounts } from '@/types';

/**
 * Input for creating a new project
 */
export interface CreateProjectInput {
  name: string;
  path: string;
}

export type ManifestStorage = 'personal' | 'repository';

export interface ProjectManifest {
  schema_version: number;
  project: { display_name: string; use_beads: boolean; summary: string };
  git: { completed_work_branch: string; agents_may_merge_completed_work: boolean; protected_branches: string[] };
  beads: { issue_id_prefix: string; work_areas: string[] };
  verification: { visual_proof_for_ui_changes: boolean; commands: { name: string; command: string; paths?: string[] }[] };
  review: { external_review: 'agent_decides' | 'always' | 'never'; evidence_requirements: string };
  development: { setup_command: string; start_command: string; build_command: string };
  deployment: { command: string; requires_confirmation: boolean };
  cross_project: { delivery_projects: string[] };
}

export interface ProjectProbe {
  manifest: ProjectManifest;
  existing: boolean;
  storage?: ManifestStorage;
  manifestPath?: string;
  /** Whether this computer has bd at all (bw-3tkl.2). */
  beadsAvailable: boolean;
}

export interface ProjectSettingsAnswer {
  manifest: ProjectManifest;
  path: string;
  storage: ManifestStorage;
  /** See ProjectProbe.beadsAvailable. */
  beadsAvailable: boolean;
}

/**
 * Input for creating a new tag
 */
export interface CreateTagInput {
  name: string;
  color: string;
}

/**
 * File system entry from directory listing
 */
export interface FsEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/**
 * One entry of a directory as the file browser draws it (bw-g3o3.2).
 *
 * A symlink is never followed, so it is a `link` whatever it points at. An
 * entry git ignores is still listed, flagged: the tree dims it or hides it on
 * the reader's say-so, which it could not do for something it was never told
 * about.
 */
export interface FsTreeEntry {
  name: string;
  path: string;
  kind: 'dir' | 'file' | 'link';
  /** Bytes. */
  size: number;
  /** Last modified, in milliseconds since the epoch. */
  mtime: number;
  ignored: boolean;
  /** The name starts with a dot. Nothing more is meant by it. */
  hidden: boolean;
}

/** One level of a directory: directories first, then names ignoring case. */
export interface FsTreeResponse {
  /** The directory that was listed, as the server resolved it. */
  dir: string;
  entries: FsTreeEntry[];
}

/** One thing the `@` menu can offer: where it is, and what it is. */
export interface FsFoundPath {
  /** Relative to the root, `/`-separated — exactly what goes after the `@`. */
  path: string;
  kind: 'dir' | 'file';
}

/** What a search of a checkout answers with: the best matches, best first. */
export interface FsFindResponse {
  /** The root that was searched, as the server resolved it. */
  root: string;
  entries: FsFoundPath[];
}

/**
 * A file read back for the viewer (bw-g3o3.2).
 *
 * A binary file is an answer and not an error — `kind: 'binary'` with the size
 * and nothing else, so the viewer can say what it is. Text is decoded UTF-8
 * lossily and capped at 2 MiB, and `sha256` is of the bytes actually read, not
 * of the whole file.
 */
export interface FsReadResponse {
  kind: 'text' | 'binary';
  /** The whole file's size in bytes, whatever was read. */
  size: number;
  /** Last modified, in milliseconds since the epoch. */
  mtime: number;
  text?: string;
  truncated?: boolean;
  sha256?: string;
}

/**
 * What a save answers with: the digest of what is now on disk, so the next
 * save can be checked against it without a read in between (bw-g3o3.8).
 */
export interface FsWriteResponse {
  sha256: string;
  size: number;
  mtime: number;
}

/** Where something ended up after a call that changed the tree (bw-5gax). */
export interface FsPathMoved {
  /** The absolute path afterwards. */
  path: string;
}

/**
 * Git branch status information
 */
export interface BranchStatus {
  exists: boolean;
  ahead: number;
  behind: number;
}

/**
 * BD CLI command result
 */
export interface BdCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * File watcher event.
 *
 * Defined beside the connection that carries it, because the board feed is one
 * tag on the window's one stream rather than a stream of its own (bw-zkh4).
 */
export type { WatchEvent } from '@/workbench/live-wire';

/**
 * How many background chores may be in the air at once.
 *
 * A browser opens six connections to a host and hands them out first come,
 * first served. Chores like reading a worktree or asking GitHub about a pull
 * request take seconds each and there is one per card, so unbounded they take
 * every connection and whatever the reader is actually waiting for queues
 * behind them — measured at eight seconds for the chat list (bw-ccm.3).
 */
const CHORES_AT_A_TIME = 2;

let choresRunning = 0;
const choresWaiting: (() => void)[] = [];

/**
 * Runs a background chore once a slot is free. Anything a person is waiting on
 * goes straight to `fetchApi` and is never queued behind these.
 */
async function chore<T>(run: () => Promise<T>): Promise<T> {
  if (choresRunning >= CHORES_AT_A_TIME) {
    await new Promise<void>((resume) => choresWaiting.push(resume));
  }
  choresRunning += 1;
  try {
    return await run();
  } finally {
    choresRunning -= 1;
    choresWaiting.shift()?.();
  }
}

/**
 * Reads already on their way, by what they are reading.
 *
 * A screen is built from many parts and several of them ask for the same thing
 * as it opens — the project list four times over, the memory twice, the board
 * from every hook that wants a count. Each of those was a separate journey to
 * the server, so the reader waited for the same answer several times over
 * (bw-uiyz.9). Now the first asker's journey is the one everybody waits on.
 *
 * Only reads share, and only while one is actually in the air: nothing is kept
 * after it lands, so nobody is ever handed a stale answer. The answer itself is
 * shared rather than copied, so callers must treat what comes back as read-only
 * — which every caller here already does.
 */
const readsInFlight = new Map<string, Promise<unknown>>();

/**
 * How long a read may go unanswered before the app gives up on it.
 *
 * Nothing here used to have a deadline, and a read the browser never managed to
 * send — queued behind a stream that never ends, sitting on a socket whose peer
 * had quietly gone — simply never settled. The screen waiting on it drew its
 * spinner until the page was reloaded, with no error and no way back (bw-zkh4).
 * A deadline turns every one of those, including the causes nobody has found
 * yet, into something a screen can draw and a reader can try again.
 */
export const DEADLINE_MS = 10_000;

/** What a read takes, on top of the browser's own options. */
export interface ReadOptions extends RequestInit {
  /** How long to wait for an answer. {@link DEADLINE_MS} unless said otherwise. */
  deadlineMs?: number;
}

/**
 * One signal that fires when either of two do, so a caller's own cancel and the
 * deadline can both end the same read. `AbortSignal.any` would do it in a line
 * and is too new to rely on everywhere this runs.
 */
function eitherOf(theirs: AbortSignal | null | undefined, deadline: AbortSignal): AbortSignal {
  if (!theirs) return deadline;
  const both = new AbortController();
  const follow = (s: AbortSignal) => {
    if (s.aborted) both.abort(s.reason);
    else s.addEventListener('abort', () => both.abort(s.reason), { once: true });
  };
  follow(theirs);
  follow(deadline);
  return both.signal;
}

/**
 * The one place in the app that asks the server for anything.
 *
 * Everything else goes through here — this file's own reads, and every screen
 * that wants the raw answer rather than the parsed one — so a read cannot be
 * written without a deadline by forgetting to add one. A read that runs out of
 * time fails in words a screen can draw, rather than as an abort nobody prints.
 *
 * It is also where nothing is kept. Everything asked for here is a picture of
 * work that changes while the reader is looking at it, and its address is the
 * same after a card moves as it was before — so there is no name a stale copy
 * could ever be asked about by. The server says so on every answer it gives;
 * this is the same thing said on the way out, so a browser that never saw the
 * header still does not draw a board out of a copy it kept (bw-8um.3.18).
 */
export async function request(path: string, options?: ReadOptions): Promise<Response> {
  const { deadlineMs, signal, ...rest } = options ?? {};
  const wait = deadlineMs ?? DEADLINE_MS;
  const deadline = AbortSignal.timeout(wait);
  try {
    return await fetch(apiUrl(path), {
      ...rest,
      cache: 'no-store',
      signal: eitherOf(signal, deadline),
    });
  } catch (e) {
    // Only the deadline's own firing is reworded: a caller that cancelled its
    // read already knows why, and the browser's network errors say something.
    if (deadline.aborted && !signal?.aborted) {
      throw new Error(
        `no answer from the app in ${Math.round(wait / 1000)}s — it may be stopped, or busy`,
      );
    }
    throw e;
  }
}

/**
 * Whether the app answers at all, waiting no longer than told to. An answer of
 * any kind counts, a refusal included: the question is whether it is up.
 */
export async function reachable(path: string, deadlineMs: number): Promise<boolean> {
  try {
    await request(path, { deadlineMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * Helper for fetch with error handling
 */
function fetchApi<T>(path: string, options?: ReadOptions): Promise<T> {
  const method = options?.method ?? 'GET';
  // A caller that brought its own cancel wants to cancel its own read and
  // nobody else's, so it does not join or become a shared one.
  const shareable = method === 'GET' && !options?.signal;
  if (!shareable) return readApi<T>(path, options);

  const waiting = readsInFlight.get(path);
  if (waiting) return waiting as Promise<T>;

  const journey = readApi<T>(path, options).finally(() => {
    readsInFlight.delete(path);
  });
  readsInFlight.set(path, journey);
  return journey;
}

/**
 * A call the server turned away, with everything it said about it.
 *
 * The message is the whole of what most callers want and is left exactly as it
 * has always read — `API error: <status> <what the server said>` — because
 * several screens strip that prefix off to put the server's own sentence in
 * front of a reader, and one of them is the Git panel.
 *
 * What is new is underneath it. Some refusals carry more than a sentence: a
 * remote git call that failed for want of an unlocked SSH key answers 401 and
 * says so in its body, and a caller can only offer to help if that reaches it.
 * Flattening the answer to a string is what used to lose it.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    /** The status the server answered with. */
    readonly status: number,
    /** The parsed body, when there was one to parse. */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function readApi<T>(path: string, options?: ReadOptions): Promise<T> {
  const res = await request(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    let said: unknown;
    try {
      said = await res.json();
      if ((said as { error?: string })?.error) detail = (said as { error: string }).error;
    } catch { /* no JSON body */ }
    throw new ApiError(`API error: ${res.status} ${detail}`, res.status, said);
  }
  // Handle 204 No Content (archive/unarchive/delete endpoints)
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T;
  }
  return res.json();
}

/**
 * Projects API
 */
export const projects = {
  list: () => fetchApi<Project[]>('/api/projects'),

  create: (data: CreateProjectInput) => fetchApi<Project>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  update: (id: string, data: Partial<Project>) => fetchApi<Project>(`/api/projects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  }),

  delete: (id: string) => fetchApi<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  archive: (id: string) => fetchApi<void>(`/api/projects/${id}/archive`, { method: 'PATCH' }),

  unarchive: (id: string) => fetchApi<void>(`/api/projects/${id}/unarchive`, { method: 'PATCH' }),

  touch: (id: string) => fetchApi<void>(`/api/projects/${id}/touch`, { method: 'POST' }),

  listAll: () => fetchApi<Project[]>('/api/projects?include_archived=true'),

  probe: (path: string) => fetchApi<ProjectProbe>('/api/projects/probe', {
    method: 'POST', body: JSON.stringify({ path }),
  }),

  initialize: (path: string, storage: ManifestStorage, manifest: ProjectManifest) =>
    fetchApi<Project>('/api/projects/initialize', {
      method: 'POST', body: JSON.stringify({ path, storage, manifest }),
    }),

  settings: (id: string) => fetchApi<ProjectSettingsAnswer>(`/api/projects/${id}/settings`),

  updateSettings: (id: string, manifest: ProjectManifest) =>
    fetchApi<ProjectSettingsAnswer>(`/api/projects/${id}/settings`, {
      method: 'PATCH', body: JSON.stringify(manifest),
    }),

  moveSettings: (id: string, storage: ManifestStorage) =>
    fetchApi<ProjectSettingsAnswer>(`/api/projects/${id}/settings/move`, {
      method: 'POST', body: JSON.stringify({ storage }),
    }),
};

/**
 * Tags API
 */
export const tags = {
  list: () => fetchApi<Tag[]>('/api/tags'),

  create: (data: CreateTagInput) => fetchApi<Tag>('/api/tags', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  delete: (id: string) => fetchApi<void>(`/api/tags/${id}`, { method: 'DELETE' }),

  addToProject: (projectId: string, tagId: string) => fetchApi<void>('/api/project-tags', {
    method: 'POST',
    body: JSON.stringify({ projectId, tagId }),
  }),

  removeFromProject: (projectId: string, tagId: string) => fetchApi<void>(
    `/api/project-tags/${projectId}/${tagId}`,
    { method: 'DELETE' }
  ),
};

/**
 * Beads API
 */
/**
 * Input for creating a new bead
 */
export interface CreateBeadInput {
  path: string;
  title: string;
  description?: string;
  issue_type?: string;
  priority?: number;
  parent_id?: string;
}

export const beads = {
  /**
   * How many cards sit in each column of a board, without the cards.
   *
   * The list of projects wants the numbers, not the work — and downloading a
   * whole card database to count it cost megabytes per project on a screen
   * that draws a handful of names (bw-uiyz.2). The server counts what it
   * already has to read and sends back the figures.
   */
  counts: async (path: string) => {
    const params = new URLSearchParams({ path, counts: '1' });
    const data = await fetchApi<{ counts: CachedCounts; source?: string }>(`/api/beads?${params}`);
    return data;
  },

  read: async (path: string, updatedAfter?: string) => {
    const params = new URLSearchParams({ path });
    if (updatedAfter) params.set('updated_after', updatedAfter);
    const data = await fetchApi<{ beads: Bead[]; source?: string }>(
      `/api/beads?${params}`
    );
    BeadsResponseSchema.parse(data);
    return data;
  },

  create: (data: CreateBeadInput) => fetchApi<{ id: string }>('/api/beads/create', {
    method: 'POST',
    body: JSON.stringify(data),
  }),

  update: (data: { path: string; id: string; title?: string; description?: string; status?: string; issue_type?: string; priority?: number; add_label?: string; remove_label?: string }) =>
    fetchApi<{ success: boolean }>('/api/beads/update', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
};

/**
 * BD CLI API
 */
export const bd = {
  command: (args: string[], cwd?: string) => fetchApi<BdCommandResult>('/api/bd/command', {
    method: 'POST',
    body: JSON.stringify({ args, cwd }),
  }),
};

/**
 * Worktree creation response
 */
export interface CreateWorktreeResponse {
  success: boolean;
  worktree_path: string;
  branch: string;
  already_existed: boolean;
}

/**
 * Worktree deletion response
 */
export interface DeleteWorktreeResponse {
  success: boolean;
}

/**
 * List worktrees response
 */
export interface ListWorktreesResponse {
  worktrees: WorktreeEntry[];
}

/**
 * What a repository has changed, in the shape the server parses out of
 * `git status --porcelain=v2 -z` (bw-8dp8).
 *
 * A file is in `staged` when the index differs from HEAD and in `unstaged` when
 * the working tree differs from the index, so a file that was picked and then
 * edited again is in BOTH. That is git's own answer and the panel shows it as
 * git gives it, rather than picking one group and quietly losing the other half
 * of what the file is doing.
 */
export type GitChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'typechange';

/** One changed file. */
export interface GitChange {
  path: string;
  status: GitChangeStatus;
  /** Where a renamed file came from. Null for every other status. */
  origPath: string | null;
}

/** A file named and nothing more: what is new, and what is in conflict. */
export interface GitPath {
  path: string;
}

/**
 * Where the repository stands: the line of work it is on, how far that is from
 * the shared copy, and every file it has changed.
 */
export interface GitStatus {
  branch: string;
  /** The branch it tracks, or null when it tracks nothing yet. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** No branch at all — sitting on a commit. `branch` is then the sha. */
  detached: boolean;
  staged: GitChange[];
  unstaged: GitChange[];
  untracked: GitPath[];
  conflicted: GitPath[];
}

/** What a mutating call answers when git said nothing else. */
export interface GitOk {
  ok: boolean;
}

/** What a commit leaves behind. */
export interface GitCommitResponse {
  sha: string;
}

/** Where the branch stands against the shared copy, after asking it. */
export interface GitFetchResponse {
  ahead: number;
  behind: number;
}

/**
 * A call that talked to the shared copy. `output` is git's own words, kept
 * whole: a push that was refused explains itself in them.
 */
export interface GitRemoteResponse {
  ok: boolean;
  output: string;
}

/** One line of work the repository holds. */
export interface GitBranch {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  isRemote: boolean;
}

/** Every line of work, and the one it is on. */
export interface GitBranchesResponse {
  current: string;
  branches: GitBranch[];
}

/**
 * One checkout of a project: the main one, or a worktree standing beside it
 * (bw-ov7a.1).
 */
export interface GitTree {
  /** The directory's own name — what a chat working here is called after. */
  name: string;
  path: string;
  /** Absent when the checkout is detached rather than on a branch. */
  branch: string | null;
  isMain: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
}

/** Every checkout of a project, and where a new one would be put. */
export interface GitTreesResponse {
  trees: GitTree[];
  place: string;
}

/** One saved change, as the list draws it. */
export interface GitCommit {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  /** ISO 8601, as git's own `%aI` gives it. */
  date: string;
  subject: string;
}

/** Recent saved changes, newest first. */
export interface GitLogResponse {
  commits: GitCommit[];
}

/**
 * Every working-tree change against HEAD, hunk by hunk (bw-rx1y.2).
 *
 * Staged and unstaged together, which is what `git diff HEAD` says and what a
 * person reading "what has this chat changed" means. The server parses the
 * hunks out of git's own unified patch, so the browser never re-diffs whole
 * files — the LCS in `line-diff.ts` is O(n*m) and is meant for the short
 * fragments a tool call carries, not for a file.
 */
export type GitDiffLineKind = 'context' | 'removed' | 'added';

/** One line of a hunk: what happened to it, and what it says. */
export interface GitDiffLine {
  kind: GitDiffLineKind;
  /** The line without its leading marker and without its newline. */
  text: string;
}

/** One run of changed lines with the few unchanged ones around it. */
export interface GitDiffHunk {
  /** First line of the run on the old side, counting from one. */
  oldStart: number;
  oldLines: number;
  /** First line of the run on the new side, counting from one. */
  newStart: number;
  newLines: number;
  lines: GitDiffLine[];
}

/**
 * The words `status` uses, and two more the diff can say that it cannot: a
 * file git has never been told about, which has nothing in HEAD to compare
 * with, and one a merge left unresolved.
 */
export type GitDiffStatus = GitChangeStatus | 'untracked' | 'conflicted';

/** What a file has changed. */
export interface GitDiffFile {
  /** Relative to the repository root, the way `status` gives it. */
  path: string;
  /** Where a renamed file came from. Null for every other status. */
  oldPath: string | null;
  status: GitDiffStatus;
  additions: number;
  deletions: number;
  /** A file git will not show as text. It carries no hunks. */
  binary: boolean;
  /** Empty for a binary file and for a rename that changed nothing. */
  hunks: GitDiffHunk[];
}

/** Every changed file, ordered by path. */
export interface GitDiffResponse {
  files: GitDiffFile[];
}

/**
 * How long a call that has to reach the shared copy may take. The 10s a read
 * gets is the wait a person is sitting in front of; a fetch over a slow link,
 * or one that stops to ask an ssh agent for a passphrase, is regularly longer
 * than that and failing it at ten seconds reports a network fault that is not
 * there.
 */
const REMOTE_DEADLINE_MS = 120_000;

/**
 * Git API
 */
export const git = {
  /**
   * Get branch status relative to main
   * @deprecated Use `worktreeStatus()` instead. Branch-based workflow is deprecated in favor of worktrees.
   */
  branchStatus: (path: string, branch: string) => fetchApi<BranchStatus>(
    `/api/git/branch-status?path=${encodeURIComponent(path)}&branch=${encodeURIComponent(branch)}`
  ),

  // Worktree endpoints
  worktreeStatus: async (repoPath: string, beadId: string, signal?: AbortSignal) => {
    const data = await chore(() => fetchApi<WorktreeStatus>(
      `/api/git/worktree-status?repo_path=${encodeURIComponent(repoPath)}&bead_id=${encodeURIComponent(beadId)}`,
      // A git walk over a big repository is slow on purpose, so this one waits
      // longer than a read a person is sitting in front of — but it still waits
      // a bounded time, which it did not before.
      { deadlineMs: 30_000, ...(signal ? { signal } : {}) }
    ));
    WorktreeStatusSchema.parse(data);
    return data;
  },

  createWorktree: (repoPath: string, beadId: string, baseBranch = 'main') =>
    fetchApi<CreateWorktreeResponse>('/api/git/worktree', {
      method: 'POST',
      body: JSON.stringify({ repo_path: repoPath, bead_id: beadId, base_branch: baseBranch }),
    }),

  deleteWorktree: (repoPath: string, beadId: string) =>
    fetchApi<DeleteWorktreeResponse>('/api/git/worktree', {
      method: 'DELETE',
      body: JSON.stringify({ repo_path: repoPath, bead_id: beadId }),
    }),

  listWorktrees: (repoPath: string) => fetchApi<ListWorktreesResponse>(
    `/api/git/worktrees?repo_path=${encodeURIComponent(repoPath)}`
  ),

  // The chat's own Git view (bw-8dp8). Every one of these takes the project's
  // working directory — `Project.path`, which `ChatTab` already holds — and the
  // server runs it through its own path check before it shells out to git.
  //
  // The reads take an optional cancel so a panel that is closed, or pointed at
  // another project, stops waiting on the answer to a question nobody is asking
  // any more. Handing one over also opts the read out of being shared, which is
  // what makes a re-read straight after a stage see the new state instead of
  // joining the read that was already in the air.

  /** What the repository has changed, and where its branch stands. */
  status: (path: string, signal?: AbortSignal) => fetchApi<GitStatus>(
    `/api/git/status?path=${encodeURIComponent(path)}`,
    signal ? { signal } : undefined,
  ),

  /** Pick whole files to be saved. Per file, never per hunk (bw-8dp8). */
  stage: (path: string, files: string[]) => fetchApi<GitOk>('/api/git/stage', {
    method: 'POST',
    body: JSON.stringify({ path, files }),
  }),

  /** Put picked files back, leaving what they say on disk alone. */
  unstage: (path: string, files: string[]) => fetchApi<GitOk>('/api/git/unstage', {
    method: 'POST',
    body: JSON.stringify({ path, files }),
  }),

  // The bulk and destructive actions (bw-8nwh.3). The bulk ones send `all`
  // rather than every path the panel happens to be drawing: that list is as
  // old as the last read and the repository is not, so a stage-all built from
  // it would stage the wrong set the moment an agent wrote a file underneath.

  /** Pick up everything changed, new and deleted — `git add -A`. */
  stageAll: (path: string) => fetchApi<GitOk>('/api/git/stage', {
    method: 'POST',
    body: JSON.stringify({ path, all: true }),
  }),

  /** Put all of it back, leaving the working tree alone. */
  unstageAll: (path: string) => fetchApi<GitOk>('/api/git/unstage', {
    method: 'POST',
    body: JSON.stringify({ path, all: true }),
  }),

  /**
   * Throw away what these files have changed and not saved. Destructive: git
   * keeps no copy of an unstaged edit, so the panel asks before calling this.
   */
  discard: (path: string, files: string[]) => fetchApi<GitOk>('/api/git/discard', {
    method: 'POST',
    body: JSON.stringify({ path, files }),
  }),

  /**
   * Everything tracked back to HEAD and every untracked file gone. What the
   * project ignores is kept — this never reaches a `.env` or a build.
   */
  discardAll: (path: string) => fetchApi<GitOk>('/api/git/discard', {
    method: 'POST',
    body: JSON.stringify({ path, all: true }),
  }),

  /** Delete files git has never been told about. Destructive; asked about. */
  remove: (path: string, files: string[]) => fetchApi<GitOk>('/api/git/remove', {
    method: 'POST',
    body: JSON.stringify({ path, files }),
  }),

  /** Save the picked files under a message. `amend` rewrites the last one instead. */
  commit: (path: string, message: string, amend?: boolean) =>
    fetchApi<GitCommitResponse>('/api/git/commit', {
      method: 'POST',
      body: JSON.stringify({ path, message, ...(amend === undefined ? {} : { amend }) }),
    }),

  // The three calls that talk to the shared copy each take an optional
  // `passphrase`, for the second go at one that came back wanting an unlocked
  // SSH key (bw-k778). It is sent only when there is one to send, so an
  // ordinary call carries exactly the body it always did; the server uses it
  // for that one call and keeps nothing.

  /** Ask the shared copy where it is, without touching the working tree. */
  fetch: (path: string, passphrase?: string) => fetchApi<GitFetchResponse>('/api/git/fetch', {
    method: 'POST',
    body: JSON.stringify({ path, ...(passphrase === undefined ? {} : { passphrase }) }),
    deadlineMs: REMOTE_DEADLINE_MS,
  }),

  /** Bring in what the shared copy has. */
  pull: (path: string, passphrase?: string) => fetchApi<GitRemoteResponse>('/api/git/pull', {
    method: 'POST',
    body: JSON.stringify({ path, ...(passphrase === undefined ? {} : { passphrase }) }),
    deadlineMs: REMOTE_DEADLINE_MS,
  }),

  /** Send saved changes back. `setUpstream` is for a branch that tracks nothing yet. */
  push: (path: string, setUpstream?: boolean, passphrase?: string) =>
    fetchApi<GitRemoteResponse>('/api/git/push', {
      method: 'POST',
      body: JSON.stringify({
        path,
        ...(setUpstream === undefined ? {} : { setUpstream }),
        ...(passphrase === undefined ? {} : { passphrase }),
      }),
      deadlineMs: REMOTE_DEADLINE_MS,
    }),

  /** Every line of work the repository holds, and the one it is on. */
  branches: (path: string, signal?: AbortSignal) => fetchApi<GitBranchesResponse>(
    `/api/git/branches?path=${encodeURIComponent(path)}`,
    signal ? { signal } : undefined,
  ),

  /** Move to another line of work. `create` starts one from where it stands. */
  checkout: (path: string, branch: string, create?: boolean) =>
    fetchApi<GitOk>('/api/git/checkout', {
      method: 'POST',
      body: JSON.stringify({ path, branch, ...(create === undefined ? {} : { create }) }),
    }),

  /**
   * Told whenever the repository itself moves — a commit, a push, a checkout,
   * whoever made it and wherever from (bw-8nwh.2). Returns the way to stop.
   *
   * It says only that something moved; the panel answers by reading `status`
   * and `log` again, because those are what it draws and only git knows what
   * they say now. Carried on the window's one connection, tagged `git`, for
   * the reason `watch.beads` below is: a stream of its own would spend one of
   * the six a browser allows and never give it back.
   */
  watch: (path: string, onChange: () => void) => onRepository(path, onChange),

  // A project's checkouts, which is what "where will this chat work" is
  // chosen from (bw-ov7a.3). Keyed by a name a person types, unlike the
  // card-keyed `listWorktrees` above.

  /** Every checkout of the project, and where a new one would be put. */
  trees: (path: string, signal?: AbortSignal) => fetchApi<GitTreesResponse>(
    `/api/git/trees?path=${encodeURIComponent(path)}`,
    signal ? { signal } : undefined,
  ),

  /**
   * Make a worktree called `name`, checked out on `branch`. `create` starts
   * that branch rather than expecting it, and `base` says where it starts —
   * the checkout's own commit when nothing is named.
   */
  newTree: (path: string, name: string, branch: string, create?: boolean, base?: string) =>
    fetchApi<GitTree>('/api/git/trees', {
      method: 'POST',
      body: JSON.stringify({
        path,
        name,
        branch,
        ...(create === undefined ? {} : { create }),
        ...(base === undefined ? {} : { base }),
      }),
    }),

  /**
   * Every working-tree change against HEAD, hunk by hunk — what the chat draws
   * in place of its transcript (bw-rx1y.2). Takes the cancel the other reads
   * take, for the same reason: a diff that is closed, or pointed at another
   * worktree, stops waiting on an answer nobody is asking for any more.
   */
  diff: (path: string, signal?: AbortSignal) => fetchApi<GitDiffResponse>(
    `/api/git/diff?path=${encodeURIComponent(path)}`,
    signal ? { signal } : undefined,
  ),

  /** Recent saved changes, newest first. */
  log: (path: string, limit = 50, signal?: AbortSignal) => fetchApi<GitLogResponse>(
    `/api/git/log?path=${encodeURIComponent(path)}&limit=${limit}`,
    signal ? { signal } : undefined,
  ),
};

/**
 * File System API
 */
export const fs = {
  list: (path: string) => fetchApi<{ entries: FsEntry[] }>(
    `/api/fs/list?path=${encodeURIComponent(path)}`
  ),

  exists: (path: string) => fetchApi<{ exists: boolean }>(
    `/api/fs/exists?path=${encodeURIComponent(path)}`
  ),

  roots: () => fetchApi<{ home: string; roots: string[] }>('/api/fs/roots'),

  /**
   * One level of a directory for the file tree, with git's ignore rules
   * applied but not obeyed: an ignored entry comes back flagged rather than
   * missing. `.git` is never listed.
   */
  tree: (dir: string, signal?: AbortSignal) => fetchApi<FsTreeResponse>(
    `/api/fs/tree?dir=${encodeURIComponent(dir)}`,
    signal ? { signal } : undefined,
  ),

  /**
   * The files and folders of a checkout whose names answer what was typed
   * after an `@`, best first (bw-gr8y.7).
   *
   * Unlike `tree`, this one OBEYS git's ignore rules rather than flagging
   * them: a build artefact is not a file anybody means to point an agent at.
   * The order is the server's and is not to be re-sorted here — a basename hit
   * comes before a path hit, and the shorter path settles a tie.
   */
  find: (root: string, q: string, limit = 20, signal?: AbortSignal) => fetchApi<FsFindResponse>(
    `/api/fs/find?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}&limit=${limit}`,
    signal ? { signal } : undefined,
  ),

  /** The text of a file, or the news that it is binary. */
  read: (path: string, signal?: AbortSignal) => fetchApi<FsReadResponse>(
    `/api/fs/read?path=${encodeURIComponent(path)}`,
    signal ? { signal } : undefined,
  ),

  /**
   * Replace a file's whole text.
   *
   * `ifSha` is the `sha256` the read handed over: the server compares it with
   * what is on disk now and answers 409 when they differ, rather than throwing
   * away whatever was written in between. The write itself lands through a
   * temp file and a rename, so the path is never a half-written file.
   */
  write: (path: string, text: string, ifSha?: string | null) =>
    fetchApi<FsWriteResponse>('/api/fs/write', {
      method: 'PUT',
      body: JSON.stringify(ifSha ? { path, text, ifSha } : { path, text }),
    }),

  /**
   * Give a file or folder another name in the folder it is already in
   * (bw-5gax.2).
   *
   * `root` is the checkout the path lives in, and the server proves the path is
   * inside it before touching anything — the client naming it is not the guard.
   * `name` is a name and never a path: a rename does not move a file. A name
   * already in use answers 409 rather than replacing what is there, the way a
   * stale save does.
   */
  rename: (root: string, path: string, name: string) =>
    fetchApi<FsPathMoved>('/api/fs/rename', {
      method: 'POST',
      body: JSON.stringify({ root, path, name }),
    }),

  /**
   * Told whenever files move inside `path` — written from a terminal, by an
   * agent working in the checkout, by a build — with the absolute paths that
   * moved (bw-g3o3.3). Returns the way to stop.
   *
   * Carried on the window's one connection, tagged `fs`, for the reason
   * `git.watch` above is: a stream of its own would spend one of the six a
   * browser allows and never give it back. The server turns away `.git`,
   * `node_modules`, `target` and whatever the project's `.gitignore` forgets,
   * so what arrives here is only what a tree would draw.
   */
  watch: (path: string, onChange: (paths: string[]) => void) => onFolder(path, onChange),

  /**
   * Open a path in an outside program. `finder` is whatever the machine opens
   * that kind of file with; the two editors take a line to sit on, which the
   * default program has no way to be told (bw-khe.13).
   */
  openExternal: (path: string, target: 'vscode' | 'cursor' | 'finder', line?: number | null) =>
    fetchApi<{ success: boolean }>('/api/fs/open-external', {
      method: 'POST',
      body: JSON.stringify(line == null ? { path, target } : { path, target, line }),
    }),
};

/**
 * Dolt database status
 */
export interface DoltStatus {
  running: boolean;
  database_count: number | null;
}

/**
 * Dolt database entry
 */
export interface DoltDatabase {
  name: string;
  project_name: string;
}

/**
 * Discovered running Dolt server process
 */
export interface DoltServer {
  pid: number;
  port: number;
  project_path: string;
  db_name: string | null;
  source: 'auto-start' | 'central';
}

/**
 * Dolt API
 */
export const dolt = {
  status: () => fetchApi<DoltStatus>('/api/dolt/status'),
  databases: () => fetchApi<{ databases: DoltDatabase[] }>('/api/dolt/databases'),
  servers: () => fetchApi<{ servers: DoltServer[] }>('/api/dolt/servers'),
};

/**
 * Version check response
 */
export interface VersionCheckResponse {
  current: string;
  latest: string | null;
  update_available: boolean;
  download_url: string | null;
  release_notes: string | null;
  asset_url: string | null;
  checksums_url: string | null;
}

/**
 * Update response
 */
export interface UpdateResponse {
  status?: string;
  message?: string;
  error?: string;
}

/**
 * Version API
 */
export const version = {
  check: () => fetchApi<VersionCheckResponse>('/api/version/check'),
};

/**
 * Update API
 */
export const update = {
  perform: () => fetchApi<UpdateResponse>('/api/update', {
    method: 'POST',
    deadlineMs: 600_000, // a large download may take ten minutes
  }),
};

/**
 * Which shell the terminal opens, as the server holds it.
 *
 * `shell` is what was chosen, or null for nothing chosen. `default` is what
 * this computer would open on its own, and `available` is what it lists in
 * /etc/shells — a set of suggestions, not a limit, since a shell installed
 * anywhere else is still a shell.
 */
export interface TerminalShell {
  shell: string | null;
  default: string;
  available: string[];
}

/**
 * Read the shell setting.
 *
 * Through `request` rather than `fetchApi`, for the sake of the refusal: the
 * server answers a path it cannot run with one sentence naming that path
 * (server/src/terminal/settings.rs), written for the person who typed it, and
 * the form under the field draws it as it stands. Anything that reworded it
 * here would be showing what this file guessed instead of what the server
 * looked at.
 */
export async function terminalSettings(): Promise<TerminalShell> {
  const answer = await request('/api/settings/terminal');
  if (!answer.ok) throw new Error((await answer.text()) || `the app answered ${answer.status}`);
  return (await answer.json()) as TerminalShell;
}

/**
 * Choose the shell, or clear the choice with null. Answers with the setting as
 * it stands afterwards, so the screen redraws from the server rather than from
 * what it hoped the server did.
 */
export async function saveTerminalSettings(shell: string | null): Promise<TerminalShell> {
  const answer = await request('/api/settings/terminal', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shell }),
  });
  if (!answer.ok) throw new Error((await answer.text()) || `the app answered ${answer.status}`);
  return (await answer.json()) as TerminalShell;
}

/**
 * File Watcher.
 *
 * The board is one tag on the window's one connection rather than a stream of
 * its own: a stream never gives its browser connection back, and a handful of
 * them is what left ordinary reads queued behind streams that would never end
 * (live-wire.ts, bw-zkh4). This also means a dropped board watch is opened
 * again — it used to close on the first error and stay closed, so the cards
 * quietly stopped following the file until the page was reloaded.
 */
export const watch = {
  beads: (path: string, onEvent: (event: WatchEvent) => void) => onBoard(path, onEvent),
};
