/**
 * What there is to come back to: sessions this app ran, plus every Claude
 * session on this machine that belongs to the project.
 *
 * The list comes from the SDK's own session index, never from a transcript we
 * parse ourselves. It carries what the owner needs to tell one chat from
 * another — the name Claude holds for it, the directory it ran in, the branch
 * it was on — and its shape is the SDK's contract rather than a format we
 * guessed at.
 *
 * Design: docs/agent-workbench.md §6.3.
 */
import { listSessions } from '@anthropic-ai/claude-agent-sdk';

import { folderOf } from '../../src/workbench/protocol.ts';
import type { RestoreRow, SessionSummary } from '../../src/workbench/protocol.ts';
import { runningNow } from './running.ts';
import type { Store } from './store.ts';

interface KnownSession {
  externalId: string;
  lastActiveAt: string;
  /** What Claude calls this conversation: its title, or the first thing asked. */
  name: string | null;
  cwd: string | null;
  branch: string | null;
}

/**
 * Every Claude session for a project, worktrees included: a chat run in
 * `worktrees/x` is work on this project and belongs in its list.
 *
 * With no project, every session on the machine — which is what the app-wide
 * screens ask for.
 */
export async function knownSessions(projectPath: string | null, everything = false): Promise<KnownSession[]> {
  try {
    // `includeProgrammatic: false` is the filter the terminal's own /resume
    // picker uses: it withholds the chats an agent started to do a piece of
    // work for another chat. Measured on Corsetta: 306 offered, 218 a
    // person's (docs/agent-workbench.md §6.3.1).
    const found = await listSessions(
      projectPath
        ? { dir: projectPath, includeWorktrees: true, includeProgrammatic: everything }
        : { includeProgrammatic: everything },
    );
    return found.map((s) => ({
      externalId: s.sessionId,
      lastActiveAt: new Date(s.lastModified).toISOString(),
      name: s.customTitle ?? s.summary ?? s.firstPrompt ?? null,
      cwd: s.cwd ?? null,
      branch: s.gitBranch ?? null,
    }));
  } catch {
    // No index, or a version that cannot be read: the app's own rows still list.
    return [];
  }
}

/**
 * The restore list: ours first, then any session we did not start.
 *
 * Nothing here starts a process. A row is an offer, never a wake-up
 * (decision 8) — an agent that resumes itself is a bill and a surprise.
 */
export async function restoreList(
  store: Store,
  project: { id: string; path: string } | null,
  everything = false,
): Promise<RestoreRow[]> {
  const all: (SessionSummary & { origin: 'app' | 'terminal' })[] = store.listSessions(project?.id);
  // A chat with nothing said in it is not an offer either: those are the ones
  // that opened and were never typed into (docs/agent-workbench.md §6.3.1).
  const mine = everything ? all : all.filter((s) => s.title !== null || store.messageCount(s.id) > 0);
  const known = new Map((await knownSessions(project?.path ?? null, everything)).map((s) => [s.externalId, s]));
  const claimed = new Set(mine.map((s) => s.externalId).filter((x): x is string => !!x));
  // Who is actually working, which the session index cannot say: it carries the
  // conversation file's mtime and nothing about processes, and mtime was
  // measured useless for this — one working chat went 488 seconds without
  // writing (bw-dmxj). The tool's own markers are asked instead, and the
  // answer is cached, so listing forty rows costs one look at the machine.
  const running = runningNow();

  const rows: RestoreRow[] = mine.map((s) => {
    // The name Claude holds wins over the opening line we cut down ourselves:
    // it is the one the owner sees everywhere else this conversation appears.
    const seen = s.externalId ? known.get(s.externalId) : undefined;
    return {
      sessionId: s.id,
      externalId: s.externalId,
      brand: s.brand,
      title: seen?.name ?? s.title,
      lastActiveAt: s.lastActiveAt,
      state: s.state,
      origin: s.origin,
      projectId: s.projectId,
      cwdHint: s.cwd,
      folder: folderOf(seen?.cwd ?? s.cwd),
      branch: seen?.branch ?? null,
      beads: store.beadsForSession(s.id),
      // A chat this app started can be running in a process of its own too:
      // the driver's child writes a marker like any other Claude Code. The row
      // says so either way, and `state` stays the authority on whether a driver
      // of ours is attached to it.
      runningElsewhere: !!s.externalId && running.has(s.externalId),
    };
  });

  for (const s of known.values()) {
    if (claimed.has(s.externalId)) continue;
    rows.push({
      sessionId: null,
      externalId: s.externalId,
      brand: 'claude',
      title: s.name,
      lastActiveAt: s.lastActiveAt,
      state: 'dormant',
      origin: 'terminal',
      projectId: project?.id ?? null,
      cwdHint: s.cwd ?? project?.path ?? null,
      folder: folderOf(s.cwd),
      branch: s.branch,
      // A chat the app has never driven has no confirmed cards yet: they arrive
      // with its history, the first time it is opened.
      beads: store.beadsForSession(s.externalId),
      // The row this whole signal exists for: a chat the owner is typing at in
      // a terminal is `dormant` here, because nothing of ours is attached to
      // it, and until now it was drawn identically to one that died last week.
      runningElsewhere: running.has(s.externalId),
    });
  }

  rows.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return rows;
}
