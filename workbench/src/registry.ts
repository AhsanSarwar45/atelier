/**
 * What there is to come back to: sessions this app ran, plus every Claude
 * session on this machine that belongs to the project.
 *
 * The list comes from the SDK's own session index. It carries what the owner
 * needs to tell one chat from another — the name Claude holds for it, the
 * directory it ran in, the branch it was on — and its shape is the SDK's
 * contract rather than a format we guessed at.
 *
 * One question the index cannot answer, and only one: when the PERSON last
 * spoke. An entry there says `lastModified` and nothing about who wrote it, and
 * for a chat begun in a terminal there is no row of ours that saw him type. So
 * that one field is read off the chat's own record, in the smallest way it can
 * be — the end of the file, backwards, once per record and then only over what
 * has been appended since (spoken.ts, bw-zhs9). Everything else on a row still
 * comes from the index or from our store.
 *
 * Design: docs/agent-workbench.md §6.3.
 */
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { closeSync, fstatSync, openSync, readFileSync, readlinkSync, readSync, readdirSync } from 'node:fs';

import { asleepHere, byWhatIsWorking, folderOf, laterOf } from '../../src/workbench/protocol.ts';
import type { RestoreRow, SessionSummary } from '../../src/workbench/protocol.ts';
import { holdsNow, runningNow } from './running.ts';
import type { HeldChat } from '../../src/workbench/chat-state.ts';
import type { HeldDoing } from '../../src/workbench/chat-state.ts';
import { lastSpokeAt } from './spoken.ts';
import type { Store } from './store.ts';
import { codexRolloutPath, listCodexThreads } from './drivers/codex.ts';

interface KnownSession {
  brand: 'claude' | 'codex';
  externalId: string;
  lastActiveAt: string;
  /** What Claude calls this conversation: its title, or the first thing asked. */
  name: string | null;
  cwd: string | null;
  branch: string | null;
  running: boolean;
  lastSpokeAt: string | null;
}

const liveCodexPaths = new Map<string, string>();

/** Codex has no Claude-style marker files. Its app-server reports terminal
 * threads as notLoaded, so recognize both ids carried by active commands and
 * rollout files held open by a Codex process. */
export function runningCodexThreads(): Set<string> {
  return new Set(codexThreadProcesses().keys());
}

/** Live Codex processes by thread. More than one process can hold the same
 * thread, which is precisely the conflict the ownership UI must expose. */
export function codexThreadProcesses(): Map<string, Set<number>> {
  const found = new Map<string, Set<number>>();
  if (process.platform !== 'linux') return found;
  let pids: string[] = [];
  try { pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name)); } catch { return found; }
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  for (const pid of pids) {
    let command = '';
    try { command = readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    const argv = command.split('\0').filter(Boolean);
    if (argv[0]?.split('/').pop() !== 'codex') continue;
    command = argv.join(' ');
    const ids = new Set((command.match(uuid) ?? []).map((id) => id.toLowerCase()));
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        let target = '';
        try { target = readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
        if (!/\.codex\/sessions|rollout-/i.test(target)) continue;
        for (const id of target.match(uuid) ?? []) {
          const key = id.toLowerCase();
          ids.add(key);
          liveCodexPaths.set(key, target);
        }
      }
    } catch {
      // Processes can exit or deny fd inspection between the two reads.
    }
    for (const id of ids) {
      const owners = found.get(id) ?? new Set<number>();
      owners.add(Number(pid));
      found.set(id, owners);
    }
  }
  return found;
}

/** Honest activity from the bounded tail of a Codex rollout. */
export function codexDoingFromLines(lines: string[]): HeldDoing {
  const rows = lines.flatMap((line) => {
    try { return [JSON.parse(line) as any]; } catch { return []; }
  });
  let started = -1;
  let ended = -1;
  rows.forEach((row, at) => {
    const type = row.payload?.type ?? row.type;
    if (type === 'task_started') started = at;
    if (type === 'task_complete' || type === 'turn_aborted') ended = at;
  });
  if (started < 0 || ended > started) return 'idle';
  for (let at = rows.length - 1; at > started; at--) {
    const row = rows[at]!;
    const payload = row.payload ?? row;
    const type = String(payload.type ?? row.type ?? '').toLowerCase();
    const item = String(payload.item?.type ?? '').toLowerCase();
    if (/approval|permission|request_user_input/.test(type) || /approval|permission/.test(item)) return 'waiting';
    if (/compact|summary/.test(type) || /compact|summary/.test(item)) return 'summarising';
    if (/custom_tool_call|function_call/.test(type) && !/_output$/.test(type)) return 'running';
    if (/commandexecution|filechange/.test(item)) return 'running';
    if (/agentmessage/.test(item) || type === 'message') return 'answering';
    if (/reason/.test(type) || /reason/.test(item)) return 'thinking';
  }
  return 'working';
}

