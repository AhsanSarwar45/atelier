/**
 * @vitest-environment node
 *
 * A chat begun outside this app, heard about without anybody clicking.
 *
 * The list is built once, when a screen mounts, so until now a conversation
 * started in Zed or in a terminal sat unlisted until something else happened to
 * fetch the list again (bw-uivp). The folder the tools write those
 * conversations into is watched instead, and every browser on the app-wide
 * stream is told the one word.
 *
 * What is checked here is the rate as much as the hearing: an agent mid-turn
 * appends to its record over and over, and a word per append would be a stream
 * of them with a refetch of the whole list behind each. One a second, whatever
 * lands.
 *
 * It lives beside the sidecar rather than with the browser's tests because it
 * watches a real directory and waits on the real kernel telling us it moved,
 * which is the whole of what it is checking.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { watchOutside } from '../outside.ts';

/** A config directory of our own, laid out the way the tools lay theirs out. */
let config = '';
let project = '';
let elsewhere = '';

/** The working directory the second project's chats are held in. */
const ELSEWHERE = '/home/me/elsewhere';
const wasConfig = process.env.CLAUDE_CONFIG_DIR;

/** The settle is a second; everything here waits past one to read the count. */
const PAST_THE_SECOND_MS = 1_400;

/** One line of a conversation, in the shape the tools write it. */
function line(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

/** The same, from a chat that says which directory it is being held in. */
function lineFrom(cwd: string, text: string): string {
  return JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: text } }) + '\n';
}

const naps = (ms: number) => new Promise((wake) => setTimeout(wake, ms));

beforeAll(() => {
  config = mkdtempSync(join(tmpdir(), 'outside-chats-'));
  // A project the owner has worked in before: a chat begun in Zed lands here as
  // a new file beside the ones already there.
  project = join(config, 'projects', '-home-me-project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'an-old-chat.jsonl'), line('yesterday'));
  // Another project entirely, whose records say where they are being written.
  elsewhere = join(config, 'projects', '-home-me-elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, 'an-old-chat.jsonl'), lineFrom(ELSEWHERE, 'yesterday'));
  process.env.CLAUDE_CONFIG_DIR = config;
});

afterAll(() => {
  if (wasConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = wasConfig;
  rmSync(config, { recursive: true, force: true });
});

/** Whatever a case subscribed, gone before the next one, watcher and all. */
let stopWatching: (() => void) | null = null;
afterEach(() => {
  stopWatching?.();
  stopWatching = null;
});

describe('the folder the tools write conversations into', () => {
  it('says the word once for a chat that appears, and no more than once a second for a burst', async () => {
    let said = 0;
    stopWatching = watchOutside(() => {
      said += 1;
    });

    // A chat started somewhere else entirely.
    writeFileSync(join(project, 'a-new-chat.jsonl'), line('started in Zed'));
    await naps(PAST_THE_SECOND_MS);
    expect(said, 'a conversation appeared and nobody was told').toBe(1);

    // Now the agent in it gets to work: forty writes inside the one second,
    // which is one word between them and not forty.
    for (let i = 0; i < 40; i += 1) appendFileSync(join(project, 'a-new-chat.jsonl'), line(`turn ${i}`));
    await naps(PAST_THE_SECOND_MS);
    expect(said, 'a busy agent flooded the stream').toBe(2);
  }, 10_000);

  it('says whose work it was, so other projects’ screens can ignore it', async () => {
    // Measured against the running sidecar: four words in one idle twelve-second
    // window, all of them other people's agents typing, and each rebuilt the
    // whole list on every open tab (bw-uivp.4). The word carries the working
    // directory so a screen can tell whether it is being spoken to.
    const said: string[][] = [];
    stopWatching = watchOutside((folders) => {
      said.push(folders);
    });

    writeFileSync(join(elsewhere, 'a-new-chat.jsonl'), lineFrom(ELSEWHERE, 'started in Zed'));
    await naps(PAST_THE_SECOND_MS);
    expect(said).toEqual([[ELSEWHERE]]);
  }, 10_000);

  it('and says nothing of the kind when it cannot tell, so no chat is missed', async () => {
    // This project's records predate the field, or were written by a tool that
    // does not set it. An unplaceable word is bare, which every screen takes as
    // possibly its own: fail towards the extra fetch, never the missing chat.
    const said: string[][] = [];
    stopWatching = watchOutside((folders) => {
      said.push(folders);
    });

    writeFileSync(join(project, 'another-new-chat.jsonl'), line('started in Zed'));
    await naps(PAST_THE_SECOND_MS);
    expect(said).toEqual([[]]);
  }, 10_000);

  it('stops watching when the last reader has gone', async () => {
    let said = 0;
    const stop = watchOutside(() => {
      said += 1;
    });
    stop();

    writeFileSync(join(project, 'after-they-left.jsonl'), line('nobody is listening'));
    await naps(PAST_THE_SECOND_MS);
    expect(said, 'a stream nobody is on was still being written to').toBe(0);
  }, 10_000);
});
