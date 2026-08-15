/**
 * What there is to come back to: sessions this app ran, plus Claude sessions
 * the owner started in a terminal.
 *
 * ⛔ The transcripts under ~/.claude/projects are NEVER opened. Their line
 * format is documented as unstable, so only the directory listing is read: the
 * file name is the session id and its mtime is when the session was last
 * touched. Resuming goes through the id, which is the supported contract.
 *
 * Design: docs/agent-workbench.md §6.3.
 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { RestoreRow, SessionSummary } from '../../src/workbench/protocol.ts';
import type { Store } from './store.ts';

function projectsRoot(): string {
  return process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects');
}

/**
 * The slug a directory carries is the working directory with every character
 * that is not a letter or a digit replaced by a dash — observed, not
 * documented. It is lossy, so it can only ever be a hint: `/a.b` and `/a-b`
 * both land on `a-b`. A path that matches nothing stays unattributed rather
 * than being attached to the wrong project.
 */
export function slugFor(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, '-');
}

interface TerminalSession {
  externalId: string;
  lastActiveAt: string;
  slug: string;
}

/** Every Claude session on this machine, by directory listing alone. */
export function terminalSessions(): TerminalSession[] {
  const root = projectsRoot();
  const out: TerminalSession[] = [];
  let slugs: string[];
  try {
    slugs = readdirSync(root);
  } catch {
    return out;
  }
  for (const slug of slugs) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, slug));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      try {
        const at = statSync(join(root, slug, entry)).mtime.toISOString();
        out.push({ externalId: entry.slice(0, -'.jsonl'.length), lastActiveAt: at, slug });
      } catch {
        // Vanished between listing and stat; nothing to restore.
      }
    }
  }
  return out;
}

/**
 * The restore list: ours first, then any terminal session we did not start.
 *
 * Nothing here starts a process. A row is an offer, never a wake-up
 * (decision 8) — an agent that resumes itself is a bill and a surprise.
 */
export function restoreList(store: Store, project: { id: string; path: string } | null): RestoreRow[] {
  const mine: SessionSummary[] = store.listSessions(project?.id);
  const claimed = new Set(mine.map((s) => s.externalId).filter((x): x is string => !!x));

  const rows: RestoreRow[] = mine.map((s) => ({
    sessionId: s.id,
    externalId: s.externalId,
    brand: s.brand,
    title: s.title,
    lastActiveAt: s.lastActiveAt,
    state: s.state,
    origin: 'app',
    projectId: s.projectId,
    cwdHint: s.cwd,
  }));

  // A terminal session belongs here only when its slug matches this project's
  // path. One that matches nothing is left out rather than shown under a
  // project it may have nothing to do with.
  const wanted = project ? slugFor(project.path) : null;
  for (const t of terminalSessions()) {
    if (claimed.has(t.externalId)) continue;
    if (wanted !== null && t.slug !== wanted) continue;
    rows.push({
      sessionId: null,
      externalId: t.externalId,
      brand: 'claude',
      title: null,
      lastActiveAt: t.lastActiveAt,
      state: 'dormant',
      origin: 'terminal',
      projectId: project?.id ?? null,
      cwdHint: project?.path ?? null,
    });
  }

  rows.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return rows;
}