function codexDoing(id: string): HeldDoing {
  const path = liveCodexPaths.get(id.toLowerCase()) ?? codexRolloutPath(id);
  if (!path) return 'unknown';
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n');
      if (size > length) lines.shift();
      return codexDoingFromLines(lines);
    } finally { closeSync(fd); }
  } catch { return 'unknown'; }
}

/** One ownership snapshot for every provider. Claude contributes rich marker
 * state; Codex currently contributes its live thread lock. Keeping both on
 * this wire prevents the UI offering a composer that the send guard rejects. */
export function providerHoldsNow(fresh = false): HeldChat[] {
  const holds = holdsNow(fresh);
  const seen = new Set(holds.map((hold) => hold.id.toLowerCase()));
  for (const id of runningCodexThreads()) {
    if (seen.has(id)) continue;
    holds.push({
      id,
      holder: 'terminal',
      doing: codexDoing(id),
      detail: null,
      told: false,
      since: null,
      turnSince: null,
      typicalMs: null,
    });
  }
  return holds.sort((a, b) => a.id.localeCompare(b.id));
}

/** Last actual user message in a Codex rollout, without reading the whole file. */
function codexLastSpokeAt(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null;
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (size > length) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      let row: any;
      try { row = JSON.parse(lines[i]); } catch { continue; }
      const payload = row.payload ?? row;
      if (payload.role !== 'user' || (payload.type && payload.type !== 'message')) continue;
      const at = row.timestamp ?? payload.timestamp;
      if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) return new Date(at).toISOString();
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return null;
}

/**
 * Every Claude session for a project, worktrees included: a chat run in
 * `worktrees/x` is work on this project and belongs in its list.
 *
 * With no project, every session on the machine — which is what the app-wide
 * screens ask for.
 */
export async function knownSessions(projectPath: string | null, everything = false): Promise<KnownSession[]> {
  const claude = async (): Promise<KnownSession[]> => {
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
      brand: 'claude' as const,
      externalId: s.sessionId,
      lastActiveAt: new Date(s.lastModified).toISOString(),
      name: s.customTitle ?? s.summary ?? s.firstPrompt ?? null,
      cwd: s.cwd ?? null,
      branch: s.gitBranch ?? null,
      running: false,
      lastSpokeAt: null,
    }));
  } catch {
    // No index, or a version that cannot be read: the app's own rows still list.
    return [];
  }
  };
  const codex = async (): Promise<KnownSession[]> => {
    try {
      const running = runningCodexThreads();
      return (await listCodexThreads(projectPath, everything)).map((thread) => ({
        brand: 'codex' as const,
        externalId: thread.id,
        lastActiveAt: new Date(Number(thread.updatedAt) * 1000).toISOString(),
        name: thread.name ?? thread.preview ?? null,
        cwd: thread.cwd ?? null,
        branch: thread.gitInfo?.branch ?? null,
        running: thread.status?.type === 'active' || running.has(String(thread.id).toLowerCase()),
        lastSpokeAt: codexLastSpokeAt(thread.path),
      }));
    } catch {
      return [];
    }
  };
  const [claudeSessions, codexThreads] = await Promise.all([claude(), codex()]);
  return [...claudeSessions, ...codexThreads];
}

/**
 * The second clock for one row: when the person himself last spoke.
 *
 * Two places can answer and both can be silent. Our own column is stamped when
 * he sends from this app; the chat's record answers for the times he typed
 * somewhere else, and for a chat begun in a terminal it is the only answer
 * there is. The later of the two wins, for the same reason `lastActiveAt` takes
 * the later of ours and the index's — a chat worked on in both places is
 * exactly the one that matters. With neither, the row keeps the clock it
 * already has, so it orders the way the whole list orders today (bw-zhs9).
 */
