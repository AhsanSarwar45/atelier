import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * A conversation another program is in, made rather than waited for.
 *
 * Shared by every run that needs one: the rail's marks (chat-live), and what a
 * chat says about itself on each screen (chat-state). A real chat cannot be
 * told to start, say something and stop on cue — it answers to its own terminal
 * — so what these stand on is the only thing the two programs share, the files
 * on disk. The stack under test therefore runs its sidecar against a COPY of
 * the tool's config, and the run is told where that copy's markers are:
 *
 *   BEADS_E2E_MARKERS=/some/scratch/claude/sessions
 *
 * Never the real directory: a marker written there puts a chat that does not
 * exist in front of the tool itself.
 */

/** The list is a read of every conversation the kit knows about. */
export const LISTED_MS = 120_000;

export interface Project {
  id: string;
  path: string;
}

export function backend(): string {
  return process.env.BEADS_E2E_BACKEND ?? '';
}

/**
 * The directory the sidecar under test reads its markers from — a copy.
 *
 * The refusal is against the tool's real directory WHEREVER IT IS. The app
 * itself reads CLAUDE_CONFIG_DIR when it is set and only falls back to
 * `~/.claude` (workbench/src/running.ts, claudeConfigDir), so a machine that
 * has moved its config keeps its live chats somewhere this used to wave
 * through — a run there would write markers naming chats that do not exist
 * into the directory of the agent the manager is talking to (bw-jaoz.11). The
 * runner remembers the real one before it points the stack at a scratch copy;
 * with no runner, whatever the environment says is the real one is refused.
 */
export function markerDir(): string {
  const dir = process.env.BEADS_E2E_MARKERS;
  if (!dir) throw new Error('set BEADS_E2E_MARKERS to the sessions directory the stack under test reads');
  const real = [
    process.env.BEADS_E2E_REAL_CONFIG,
    process.env.BEADS_E2E_REAL_CONFIG ? undefined : process.env.CLAUDE_CONFIG_DIR,
    join(homedir(), '.claude'),
  ]
    .filter((c): c is string => !!c)
    .map((c) => resolve(c, 'sessions'));
  const asked = resolve(dir);
  if (real.includes(asked)) throw new Error(`BEADS_E2E_MARKERS is the tool's own directory: ${asked}`);
  return asked;
}

/** Where the sidecar under test keeps everything, markers and records alike. */
export function configDir(): string {
  return dirname(markerDir());
}

/**
 * Where a project's records live, named the way the tool names them: the path
 * with everything that is not a letter or a digit turned into a dash.
 */
