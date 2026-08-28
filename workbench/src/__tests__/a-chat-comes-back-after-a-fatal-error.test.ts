/**
 * @vitest-environment node
 *
 * A chat whose message stream dies, and whether it can be talked to again
 * (bw-sxzv.2).
 *
 * One cancelled helper used to throw inside the loop reading the kit's
 * messages. The loop ended, the chat said Failed — and then nothing else ever
 * worked in it. Every later message went to a driver holding a transport that
 * was gone: it took the turn, said Thinking, and left it there. Stop was no
 * better, because it asked the same dead transport to stop and waited on an
 * answer that never came, for the ten seconds the browser gives a command
 * before it gives up. The only way out was restarting the app.
 *
 * So a stream error now puts the driver down before it says a word about what
 * happened, and the app lets go of it on that word. What follows holds both
 * halves of that: the driver stops claiming to work, and the next thing he
 * types starts a fresh run and is answered.
 *
 * The driver is stubbed at the one call that would launch a real agent
 * process, the same seam its neighbours use.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeDriver } from '../drivers/claude.ts';
import type { DriverEvent, StartOptions } from '../drivers/types.ts';
import { Sessions } from '../sessions.ts';
import { Store } from '../store.ts';

/**
 * The driver's own workings, reached past their privacy.
 *
 * There is no public way in: the alternative to standing a stream up by hand
 * is `start()`, which launches a real agent. This is the same reach its
 * neighbours use to drive `emit`.
 */
interface Innards {
  emit: (e: DriverEvent) => void;
  q: unknown;
  inbox: unknown[];
  asks: Map<string, { resolve: (r: { behavior: string; message?: string }) => void; suggestions: undefined; input: Record<string, unknown> }>;
  pump: () => Promise<void>;
}
const innards = (driver: ClaudeDriver): Innards => driver as unknown as Innards;

/**
 * A run whose messages stop coming, and whose handle answers nothing.
 *
 * Both halves are the real fault: the stream threw, and the handle it was read
 * from stayed there afterwards, taking a Stop and never coming back.
 */
function deadTransport(err: Error) {
  return {
    async *[Symbol.asyncIterator]() {
      throw err;
    },
    interrupt: () => new Promise<never>(() => {}),
  };
}

/** A driver reading a run that is about to die, and everything it then says. */
function readingADyingRun() {
  const said: DriverEvent[] = [];
  const driver = new ClaudeDriver();
  innards(driver).emit = (e) => said.push(e);
  innards(driver).q = deadTransport(new Error('the kit stopped answering'));
  return { driver, said, pump: () => innards(driver).pump() };
}

describe('a chat whose message stream dies', () => {
  it('says so, once, and says it failed', async () => {
    const { said, pump } = readingADyingRun();

    await pump();

    expect(said.map((e) => e.type)).toEqual(['error', 'session.state']);
    expect(said[0]).toMatchObject({ type: 'error', message: 'the kit stopped answering', fatal: true });
    expect(said[1]).toMatchObject({ type: 'session.state', state: 'errored' });
  });

  it('lets go of the run before it says it, so nothing acts on a driver still claiming to work', async () => {
    // Order, not decoration: `emit` runs the whole publishing path there and
    // then — the record, the browser, and the app letting go of this driver —
    // so everything it reaches must find a driver that has already stopped.
    const { driver, pump } = readingADyingRun();
    let handleWhenItSpoke: unknown = 'never spoke';
    innards(driver).emit = () => {
      handleWhenItSpoke = innards(driver).q;
    };

    await pump();

    expect(handleWhenItSpoke).toBeNull();
  });

  it('and a Stop then comes straight back instead of waiting on a transport that is gone', async () => {
    // Ten seconds was the real cost of this: the browser gives a command that
    // long before it gives up, and his Stop spent all of it waiting on a run
    // handle that had nothing left to answer with.
    const { driver, pump } = readingADyingRun();
    await pump();

    const outcome = await Promise.race([
      driver.interrupt().then(() => 'came back'),
      new Promise((wake) => setTimeout(() => wake('still waiting'), 100)),
    ]);

    expect(outcome).toBe('came back');
  });

  it('takes down any permission card left on his screen', async () => {
    // The call that card was blocking went with the transport. Leaving it up
    // asks him to answer nobody.
    const { driver, said, pump } = readingADyingRun();
    const answers: string[] = [];
    innards(driver).asks.set('ask-1', { resolve: (r) => answers.push(r.behavior), suggestions: undefined, input: {} });

    await pump();

    expect(answers).toEqual(['deny']);
    expect(said.some((e) => e.type === 'ask.resolved' && e.askId === 'ask-1')).toBe(true);
  });

  it('never says Thinking again, because nothing is reading', async () => {
    // The one thing a chat must never say about a turn nobody has. It used to
    // say exactly that: the turn went into a queue with no reader, under a chip
    // that spun until the app was restarted.
    const { driver, said, pump } = readingADyingRun();
    await pump();
    const afterwards = said.length;

    await expect(driver.send({ text: 'are you there?', images: [] })).rejects.toThrow(/no longer running/i);

    expect(said.slice(afterwards)).toEqual([]);
    expect(innards(driver).inbox).toEqual([]);
  });
});

