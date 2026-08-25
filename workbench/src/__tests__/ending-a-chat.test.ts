/**
 * @vitest-environment node
 *
 * Ending a chat (bw-cnxh): the agent is taken away and every word of the
 * conversation is kept.
 *
 * The app had no way to do this at all. The only control that looked like one
 * was Stop, which cuts the answer in flight and leaves the agent standing —
 * those two are asserted apart here, because folding them together is the one
 * way this feature could arrive and quietly take the other away.
 *
 * The manager's ruling, 2026-08-25: ending keeps the chat. Nothing is deleted
 * and nothing is hidden, so most of what follows is about what SURVIVES it —
 * the row, the record, its place in the list, and the mark itself across a
 * restart.
 *
 * The driver is stubbed at the one call that would launch a real agent process,
 * the same seam its neighbours use.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeDriver } from '../drivers/claude.ts';
import { Sessions } from '../sessions.ts';
import { Store } from '../store.ts';

let root: string;
let project: string;
let dbPath: string;
let hadConfigDir: string | undefined;
let store: Store;
let sessions: Sessions;

const startOne = () => sessions.start({ projectId: 'p1', projectPath: project, brand: 'claude' as const });

/** What the chat's own record was told about where it stands, in order. */
const statesIn = (id: string): string[] =>
  sessions
    .replay(id, 0)
    .filter((e) => e.type === 'session.state')
    .map((e) => (e as { state: string }).state);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ending-a-chat-'));
  project = join(root, 'project');
  const config = join(root, 'config');
  mkdirSync(project, { recursive: true });
  mkdirSync(config, { recursive: true });
  hadConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;

  vi.spyOn(ClaudeDriver.prototype, 'start').mockResolvedValue(undefined);
  vi.spyOn(ClaudeDriver.prototype, 'close').mockResolvedValue(undefined);
  vi.spyOn(ClaudeDriver.prototype, 'interrupt').mockResolvedValue(undefined);

  dbPath = join(root, 'workbench.db');
  store = new Store(dbPath);
  sessions = new Sessions(store);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (hadConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = hadConfigDir;
  rmSync(root, { recursive: true, force: true });
});

describe('ending a chat', () => {
  it('takes the agent away', async () => {
    const chat = await startOne();

    await sessions.close(chat.id);

    expect(ClaudeDriver.prototype.close).toHaveBeenCalledTimes(1);
    // And this app has let go of it. Asked through `stop`, which speaks to the
    // agent this app is holding and never wakes one — `send` would have proved
    // nothing here, because typing into a chat with no driver starts a new one
    // by design, and its refusal in this fixture comes from a record that was
    // never written rather than from the ending.
    await expect(sessions.stop(chat.id)).rejects.toThrow(/not running/);
  });

  it('and the row reads ended', async () => {
    const chat = await startOne();

    await sessions.close(chat.id);

    expect(store.getSession(chat.id)?.state).toBe('ended');
    expect(statesIn(chat.id).at(-1)).toBe('ended');
  });

  it('which is not what Stop does', async () => {
    // The fault this whole job is about: the one control that looked like an
    // ending only ever cut the answer in flight.
    const chat = await startOne();

    await sessions.stop(chat.id);

    expect(ClaudeDriver.prototype.interrupt).toHaveBeenCalledTimes(1);
    expect(ClaudeDriver.prototype.close).not.toHaveBeenCalled();
    expect(store.getSession(chat.id)?.state).not.toBe('ended');
  });
});

describe('and the chat is kept', () => {
  it('still in the list, where it was', async () => {
    const chat = await startOne();

    await sessions.close(chat.id);

    expect(store.listSessions('p1').map((s) => s.id)).toContain(chat.id);
  });

  it('with everything ever said in it', async () => {
    const chat = await startOne();
    const before = sessions.replay(chat.id, 0).length;

    await sessions.close(chat.id);

    // Longer, never shorter: the ending itself is written into the record like
    // anything else that happened in the conversation.
    expect(sessions.replay(chat.id, 0).length).toBeGreaterThan(before);
  });

  it('and it does not climb the list for having ended', async () => {
    // Ending is not activity. The list is ordered by when a conversation last
    // DID something, so a chat tidied away must not jump over the ones being
    // worked in (store.ts, updateSession's `touch`).
    const chat = await startOne();
    const before = store.getSession(chat.id)!.lastActiveAt;

    await sessions.close(chat.id);

    expect(store.getSession(chat.id)?.lastActiveAt).toBe(before);
  });

  it('and a restart leaves it ended rather than merely asleep', async () => {
    // The sweep on boot puts every row that claims to be running back to sleep,
    // because nothing survives a restart. An ended chat is the one thing it
    // must leave alone, or every ending on the machine is undone overnight.
    const chat = await startOne();
    await sessions.close(chat.id);

    new Store(dbPath).markAllDormant();

    expect(new Store(dbPath).getSession(chat.id)?.state).toBe('ended');
  });
});

describe('and it can be asked for twice, or of a chat with no agent', () => {
  it('says nothing a second time', async () => {
    const chat = await startOne();

    await sessions.close(chat.id);
    await sessions.close(chat.id);

    expect(ClaudeDriver.prototype.close).toHaveBeenCalledTimes(1);
    // One ending in the record, not two: said again it would be another frame
    // on every stream watching, for nothing that changed.
    expect(statesIn(chat.id).filter((s) => s === 'ended')).toHaveLength(1);
  });

  it('ends a chat that was only ever asleep', async () => {
    // Most of the list has no agent attached, and a sleeping chat is exactly
    // the one somebody tidies away. Refusing those would draw a control on rows
    // it could not act on.
    store.createSession({
      id: 'asleep-1',
      brand: 'claude',
      externalId: null,
      projectId: 'p1',
      projectPath: project,
      cwd: project,
      model: null,
      permissionMode: 'default',
      title: 'A chat from last week',
      state: 'dormant',
      origin: 'app',
      createdAt: '2026-08-18T09:00:00.000Z',
      lastActiveAt: '2026-08-18T09:00:00.000Z',
      lastSpokeAt: null,
    });

    await sessions.close('asleep-1');

    expect(store.getSession('asleep-1')?.state).toBe('ended');
  });

  it('but refuses a chat it has never heard of', async () => {
    await expect(sessions.close('no-such-chat')).rejects.toThrow(/no-such-chat/);
  });
});

describe('an agent that will not shut down', () => {
  it('is let go of anyway, so the chat can still be ended', async () => {
    const chat = await startOne();
    vi.spyOn(ClaudeDriver.prototype, 'close').mockRejectedValue(new Error('the pipe was already gone'));

    await sessions.close(chat.id);

    expect(store.getSession(chat.id)?.state).toBe('ended');
  });

  it('and what it cost is written into the chat rather than thrown at the screen', async () => {
    // The chat IS ended — this app has let go of it — so a refusal on the
    // screen would say the opposite of what happened. What it actually cost is
    // that the brand's own process may still be standing, and that belongs in
    // the conversation it belongs to.
    const chat = await startOne();
    vi.spyOn(ClaudeDriver.prototype, 'close').mockRejectedValue(new Error('the pipe was already gone'));

    await sessions.close(chat.id);

    const said = sessions.replay(chat.id, 0).find((e) => e.type === 'error');
    expect(said).toMatchObject({ fatal: false });
    expect((said as { message: string }).message).toContain('the pipe was already gone');
  });
});