export function recordDir(projectPath: string): string {
  return join(configDir(), 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'));
}

/**
 * The process start time the kernel holds for us — field 22 of our own stat
 * line, which is what tells a live marker from one whose process number has
 * been handed on. Split on the LAST parenthesis: field 2 is the executable's
 * name and the kernel does not escape it.
 */
function ourProcStart(): string {
  try {
    const line = readFileSync('/proc/self/stat', 'utf8');
    return line.slice(line.lastIndexOf(')') + 1).trim().split(/\s+/)[19] ?? '0';
  } catch {
    return '0';
  }
}

/**
 * What the holder is telling the machine about itself, over and above holding
 * the conversation.
 *
 * `status` is the field a terminal writes into its own marker and a host-driven
 * process does not (§6.3.4): `busy` while it owes an answer, `idle` at a
 * prompt. It is the difference between a chat that is held and a chat that is
 * working, which is the whole of what these runs are about (bw-96is).
 */
export interface Holding {
  status?: 'busy' | 'idle';
  /** `cli` is a terminal; `sdk-ts` is another program driving through the kit. */
  entrypoint?: string;
}

/**
 * Says a live process is holding this conversation, until it is taken away.
 *
 * One file per conversation, not one per process: a case that claims a second
 * chat while its first claim still stands would otherwise write over the first
 * marker and quietly un-hold a chat the case is still asserting about. The pid
 * inside is ours either way, which is what the reader checks — it keys what it
 * finds by conversation, so two markers naming one process is an ordinary
 * state and not a clash.
 */
export function claimConversation(conversation: string, how: Holding = {}): () => void {
  const file = join(markerDir(), `${process.pid}-${conversation.slice(0, 8)}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      pid: process.pid,
      sessionId: conversation,
      cwd: process.cwd(),
      startedAt: Date.now(),
      procStart: ourProcStart(),
      kind: 'interactive',
      entrypoint: how.entrypoint ?? 'cli',
      ...(how.status ? { status: how.status, statusUpdatedAt: Date.now() } : {}),
    }),
  );
  return () => rmSync(file, { force: true });
}

/**
 * What the session says about itself, in its own words, beside its marker.
 *
 * The marker carries one bit — busy or idle — so a chat summarising itself and a
 * chat halfway through a command look identical from outside. A hook installed
 * in the session writes this line the moment it enters a state worth naming
 * (`workbench/hooks/session-doing.py`), and the sidecar believes it over
 * anything it worked out for itself. A run cannot make a real session compact on
 * cue, so it writes the line the hook would have written.
 *
 * `ago` is how long the session has been in that state, which is the number the
 * screen counts and the bar fills from.
 */
export function saysItIsDoing(
  conversation: string,
  doing: string,
  what: { ago?: number; detail?: string } = {},
): () => void {
  const file = join(markerDir(), `${conversation}.doing.json`);
  writeFileSync(
    file,
    JSON.stringify({ doing, since: Date.now() - (what.ago ?? 0), detail: what.detail ?? null }),
  );
  return () => rmSync(file, { force: true });
}

/** One line of a record, in the shape the tool writes and the kit reads back. */
function line(chat: { id: string; cwd: string }, parent: string | null, role: 'user' | 'assistant', text: string) {
  const uuid = randomUUID();
  return {
    uuid,
    row: JSON.stringify({
      parentUuid: parent,
      isSidechain: false,
      type: role,
      message:
        role === 'user'
          ? { role: 'user', content: text }
          : { role: 'assistant', content: [{ type: 'text', text }] },
      uuid,
      timestamp: new Date().toISOString(),
      userType: 'external',
      entrypoint: 'cli',
      cwd: chat.cwd,
      sessionId: chat.id,
      version: '2.1.232',
    }),
  };
}

/** One line of a record carrying blocks — a command, or what it printed. */
function blocks(
  chat: { id: string; cwd: string },
  parent: string | null,
  role: 'user' | 'assistant',
  content: unknown[],
) {
  const uuid = randomUUID();
  return {
    uuid,
    row: JSON.stringify({
      parentUuid: parent,
      isSidechain: false,
      type: role,
      message: { role, content },
      uuid,
      timestamp: new Date().toISOString(),
      userType: 'external',
      entrypoint: 'cli',
      cwd: chat.cwd,
      sessionId: chat.id,
      version: '2.1.232',
    }),
  };
}

/**
 * A chat that another program is in the middle of.
 *
 * Driving a second agent from a run to make one would be a test of that agent.
 * What this writes instead is a record the sidecar genuinely reads, by the same
 * kit call it uses for every other chat.
 */
export function aChatSomebodyElseIsIn(projectPath: string, opening: string) {
  const chat = { id: randomUUID(), cwd: projectPath };
  const dir = recordDir(projectPath);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${chat.id}.jsonl`);
  const first = line(chat, null, 'user', opening);
  writeFileSync(file, `${first.row}\n`);
  let last = first.uuid;
  return {
    ...chat,
    file,
    /** The other program says something more, as it would while somebody watched. */
    says(text: string): void {
      const next = line(chat, last, 'assistant', text);
      appendFileSync(file, `${next.row}\n`);
      last = next.uuid;
    },
    /**
     * It starts a command and has not got the answer yet — the shape a record
     * being written to right now ends in, and the shape the app holds back
     * rather than drawing a finished, empty row.
     */
    runs(name: string, input: Record<string, unknown>): string {
      const id = `toolu_${randomUUID().replace(/-/g, '')}`;
      const next = blocks(chat, last, 'assistant', [{ type: 'tool_use', id, name, input }]);
      appendFileSync(file, `${next.row}\n`);
      last = next.uuid;
      return id;
    },
    /** And what it printed, which is what settles that tail. */
    printed(id: string, output: string): void {
      const next = blocks(chat, last, 'user', [{ type: 'tool_result', tool_use_id: id, content: output }]);
      appendFileSync(file, `${next.row}\n`);
      last = next.uuid;
    },
    forget(): void {
      rmSync(file, { force: true });
    },
  };
}

/** Where a run that has to make its own project puts it. */
const OWN_PROJECT_DIR = join(__dirname, '..', '.held-run');

/**
 * A project of this case's own, and how to take it away again.
 *
 * The cases run side by side against one instance, and each of them stands up
 * chats that land on the same list: a case that borrows the project next door
 * is asserting about rows another case is at that moment deleting, and it fails
 * on work that is not its own (bw-jaoz.8). A project to itself is the only
 * thing that gives a case a list it owns. Marked `isTest`, so it is off the
 * dashboard while it exists, and taken off the list entirely when the case ends.
 */
export async function aProjectOfItsOwn(
  request: APIRequestContext,
  what: string,
): Promise<Project & { remove: () => Promise<void> }> {
  const dir = join(OWN_PROJECT_DIR, `${what}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const made = await request.post(`${backend()}/api/projects`, {
    data: { name: `held-${what}`, path: dir, isTest: true },
  });
  expect(made.status(), `could not make a project: ${await made.text()}`).toBe(201);
  const project = (await made.json()) as Project;
  return {
    ...project,
    async remove() {
      await request.delete(`${backend()}/api/projects/${project.id}`);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The project the run is pointed at, the first the instance lists, or one of
 * its own.
 *
 * A stack built from a worktree starts with an empty settings database, so
 * borrowing "the first project" only ever worked against the owner's own
 * running board — and every case that borrows one could not be run on the
 * checkout it was meant to be proving (bw-jaoz.8). Its own is marked `isTest`,
 * so it stays off the dashboard and the teardown sweeps it up.
 */
export async function aProject(request: APIRequestContext): Promise<Project> {
  const projects = (await (await request.get(`${backend()}/api/projects`)).json()) as Project[];
  const wanted = process.env.BEADS_E2E_PROJECT;
  if (wanted) {
    const named = projects.find((p) => p.id === wanted);
    expect(named, `no project ${wanted}`).toBeTruthy();
    return named!;
  }
  if (projects.length > 0) return projects[0]!;

  mkdirSync(OWN_PROJECT_DIR, { recursive: true });
  const listed = (await (await request.get(`${backend()}/api/projects?include_test=true`)).json()) as Project[];
  const had = listed.find((p) => p.path === OWN_PROJECT_DIR);
  if (had) return had;
  const made = await request.post(`${backend()}/api/projects`, {
    data: { name: 'held-run', path: OWN_PROJECT_DIR, isTest: true },
  });
  // The cases run side by side and all want the one project, so losing the
  // race to create it is not a failure — the winner's row is the answer.
  if (made.status() !== 201) {
    const again = (await (await request.get(`${backend()}/api/projects?include_test=true`)).json()) as Project[];
    const other = again.find((p) => p.path === OWN_PROJECT_DIR);
    expect(other, `could not make or find a project: ${await made.text()}`).toBeTruthy();
    return other!;
  }
  return (await made.json()) as Project;
}

/** One command to the sidecar, and what it said back. */
export async function command(request: APIRequestContext, cmd: Record<string, unknown>) {
  const res = await request.post(`${backend()}/api/workbench/command`, { data: cmd });
  const body = await res.text();
  let said: { error?: string; id?: string } = {};
  try {
    said = JSON.parse(body) as { error?: string; id?: string };
  } catch {
    said = {};
  }
  return { ok: res.ok(), status: res.status(), body, said };
}

/**
 * The chat tab, open and settled.
 *
 * Waiting for the LIST, not merely for a row: chats already running are drawn
 * from the live stream at once, while the list itself lands seconds later, so a
 * case that starts as soon as one row exists is reading the wrong list.
 */
export async function openChatTab(page: Page, project: Project): Promise<void> {
  const listed = page.waitForResponse((r) => r.url().includes('/api/workbench/restore') && r.ok(), {
    timeout: LISTED_MS,
  });
  await page.goto(`/project?id=${project.id}&tab=chat`);
  await listed;
  await page.getByTestId('restore-row').first().waitFor({ timeout: 60_000 });
}