let root: string;
let project: string;
let store: Store;
let sessions: Sessions;
let hadConfigDir: string | undefined;
/** Where the last-started driver was told to send its events. */
let wire: ((e: DriverEvent) => void) | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'a-chat-comes-back-'));
  project = join(root, 'project');
  const config = join(root, 'config');
  mkdirSync(project, { recursive: true });
  mkdirSync(config, { recursive: true });
  hadConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;

  wire = null;
  vi.spyOn(ClaudeDriver.prototype, 'start').mockImplementation(async function (this: ClaudeDriver, opts: StartOptions) {
    // The one thing the real `start` does that the rest of this depends on:
    // where this driver's events go. What it also does is launch an agent.
    innards(this).emit = opts.emit;
    wire = opts.emit;
  });

  store = new Store(join(root, 'workbench.db'));
  sessions = new Sessions(store);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (hadConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = hadConfigDir;
  rmSync(root, { recursive: true, force: true });
});

/** A chat, opened and then killed by the same error the driver reports. */
async function aChatThatDied(): Promise<string> {
  const chat = await sessions.start({ projectId: 'p1', projectPath: project, brand: 'claude' as const });
  wire?.({ type: 'error', message: 'the kit stopped answering', fatal: true });
  return chat.id;
}

/** Everything written into a chat's record, in order. */
const record = (id: string) => sessions.replay(id, 0);

describe('and the chat he goes back to', () => {
  it('answers him, by starting a fresh run', async () => {
    const id = await aChatThatDied();

    await sessions.send(id, 'are you there?');

    // Twice: the one that died, and the one his message woke. A chat left
    // holding the dead driver would have started nothing at all.
    expect(ClaudeDriver.prototype.start).toHaveBeenCalledTimes(2);
  });

  it('and tells him that is what happened', async () => {
    const id = await aChatThatDied();

    await sessions.send(id, 'are you there?');

    const said = record(id);
    expect(said.some((e) => e.type === 'notice' && e.text === 'Continuing this chat.')).toBe(true);
    expect(said.some((e) => e.type === 'text.delta' && e.text === 'are you there?')).toBe(true);
  });

  it('lets go only of a chat that actually died', async () => {
    // A red line is not a death. Everyday errors — a rejected command, a tool
    // that failed — are not fatal, and a chat must not be torn down under one.
    const chat = await sessions.start({ projectId: 'p1', projectPath: project, brand: 'claude' as const });
    wire?.({ type: 'error', message: 'that command is not available', fatal: false });

    await sessions.send(chat.id, 'try again');

    expect(ClaudeDriver.prototype.start).toHaveBeenCalledTimes(1);
    expect(record(chat.id).some((e) => e.type === 'notice' && e.text === 'Continuing this chat.')).toBe(false);
  });
});