function spokeAt(ours: string | null | undefined, recorded: string | null, fallback: string): string {
  const said = ours ? laterOf(ours, recorded) : recorded;
  return said ?? fallback;
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
  const sessionKey = (brand: string, id: string) => `${brand}:${id}`;
  const known = new Map((await knownSessions(project?.path ?? null, everything)).map((s) => [sessionKey(s.brand, s.externalId), s]));
  const claimed = new Set(mine.flatMap((s) => s.externalId ? [sessionKey(s.brand, s.externalId)] : []));
  // Who is actually working, which the session index cannot say: it carries the
  // conversation file's mtime and nothing about processes, and mtime was
  // measured useless for this — one working chat went 488 seconds without
  // writing (bw-dmxj). The tool's own markers are asked instead, and the
  // answer is cached, so listing forty rows costs one look at the machine.
  const running = runningNow();
  // What each held chat is doing, so a row draws the same moving mark as the
  // chat's own line does (bw-96is). Read off the same beat as the set above.
  const holds = new Map(holdsNow().map((h) => [h.id, h]));
  // When the person last spoke, asked for every chat at once. Bounded and
  // remembered per record (spoken.ts), so a list of forty rows costs forty
  // looks at a file's length plus whatever each record has gained since the
  // last one — never a scan of a conversation (bw-zhs9, bw-uiyz).
  const spoken = new Map<string, string | null>();
  const claudeIds = [
    ...mine.filter((s) => s.brand === 'claude').map((s) => s.externalId),
    ...[...known.values()].filter((s) => s.brand === 'claude').map((s) => s.externalId),
  ];
  await Promise.all(
    [...new Set(claudeIds)]
      .filter((id): id is string => id !== null)
      .map(async (id) => void spoken.set(id, await lastSpokeAt(id))),
  );

  const rows: RestoreRow[] = mine.map((s) => {
    // The name Claude holds wins over the opening line we cut down ourselves:
    // it is the one the owner sees everywhere else this conversation appears.
    const seen = s.externalId ? known.get(sessionKey(s.brand, s.externalId)) : undefined;
    const active = laterOf(s.lastActiveAt, seen?.lastActiveAt);
    return {
      sessionId: s.id,
      externalId: s.externalId,
      brand: s.brand,
      title: seen?.name ?? s.title,
      // The tool's index moves whenever the conversation is written to, wherever
      // that happens; our own log only moves when this app drives it. A chat
      // worked on elsewhere is exactly the one that matters most here, so the
      // later of the two wins (bw-dmxj.4).
      lastActiveAt: active,
      lastSpokeAt: spokeAt(s.lastSpokeAt, seen?.brand === 'codex' ? seen.lastSpokeAt : (s.externalId ? spoken.get(s.externalId) : null) ?? null, active),
      state: s.state,
      origin: s.origin,
      projectId: s.projectId,
      cwdHint: s.cwd,
      folder: folderOf(seen?.cwd ?? s.cwd),
      branch: seen?.branch ?? null,
      beads: store.beadsForSession(s.id),
      // A chat this app started runs in a process of its own, and that process
      // writes a marker like any other Claude Code — so the marker alone says
      // nothing about whether somebody ELSE has the conversation. Only a chat
      // no driver of ours is attached to is somebody else's, which is the test
      // the chat's own line has always applied and this row did not: one chat
      // drew "external" here and "Ready" in the bar above it at the same moment
      // (bw-jaoz.2).
      runningElsewhere: !!s.externalId && asleepHere(s.state) && (seen?.brand === 'codex' ? seen.running : running.has(s.externalId)),
      held: (s.externalId && asleepHere(s.state) ? holds.get(s.externalId) : null) ?? null,
    };
  });

  for (const s of known.values()) {
    if (claimed.has(sessionKey(s.brand, s.externalId))) continue;
    rows.push({
      sessionId: null,
      externalId: s.externalId,
      brand: s.brand,
      title: s.name,
      lastActiveAt: s.lastActiveAt,
      // Nothing of ours ever saw this chat being typed into, so the record is
      // the only place the answer is written down.
      lastSpokeAt: spokeAt(null, s.brand === 'codex' ? s.lastSpokeAt : spoken.get(s.externalId) ?? null, s.lastActiveAt),
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
      runningElsewhere: s.brand === 'codex' ? s.running : running.has(s.externalId),
      held: holds.get(s.externalId) ?? null,
    });
  }

  rows.sort(byWhatIsWorking);
  return rows;
}
