/**
 * @vitest-environment node
 *
 * Closing a chat (bw-cnxh): the agent is taken away, the chat falls asleep, and
 * every word of the conversation is kept.
 *
 * The app had no way to do this at all. The only control that looked like one
 * was Stop, which cuts the answer in flight and leaves the agent standing —
 * those two are asserted apart here, because folding them together is the one
 * way this feature could arrive and quietly take the other away.
 *
 * The manager's ruling, 2026-08-26: closing a chat is closing the terminal it
 * ran in. There is no state of its own for it and no word on the row, because a
 * closed chat and a sleeping one are the same thing — no agent, and a click
 * wakes either. So what follows asserts sleep, not a mark, and mostly asserts
 * what SURVIVES: the row, the record, and its place in the list.
 *
 * The driver is stubbed at the one call that would launch a real agent process,
 * the same seam its neighbours use.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeDriver } from '../drivers/claude.ts';
import { HELD_ELSEWHERE, Sessions } from '../sessions.ts';
import { Store } from '../store.ts';

/**
 * Conversations another program is driving right now.
 *
 * The real answer comes off the markers Claude Code writes for its own
 * terminals, which a unit run has none of. Only the one call the door asks is
 * replaced; everything else in that module stays real, because its neighbours
 * read it too.
 */
const drivenElsewhere = new Set<string>();
vi.mock('../running.ts', async (real) => {
  const actual = await real<typeof import('../running.ts')>();
  return {
    ...actual,
    runningNow: (fresh?: boolean) => {
      const live = actual.runningNow(fresh);
      for (const id of drivenElsewhere) live.set(id, { pid: 1, since: 0 } as never);
      return live;
    },
  };
});

vi.mock('../registry.ts', async (real) => {
  const actual = await real<typeof import('../registry.ts')>();
  return {
    ...actual,
    providerHoldsNow: (fresh?: boolean) => [
      ...actual.providerHoldsNow(fresh),
      ...[...drivenElsewhere].map((id) => ({
        id,
        holder: 'terminal' as const,
        doing: 'idle' as const,
        since: null,
      })),
    ],
  };
});

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
  drivenElsewhere.clear();
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

describe('closing a chat', () => {
  it('takes the agent away', async () => {
    const chat = await startOne();

    await sessions.close(chat.id);

    expect(ClaudeDriver.prototype.close).toHaveBeenCalledTimes(1);
    // And this app has let go of it. Asked through `stop`, which speaks to the
    // agent this app is holding and never wakes one — `send` would have proved
    // nothing here, because typing into a chat with no driver starts a new one
    // by design, and its refusal in this fixture comes from a record that was
    // never written rather than from the closing.
    await expect(sessions.stop(chat.id)).rejects.toThrow(/not running/);
  });

  it('and the chat falls asleep, in the same words as any other sleeping chat', async () => {
    // Not a state of its own. Closing a chat is closing the terminal it ran in
    // (the manager, 2026-08-26), and a chat whose terminal is gone is asleep —
    // the same thing the list already says about most of its rows.
    const chat = await startOne();

    await sessions.close(chat.id);

    expect(store.getSession(chat.id)?.state).toBe('dormant');
    expect(statesIn(chat.id).at(-1)).toBe('dormant');
  });

  it('which is not what Stop does', async () => {
    // The fault this whole job is about: the one control that looked like a
    // closing only ever cut the answer in flight.
    const chat = await startOne();

    await sessions.stop(chat.id);

    expect(ClaudeDriver.prototype.interrupt).toHaveBeenCalledTimes(1);
    expect(ClaudeDriver.prototype.close).not.toHaveBeenCalled();
    expect(store.getSession(chat.id)?.state).not.toBe('dormant');
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

    // Longer, never shorter: the closing itself is written into the record like
    // anything else that happened in the conversation.
    expect(sessions.replay(chat.id, 0).length).toBeGreaterThan(before);
  });

  it('and it does not climb the list for having been closed', async () => {
    // Closing is not activity. The list is ordered by when a conversation last
    // DID something, so a chat tidied away must not jump over the ones being
    // worked in (store.ts, updateSession's `touch`).
    const chat = await startOne();
    const before = store.getSession(chat.id)!.lastActiveAt;

    await sessions.close(chat.id);

    expect(store.getSession(chat.id)?.lastActiveAt).toBe(before);
  });

  it('and a row left marked ended by the old build reads asleep after a restart', async () => {
    // The one day this shipped, closing wrote `ended` into the row. Those rows
    // are on disk on the manager's machine and would otherwise draw a word the
    // app no longer has (bw-cnxh.10). The sweep on boot heals them, because it
    // already visits every row that claims to be anything but asleep — a
    // migration for a state that lived one day would be the heavier answer.
    store.createSession({
      id: 'stale-1',
      brand: 'claude',
      externalId: null,
      projectId: 'p1',
      projectPath: project,
      cwd: project,
      model: null,
      permissionMode: 'default',
      title: 'Closed under the old build',
      state: 'ended' as never,
      origin: 'app',
      createdAt: '2026-08-25T09:00:00.000Z',
      lastActiveAt: '2026-08-25T09:00:00.000Z',
      lastSpokeAt: null,
    });

    new Store(dbPath).markAllDormant();

    expect(new Store(dbPath).getSession('stale-1')?.state).toBe('dormant');
  });
});

