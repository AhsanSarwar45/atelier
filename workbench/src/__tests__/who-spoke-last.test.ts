/**
 * @vitest-environment node
 *
 * Which clock a chat's row carries, and what reading it costs.
 *
 * The list is ordered by when something last happened, and everything an agent
 * does is something: a reply, a line of thinking, a question about a tool, a
 * card it linked. So the rows the manager is actually holding a conversation
 * with slide about under his cursor while three agents write. The order he
 * wants is the last time HE said something, so a row now carries that as a
 * second clock beside the first (bw-zhs9).
 *
 * For a chat this app drove, that clock is a column of ours, stamped on send.
 * For a chat begun in a terminal it can only be read off the kit's own record,
 * and a record is four parts tool result to one part conversation — so what is
 * really under test here is the telling apart: a record whose every line since
 * he last spoke says `"type":"user"` and is not him.
 *
 * It lives beside the sidecar because it opens the sidecar's real store, which
 * is built on `node:sqlite`, and reads real files off the disk.
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { restoreList } from '../registry.ts';
import { forgetSpoken, TAIL_LIMIT } from '../spoken.ts';
import { Store } from '../store.ts';

import type { SessionState } from '../../../src/workbench/protocol.ts';

/**
 * The kit's session index, stood in for. On the machine it is a real directory
 * of every conversation there has ever been here; a test that asked for it
 * would be reading the manager's own chats.
 */
const kit = vi.hoisted(() => ({
  index: [] as { sessionId: string; lastModified: number; summary?: string; cwd?: string; gitBranch?: string }[],
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ listSessions: () => Promise.resolve(kit.index) }));
vi.mock('../drivers/codex.ts', () => ({
  codexRolloutPath: () => null,
  listCodexThreads: () => Promise.resolve([]),
}));

const PROJECT = { id: 'p1', path: '/home/me/project' };
/** The kit's id for a chat begun in a terminal; the app has no row for it. */
const OUTSIDE = 'aaaaaaaa-1111-2222-3333-444444444444';

const SPOKE = '2026-08-19T09:00:00.000Z';
const WORKED = '2026-08-19T17:30:00.000Z';
/** Later than anything else here: only a look that read what it promised not to would find it. */
const NEVER = '2030-01-01T00:00:00.000Z';

let config = '';
let store: Store;
let record = '';
const wasConfig = process.env.CLAUDE_CONFIG_DIR;

// ── The lines a record is made of, in the shapes the kit really writes ──────

/** The person, typing. */
function said(text: string, at: string): string {
  return (
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: text },
      uuid: `said-${at}`,
      timestamp: at,
      permissionMode: 'bypassPermissions',
      origin: { kind: 'human' },
      promptSource: 'typed',
      userType: 'external',
      entrypoint: 'cli',
      cwd: PROJECT.path,
      sessionId: OUTSIDE,
      version: '2.1.237',
    }) + '\n'
  );
}

/** The agent, answering. */
function answered(at: string): string {
  return (
    JSON.stringify({
      parentUuid: 'x',
      isSidechain: false,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] },
      uuid: `said-${at}`,
      timestamp: at,
    }) + '\n'
  );
}

/**
 * Everything a record fills up with between one thing the person says and the
 * next. Every one of these says `"type":"user"`; not one of them is him.
 */
function nobody(at: string): string {
  return [
    // A tool answering the agent — four lines in five of a real record.
    {
      parentUuid: 'x',
      isSidechain: false,
      promptId: 'p',
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: 'ok', is_error: false }] },
      uuid: `tool-${at}`,
      timestamp: at,
      toolUseResult: { stdout: 'ok', stderr: '', interrupted: false },
      sourceToolAssistantUUID: 'x',
      entrypoint: 'cli',
    },
    // A subagent reporting back. No tool result, not marked meta: only the two
    // words `system` and `task-notification` say it is not the person.
    {
      parentUuid: 'x',
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: 'The agent has finished.' },
      uuid: `notice-${at}`,
      timestamp: at,
      promptSource: 'system',
      origin: { kind: 'task-notification' },
      entrypoint: 'cli',
    },
    // Another Claude, messaging this one.
    {
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: 'Another Claude session sent a message:' },
      uuid: `peer-${at}`,
      timestamp: at,
      isMeta: true,
      promptSource: 'system',
      origin: { kind: 'peer' },
    },
    // A hook, talking back after the agent tried to stop.
    {
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: 'Stop hook feedback:\nWork still open.' },
      uuid: `hook-${at}`,
      timestamp: at,
      isMeta: true,
    },
    // A slash command he pressed, and what it printed. Pressing a key is not
    // saying anything.
    {
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: '<command-name>/model</command-name>' },
      uuid: `cmd-${at}`,
      timestamp: at,
    },
    {
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: '<local-command-stdout>Set model to Opus 5</local-command-stdout>' },
      uuid: `out-${at}`,
      timestamp: at,
    },
    // The summary a compaction leaves behind: Claude, writing about the chat.
    {
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
      uuid: `compact-${at}`,
      timestamp: at,
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    },
  ]
    .map((line) => JSON.stringify(line) + '\n')
    .join('');
}

