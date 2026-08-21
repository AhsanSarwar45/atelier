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

/** The directory the sidecar under test reads its markers from — a copy. */
export function markerDir(): string {
  const dir = process.env.BEADS_E2E_MARKERS;
  if (!dir) throw new Error('set BEADS_E2E_MARKERS to the sessions directory the stack under test reads');
  const real = join(homedir(), '.claude', 'sessions');
  if (resolve(dir) === real) throw new Error(`BEADS_E2E_MARKERS is the tool's own directory: ${real}`);
  return resolve(dir);
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

/** Says a live process is holding this conversation, until it is taken away. */
export function claimConversation(conversation: string, how: Holding = {}): () => void {
  const file = join(markerDir(), `${process.pid}.json`);
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

/** The project the run is pointed at, or the first the instance lists. */
export async function aProject(request: APIRequestContext): Promise<Project> {
  const projects = (await (await request.get(`${backend()}/api/projects`)).json()) as Project[];
  expect(projects.length, 'the instance lists no projects').toBeGreaterThan(0);
  const wanted = process.env.BEADS_E2E_PROJECT;
  const project = wanted ? projects.find((p) => p.id === wanted) : projects[0];
  expect(project, `no project ${wanted ?? ''}`).toBeTruthy();
  return project!;
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
