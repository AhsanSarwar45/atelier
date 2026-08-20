/**
 * Frontend API layer for beads-kanban-ui webapp
 * Replaces Tauri invoke() calls with HTTP fetch to backend
 */

import { apiUrl } from '@/lib/api-base';
import { BeadsResponseSchema, WorktreeStatusSchema } from '@/lib/api-schemas';
import type { Project, Tag, Bead, WorktreeStatus, WorktreeEntry, MemoryEntry, Agent, AgentModel, CachedCounts } from '@/types';

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
 * File watcher event
 */
export interface WatchEvent {
  path: string;
  type: string;
}

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
 * Helper for fetch with error handling
 */
function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
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

async function readApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...options,
    signal: options?.signal ?? AbortSignal.timeout(10000),
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
      signal ? { signal } : undefined
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
  )
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
 * Memory API
 */
export const memory = {
  /** Fetch all memory entries */
  list: (path: string) => fetchApi<MemoryEntry[]>(
    `/api/memory?path=${encodeURIComponent(path)}`
  ),

  /** Create or upsert a memory entry (empty key = auto-generate) */
  update: (path: string, key: string, content: string) =>
    fetchApi<MemoryEntry>('/api/memory', {
      method: 'PUT',
      body: JSON.stringify({ path, key, content }),
    }),

  /** Delete a memory entry */
  remove: (path: string, key: string) =>
    fetchApi<{ success: boolean }>('/api/memory', {
      method: 'DELETE',
      body: JSON.stringify({ path, key }),
    }),
};

/**
 * Agents API
 */
export const agents = {
  /** List all agents for a project */
  list: (path: string) =>
    fetchApi<Agent[]>(`/api/agents?path=${encodeURIComponent(path)}`),

  /** Update an agent's model or tools configuration */
  update: (filename: string, path: string, data: { model: AgentModel; all_tools: boolean }) =>
    fetchApi<Agent>(`/api/agents/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      body: JSON.stringify({ path, ...data }),
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
    signal: AbortSignal.timeout(600000), // 10 min timeout for large downloads
  }),
};

/**
 * File Watcher (Server-Sent Events)
 */
export const watch = {
  beads: (path: string, onEvent: (event: WatchEvent) => void) => {
    const eventSource = new EventSource(
      apiUrl(`/api/watch/beads?path=${encodeURIComponent(path)}`)
    );
    eventSource.onmessage = (e) => onEvent(JSON.parse(e.data));
    eventSource.onerror = () => eventSource.close();
    return () => eventSource.close();
  },
};