/** Lays a record down where the kit lays one down, and says how long it stands. */
function lay(text: string, at = WORKED): number {
  writeFileSync(record, text);
  const when = new Date(at);
  utimesSync(record, when, when);
  return statSync(record).size;
}

/** A chat this app ran, with a title so the list counts it as one that was used. */
function ours(id: string, externalId: string | null, lastActiveAt: string, title = 'a chat'): void {
  store.createSession({
    id,
    brand: 'claude',
    externalId,
    projectId: PROJECT.id,
    projectPath: PROJECT.path,
    cwd: PROJECT.path,
    model: null,
    permissionMode: 'default',
    title,
    state: 'dormant',
    createdAt: SPOKE,
    lastActiveAt,
    origin: 'app',
  });
}

beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), 'who-spoke-'));
  mkdirSync(join(config, 'projects', '-home-me-project'), { recursive: true });
  record = join(config, 'projects', '-home-me-project', `${OUTSIDE}.jsonl`);
  process.env.CLAUDE_CONFIG_DIR = config;
  forgetSpoken();
  kit.index = [];
  store = new Store(join(config, 'workbench.db'));
});

afterEach(() => {
  rmSync(config, { recursive: true, force: true });
  if (wasConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = wasConfig;
});

describe('the clock that moves only when the person speaks', () => {
  it('normalizes a legacy opening-prompt title when Claude omits programmatic sessions from its index', async () => {
    ours('legacy', OUTSIDE, WORKED, 'currently we do not have the ability to rename these chats from their first message');

    const [row] = await restoreList(store, PROJECT);

    expect(row!.title).toBe('Do Ability Rename Chats First Message');
  });

  it('a chat whose agent has been writing all day carries the hour he last spoke', async () => {
    // He said one thing this morning. The agent has been at it ever since.
    lay(said('go on then', SPOKE) + Array.from({ length: 40 }, (_, i) =>
      answered(`2026-08-19T${String(10 + Math.floor(i / 4)).padStart(2, '0')}:00:00.000Z`) +
      nobody(`2026-08-19T${String(10 + Math.floor(i / 4)).padStart(2, '0')}:00:00.000Z`)).join('') +
      answered(WORKED) + nobody(WORKED));
    kit.index = [{ sessionId: OUTSIDE, lastModified: Date.parse(WORKED), summary: 'a chat in a terminal', cwd: PROJECT.path }];

    const [row] = await restoreList(store, PROJECT);

    // What happened last is unchanged: the agent wrote a minute ago.
    expect(row!.lastActiveAt).toBe(WORKED);
    // What HE last did is eight and a half hours older, and that is the order.
    expect(row!.lastSpokeAt).toBe(SPOKE);
  });

  it('a chat this app drove keeps the send, however much the agent then did', async () => {
    ours('chat-1', null, SPOKE);
    store.markSpoke('chat-1', SPOKE);
    // Everything that follows is the agent: a reply, a mode change, falling
    // asleep. Each one stamps the first clock and none may stamp the second.
    const after: SessionState[] = ['thinking', 'idle', 'dormant'];
    for (const state of after) store.updateSession('chat-1', { state }, true);

    const [row] = await restoreList(store, PROJECT);

    expect(row!.lastSpokeAt).toBe(SPOKE);
    expect(row!.lastActiveAt > SPOKE).toBe(true);
  });

  it('a chat nobody has ever typed into orders by the clock the list uses today', async () => {
    ours('chat-2', null, WORKED);

    const [row] = await restoreList(store, PROJECT);

    expect(row!.lastSpokeAt).toBe(WORKED);
    expect(row!.lastActiveAt).toBe(WORKED);
  });

  it('takes the later of our own column and what the record says', async () => {
    // He drove it from here in the morning and then carried on in a terminal.
    const later = '2026-08-19T14:00:00.000Z';
    ours('chat-3', OUTSIDE, WORKED);
    store.markSpoke('chat-3', SPOKE);
    lay(said('and one more thing', later) + nobody(WORKED));
    kit.index = [{ sessionId: OUTSIDE, lastModified: Date.parse(WORKED), cwd: PROJECT.path }];

    const [row] = await restoreList(store, PROJECT);

    expect(row!.lastSpokeAt).toBe(later);
  });

  it("nothing he said within reach of the end leaves the row's clock alone", async () => {
    // A record whose conversation is buried under more than the walk will read.
    const filler = nobody(WORKED);
    lay(said('the first thing', SPOKE) + filler.repeat(Math.ceil(TAIL_LIMIT / filler.length) + 12));
    kit.index = [{ sessionId: OUTSIDE, lastModified: Date.parse(WORKED), cwd: PROJECT.path }];

    const [row] = await restoreList(store, PROJECT);

    expect(row!.lastSpokeAt).toBe(row!.lastActiveAt);
  });

  it('a chat with no record at all is no worse off than it is today', async () => {
    kit.index = [{ sessionId: 'bbbbbbbb-9999-9999-9999-999999999999', lastModified: Date.parse(WORKED), cwd: PROJECT.path }];

    const [row] = await restoreList(store, PROJECT);

    expect(row!.lastSpokeAt).toBe(WORKED);
  });
});

describe('what reading it costs', () => {
  it('a record that has not moved is not read a second time', async () => {
    const size = lay(said('the first thing', SPOKE) + nobody(WORKED));
    kit.index = [{ sessionId: OUTSIDE, lastModified: Date.parse(WORKED), cwd: PROJECT.path }];
    expect((await restoreList(store, PROJECT))[0]!.lastSpokeAt).toBe(SPOKE);

    // The same length and the same moment, holding something else entirely. A
    // look that read it again would say so.
    const swap = said('a different thing', NEVER);
    lay(swap + 'x'.repeat(size - Buffer.byteLength(swap) - 1) + '\n');
    expect(statSync(record).size).toBe(size);

    expect((await restoreList(store, PROJECT))[0]!.lastSpokeAt).toBe(SPOKE);
  });

  it('a record that has grown is read over what it gained and nothing behind it', async () => {
    const size = lay(said('the first thing', SPOKE) + nobody(WORKED));
    kit.index = [{ sessionId: OUTSIDE, lastModified: Date.parse(WORKED), cwd: PROJECT.path }];
    expect((await restoreList(store, PROJECT))[0]!.lastSpokeAt).toBe(SPOKE);

    // The bytes already read are replaced, in place and to the letter, with a
    // line dated later than anything else here — a trap for a look that goes
    // back over them. Nothing on a real machine does this; the kit only ever
    // appends, which is the whole reason the old bytes may be left alone.
    const trap = said('never read this', NEVER);
    const handle = openSync(record, 'r+');
    writeSync(handle, Buffer.from(trap + 'x'.repeat(size - Buffer.byteLength(trap) - 1) + '\n'), 0, size, 0);
    // Then the record grows, with an agent's work in it and nothing he said.
    writeSync(handle, Buffer.from(nobody(WORKED)), 0, undefined, size);
    closeSync(handle);

    expect((await restoreList(store, PROJECT))[0]!.lastSpokeAt).toBe(SPOKE);

    // And what he DOES say next is found, over those new bytes alone.
    const grown = statSync(record).size;
    const again = openSync(record, 'r+');
    writeSync(again, Buffer.from(said('carry on', WORKED)), 0, undefined, grown);
    closeSync(again);

    expect((await restoreList(store, PROJECT))[0]!.lastSpokeAt).toBe(WORKED);
  });

  it('a record the kit has compacted is read again rather than trusted', async () => {
    lay(said('the first thing', SPOKE) + nobody(WORKED) + said('and the second', WORKED));
    kit.index = [{ sessionId: OUTSIDE, lastModified: Date.parse(WORKED), cwd: PROJECT.path }];
    expect((await restoreList(store, PROJECT))[0]!.lastSpokeAt).toBe(WORKED);

    // Shorter than it was: the kit has rewritten it, and what was read off the
    // old file is about a file that no longer exists.
    lay(said('the only thing left', SPOKE), NEVER);

    expect((await restoreList(store, PROJECT))[0]!.lastSpokeAt).toBe(SPOKE);
  });
});
