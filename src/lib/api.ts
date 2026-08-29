/**
 * Frontend API layer for Atelier
 * Replaces Tauri invoke() calls with HTTP fetch to backend
 */

import { apiUrl } from '@/lib/api-base';
import { onBoard, type WatchEvent } from '@/workbench/live-wire';
import { BeadsResponseSchema, WorktreeStatusSchema } from '@/lib/api-schemas';
import type { Project, Tag, Bead, WorktreeStatus, WorktreeEntry, CachedCounts } from '@/types';

/**
 * Input for creating a new project
 */
export interface CreateProjectInput {
  name: string;
  path: string;
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
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch { /* no JSON body */ }
    throw new Error(`API error: ${res.status} ${detail}`);
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

  /** Save the picked files under a message. `amend` rewrites the last one instead. */
  commit: (path: string, message: string, amend?: boolean) =>
    fetchApi<GitCommitResponse>('/api/git/commit', {
      method: 'POST',
      body: JSON.stringify({ path, message, ...(amend === undefined ? {} : { amend }) }),
    }),

  /** Ask the shared copy where it is, without touching the working tree. */
  fetch: (path: string) => fetchApi<GitFetchResponse>('/api/git/fetch', {
    method: 'POST',
    body: JSON.stringify({ path }),
    deadlineMs: REMOTE_DEADLINE_MS,
  }),

  /** Bring in what the shared copy has. */
  pull: (path: string) => fetchApi<GitRemoteResponse>('/api/git/pull', {
    method: 'POST',
    body: JSON.stringify({ path }),
    deadlineMs: REMOTE_DEADLINE_MS,
  }),

  /** Send saved changes back. `setUpstream` is for a branch that tracks nothing yet. */
  push: (path: string, setUpstream?: boolean) => fetchApi<GitRemoteResponse>('/api/git/push', {
    method: 'POST',
    body: JSON.stringify({ path, ...(setUpstream === undefined ? {} : { setUpstream }) }),
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
