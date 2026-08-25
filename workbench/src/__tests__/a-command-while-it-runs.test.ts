/**
 * @vitest-environment node
 *
 * A command somebody else is running right now, on the screen while it runs
 * (bw-jaoz.5).
 *
 * The rule that holds back the tail of a record still being written exists so
 * that a command is never drawn finished and empty: what a command printed
 * lands in a later line than the command itself, and the log is the transcript.
 * The cost the manager photographed is that a two-minute command was two
 * minutes of blank chat, beside a terminal that had been saying `Bash(…)
 * Running… 14s` the whole time.
 *
 * So the tail is held back from SETTLING, not from the screen: the call goes up
 * as running, is told how long it has been running, and settles in place — one
 * row, never two — when the answer lands.
 *
 * It lives beside the sidecar because it is the follower being checked, over a
 * real record on disk with a real marker beside it.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { procStartFromStat } from '../../../src/workbench/running.ts';
import { Sessions } from '../sessions.ts';
import { Store } from '../store.ts';

/** The conversation the terminal is holding, by the name the tool gives it. */
const EXT = '11111111-2222-3333-4444-555555555555';
/** The call that is still running. */
const CALL = 'toolu_running_one';
/** Long enough for the follower's first look, which is 1.5s apart after it. */
const A_BEAT_MS = 2_200;

let root = '';
let config = '';
let project = '';
let record = '';
let store: Store;
let sessions: Sessions;
let hadConfig: string | undefined;

const naps = (ms: number) => new Promise((wake) => setTimeout(wake, ms));

/**
 * One line of a record, in the shape the tool writes it — `parentUuid` and all.
 * The kit reads a record as a CHAIN from its last line back: lines that name no
 * parent are each their own conversation, and reading such a record returns the
 * last line alone.
 */
function line(o: Record<string, unknown>): string {
  return `${JSON.stringify({ cwd: project, sessionId: EXT, ...o })}\n`;
}

/**
 * The marker the tool leaves for a running process, naming this very process:
 * the only pid a test can be sure is alive.
 */
function marker(): string {
  const procStart =
    process.platform === 'linux'
      ? (procStartFromStat(readFileSync(`/proc/${process.pid}/stat`, 'utf8')) ?? '')
      : '';
  return JSON.stringify({
    sessionId: EXT,
    pid: process.pid,
    cwd: project,
    startedAt: Date.now(),
    procStart,
    entrypoint: 'cli',
    kind: 'cli',
    status: 'busy',
    statusUpdatedAt: Date.now(),
  });
}

/** Every event the chat has published, in order. */
const drawn = (id: string) => store.eventsSince(id, 0);
/**
 * What a browser opening the chat now would draw: everything the log holds
 * after the last `transcript.reset`, which is the word that throws away the
 * copy drawn before it.
 */
function onScreen(id: string) {
  const all = drawn(id);
  const last = all.map((e) => e.type).lastIndexOf('transcript.reset');
  return last === -1 ? all : all.slice(last + 1);
}
const of = (id: string, type: string) => drawn(id).filter((e) => e.type === type);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'while-it-runs-'));
  config = join(root, 'config');
  project = join(root, 'project');
  // The tool files a record under the working directory it was held in, with
  // every character that is not a letter or a number turned into a dash. Named
  // any other way, the reading finds nothing and there is no fault to see.
  const folder = join(config, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(folder, { recursive: true });
  mkdirSync(join(config, 'sessions'), { recursive: true });
  mkdirSync(project, { recursive: true });
  hadConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;

  record = join(folder, `${EXT}.jsonl`);
  // Ninety seconds ago, so what the row is told about how long it has been
  // running can only have come off the record's own line.
  const began = new Date(Date.now() - 90_000).toISOString();
  writeFileSync(
    record,
    line({
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      timestamp: began,
      message: { role: 'user', content: 'run the tests' },
    }) +
      line({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        timestamp: began,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: CALL, name: 'Bash', input: { command: 'npm test' } }],
        },
      }),
  );
  writeFileSync(join(config, 'sessions', `${process.pid}.json`), marker());

  store = new Store(join(root, 'workbench.db'));
  sessions = new Sessions(store);
});