describe('and it can be asked for twice, or of a chat with no agent', () => {
  it('says nothing a second time', async () => {
    const chat = await startOne();

    await sessions.close(chat.id);
    await sessions.close(chat.id);

    expect(ClaudeDriver.prototype.close).toHaveBeenCalledTimes(1);
    // One falling-asleep in the record, not two: said again it would be another
    // frame on every stream watching, for nothing that changed.
    expect(statesIn(chat.id).filter((s) => s === 'dormant')).toHaveLength(1);
  });

  it('and says nothing at all of a chat that was already asleep', async () => {
    // Most of the list has no agent attached. There is nothing to take away
    // from one of those, so the record must not gain an event saying there was.
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

    expect(store.getSession('asleep-1')?.state).toBe('dormant');
    expect(statesIn('asleep-1')).toEqual([]);
  });

  it('but refuses a chat it has never heard of', async () => {
    await expect(sessions.close('no-such-chat')).rejects.toThrow(/no-such-chat/);
  });

  it('and refuses one a terminal is driving at this moment', async () => {
    // The reader's finding (bw-cnxh.5). The screen already keeps the control
    // off such a row, but it learns that from a stream that can drop, and a
    // dropped stream must not be all that stands between a click and a chat
    // being called asleep while a terminal goes on typing into it. The door
    // asks the directory itself, at the moment of the attempt.
    store.createSession({
      id: 'theirs-1',
      brand: 'claude',
      externalId: 'ext-live',
      projectId: 'p1',
      projectPath: project,
      cwd: project,
      model: null,
      permissionMode: 'default',
      title: 'Worked in a terminal',
      state: 'idle',
      origin: 'terminal',
      createdAt: '2026-08-26T09:00:00.000Z',
      lastActiveAt: '2026-08-26T09:00:00.000Z',
      lastSpokeAt: null,
    });
    drivenElsewhere.add('ext-live');

    await expect(sessions.close('theirs-1')).rejects.toThrow(HELD_ELSEWHERE);
    // And it was left exactly as it was found, still awake.
    expect(store.getSession('theirs-1')?.state).toBe('idle');
  });

  it('but closes one WE are driving, though a live process is on it', async () => {
    // The door above asks who is on the conversation, and the honest answer for
    // every chat this app drives is "a live Claude process" — our own driver's
    // child, writing its marker into the same directory a terminal writes into.
    // Asked without qualification, that guard refused to close precisely the
    // chats the control is drawn on, which is every chat the feature is for.
    // "Somebody ELSE has it" is the question; a process being there is not
    // (registry.ts, bw-jaoz.2).
    const chat = await startOne();
    store.updateSession(chat.id, { externalId: 'ext-ours' });
    drivenElsewhere.add('ext-ours');

    await sessions.close(chat.id);

    expect(store.getSession(chat.id)?.state).toBe('dormant');
  });
});

describe('an agent that will not shut down', () => {
  it('is let go of anyway, so the chat can still be closed', async () => {
    const chat = await startOne();
    vi.spyOn(ClaudeDriver.prototype, 'close').mockRejectedValue(new Error('the pipe was already gone'));

    await sessions.close(chat.id);

    expect(store.getSession(chat.id)?.state).toBe('dormant');
  });

  it('and what it cost is written into the chat rather than thrown at the screen', async () => {
    // The chat IS closed — this app has let go of it — so a refusal on the
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