afterEach(() => {
  if (hadConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = hadConfig;
  rmSync(root, { recursive: true, force: true });
});

const open = () =>
  sessions.open({ externalId: EXT, brand: 'claude' as const, projectId: 'p1', projectPath: project });

describe('a chat a terminal is working in', () => {
  it('draws the command it is running now, and how long it has been at it', async () => {
    const chat = await open();
    await naps(A_BEAT_MS);

    const started = of(chat.id, 'tool.started');
    expect(started.map((e) => (e as unknown as { toolCallId: string }).toolCallId)).toEqual([CALL]);
    // In English rather than in shell, which is the whole of bw-7ks.24. The
    // row settles into the past tense; the line under it says `Running the
    // tests` while it is still going.
    expect((started[0] as unknown as { title: string }).title).toBe('Ran the tests');
    // Nothing came back yet, so nothing says it is over.
    expect(of(chat.id, 'tool.completed')).toEqual([]);

    // Ninety seconds by the record's own clock, not none by ours: the reader
    // opened this chat a minute and a half into the command.
    const [told] = of(chat.id, 'tool.progress') as unknown as { toolCallId: string; seconds: number }[];
    expect(told?.toolCallId).toBe(CALL);
    expect(told?.seconds).toBeGreaterThanOrEqual(89);
    expect(told?.seconds).toBeLessThan(120);
  }, 20_000);

  it('settles that same row when the answer lands, rather than drawing a second one', async () => {
    const chat = await open();
    await naps(A_BEAT_MS);
    expect(of(chat.id, 'tool.started')).toHaveLength(1);

    appendFileSync(
      record,
      line({
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: CALL, content: '282 passed' }] },
      }),
    );
    await naps(A_BEAT_MS);

    // One command, one row: the answer finishes the row already standing.
    expect(of(chat.id, 'tool.started')).toHaveLength(1);
    const [ended] = of(chat.id, 'tool.completed') as unknown as { toolCallId: string; ok: boolean; output: string }[];
    expect(ended?.toolCallId).toBe(CALL);
    expect(ended?.ok).toBe(true);
    expect(ended?.output).toContain('282 passed');
  }, 20_000);
  it('draws what landed while nobody was watching, when the chat is opened again', async () => {
    const chat = await open();
    const stop = sessions.subscribe(chat.id, () => {});
    await naps(A_BEAT_MS);
    expect(of(chat.id, 'tool.started')).toHaveLength(1);

    // The reader looks at something else: the follower is torn down, and the
    // tail it was holding belongs to nobody.
    stop();
    // And that program finishes and goes, so what it did lands with no
    // follower to see it.
    rmSync(join(config, 'sessions', `${process.pid}.json`), { force: true });
    appendFileSync(
      record,
      line({
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: CALL, content: '313 passed' }] },
      }) +
        line({
          type: 'assistant',
          uuid: 'a2',
          parentUuid: 'u2',
          timestamp: new Date().toISOString(),
          message: { role: 'assistant', content: 'Nothing broke.' },
        }),
    );

    // Opened again: the chat holds the whole of what happened while he was away.
    const again = await open();
    expect(again.id).toBe(chat.id);
    await naps(A_BEAT_MS);

    // What the reader is shown is what the log says after the last word to drop
    // what was drawn before it: the rows that stood while he watched are still
    // in the log, and a browser that never left is told to throw them away and
    // take this copy (bw-1u1.27).
    const shown = onScreen(chat.id);
    const said = shown
      .filter((e) => e.type === 'text.delta')
      .map((e) => (e as unknown as { text: string }).text)
      .join('');
    expect(said, 'what the other program said while nobody watched was dropped').toContain('Nothing broke.');
    // One row for that command, and it says what the command printed rather
    // than standing empty.
    const ended = shown.filter((e) => e.type === 'tool.completed') as unknown as {
      toolCallId: string;
      ok: boolean;
      output: string;
    }[];
    expect(ended.map((e) => e.toolCallId)).toEqual([CALL]);
    expect(ended[0]?.output).toContain('313 passed');
    expect(shown.filter((e) => e.type === 'tool.started')).toHaveLength(1);
  }, 20_000);
});
