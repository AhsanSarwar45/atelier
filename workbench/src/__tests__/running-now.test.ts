/**
 * @vitest-environment node
 *
 * What the sidecar remembers about who is working where, and when it may not.
 *
 * The answer is kept for a couple of seconds so a list of forty rows costs one
 * directory read. That is right for a screen redrawing itself and wrong for a
 * decision taken once: opening a chat asks whether another program is in it,
 * and nothing asks again. A chat that started being worked in a moment ago is
 * missing from the remembered answer, so it was opened as a dead record and
 * never followed, however long the reader watched (bw-dmxj.8).
 *
 * It lives beside the sidecar rather than with the browser's tests because it
 * reaches the real directory and the real process table, which is the whole of
 * what it is checking.
 */
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RECORD_QUIET_MS } from '../../../src/workbench/chat-state.ts';
import { procStartFromStat } from '../../../src/workbench/running.ts';
import { holdsNow, runningNow } from '../running.ts';

/** A config directory of our own; the tool's is never touched. */
let sessionsDir = '';
const wasConfig = process.env.CLAUDE_CONFIG_DIR;

/** A marker naming a process that really is alive: this one. */
function marker(name: string, sessionId: string, over: Record<string, unknown> = {}): void {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  writeFileSync(
    join(sessionsDir, `${name}.json`),
    JSON.stringify({
      sessionId,
      pid: process.pid,
      cwd: '/home/me/project',
      startedAt: 1_760_000_000_000,
      procStart: procStartFromStat(stat) ?? '1',
      entrypoint: 'cli',
      kind: 'interactive',
      ...over,
    }),
  );
}

describe('the remembered answer, and the decision that may not use it', () => {
  beforeAll(() => {
    sessionsDir = join(mkdtempSync(join(tmpdir(), 'markers-')), 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = join(sessionsDir, '..');
    // Frozen, so the memory cannot quietly expire mid-test and pass this for
    // the wrong reason.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T12:00:00Z'));
  });

  afterAll(() => {
    vi.useRealTimers();
    if (wasConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = wasConfig;
  });

  it('reads the directory again for a caller that only asks once', () => {
    marker('1001', 'first-chat');
    expect(runningNow(true).has('first-chat'), 'the first read missed a live marker').toBe(true);

    // A chat starts being worked in a moment later.
    marker('1002', 'second-chat');

    // A screen redrawing itself is handed the remembered answer …
    expect(runningNow().has('second-chat')).toBe(false);
    // … and a decision nothing revisits is not.
    expect(runningNow(true).has('second-chat')).toBe(true);
    expect(runningNow(true).has('first-chat')).toBe(true);
  });
});

/**
 * What a held conversation is doing, off the machine itself.
 *
 * The pure half of this is `chat-state.ts`; what is checked here is the two
 * signals being picked up off a real directory — the marker's own status where
 * the tool writes one, and the record's own mtime where it does not. Measured
 * on this machine on 2026-08-21: of thirteen markers, seven carried a status
 * and six did not, and the six were every chat a host was driving (bw-96is).
 */
describe('what each held conversation is doing', () => {
  const NOW = new Date('2026-08-21T12:00:00Z').getTime();
  let config = '';

  /** A record for a chat, last written however many seconds ago. */
  function record(sessionId: string, agoMs: number): void {
    const folder = join(config, 'projects', '-home-me-project');
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `${sessionId}.jsonl`);
    writeFileSync(path, '{"type":"assistant"}\n');
    const when = (NOW - agoMs) / 1000;
    utimesSync(path, when, when);
  }

  beforeAll(() => {
    config = mkdtempSync(join(tmpdir(), 'holds-'));
    sessionsDir = join(config, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = config;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterAll(() => {
    vi.useRealTimers();
    if (wasConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = wasConfig;
  });

  it('takes the holder’s own word, and says which kind of holder it is', () => {
    marker('2001', 'a-busy-terminal', { status: 'busy', statusUpdatedAt: NOW - 12_000 });
    marker('2002', 'a-quiet-terminal', { status: 'idle', statusUpdatedAt: NOW - 60_000 });

    const holds = holdsNow(true);
    expect(holds.find((h) => h.id === 'a-busy-terminal')).toEqual({
      id: 'a-busy-terminal',
      holder: 'terminal',
      doing: 'working',
      // Nothing said which of the things it is doing, and a busy bit is not a
      // claim about that (bw-jaoz.14.6).
      detail: null,
      told: false,
      // Counted from when it said so. A busy bit says nothing about steps, so
      // there is no second number behind it.
      since: NOW - 12_000,
      turnSince: NOW - 12_000,
      typicalMs: null,
    });
    expect(holds.find((h) => h.id === 'a-quiet-terminal')).toEqual({
      id: 'a-quiet-terminal',
      holder: 'terminal',
      doing: 'idle',
      detail: null,
      told: false,
      since: null,
      turnSince: null,
      typicalMs: null,
    });
  });

  it('falls back to the record for a chat a host drives, which writes no status', () => {
    marker('2003', 'a-working-host', { entrypoint: 'sdk-ts' });
    record('a-working-host', 2_000);
    marker('2004', 'a-quiet-host', { entrypoint: 'sdk-ts' });
    record('a-quiet-host', RECORD_QUIET_MS + 1_000);

    const holds = holdsNow(true);
    expect(holds.find((h) => h.id === 'a-working-host')).toMatchObject({
      holder: 'program',
      doing: 'working',
      since: NOW - 2_000,
    });
    expect(holds.find((h) => h.id === 'a-quiet-host')).toMatchObject({ holder: 'program', doing: 'idle', since: null });
  });

  it('holds one turn where it began while the step follows the record', () => {
    // The record of a working chat is written over and over. The two numbers
    // split that: the step follows the newest write, which is the piece of work
    // the reader is watching, and the turn stays where the burst began however
    // often the file grows (bw-jaoz.14.4).
    const begun = NOW - 4_000;
    marker('2006', 'a-long-turn', { entrypoint: 'sdk-ts' });
    record('a-long-turn', 4_000);
    const first = holdsNow(true).find((h) => h.id === 'a-long-turn');
    expect(first?.since).toBe(begun);
    expect(first?.turnSince).toBe(begun);

    // Three seconds later the record has been written again, half a second ago.
    vi.setSystemTime(new Date(NOW + 3_000));
    record('a-long-turn', -2_500);
    const later = holdsNow(true).find((h) => h.id === 'a-long-turn');
    expect(later?.since, 'the step must follow the record').toBe(NOW + 2_500);
    expect(later?.turnSince, 'the turn must not restart on a write').toBe(begun);
    vi.setSystemTime(new Date(NOW));
  });

  it('claims nothing about a chat nothing on the machine will speak for', () => {
    // No status, and no record to be found: the badge says somebody is in
    // there and the screen says nothing else, which is the honest answer.
    marker('2005', 'a-silent-host', { entrypoint: 'sdk-ts' });
    expect(holdsNow(true).find((h) => h.id === 'a-silent-host')).toEqual({
      id: 'a-silent-host',
      holder: 'program',
      doing: 'unknown',
      detail: null,
      told: false,
      since: null,
      turnSince: null,
      typicalMs: null,
    });
  });

  it('answers for every chat a live process is holding, and in a settled order', () => {
    const holds = holdsNow(true);
    expect(holds.map((h) => h.id)).toEqual([...holds.map((h) => h.id)].sort());
    expect(holds.map((h) => h.id)).toEqual(Array.from(runningNow(true).keys()).sort());
  });
});

/**
 * What a session says about itself, picked up off the same directory.
 *
 * The marker carries one bit — busy or idle — so a chat summarising itself and
 * a chat halfway through a command are the same fact to it. The line a hook
 * writes beside the marker is the session naming its own state, and it wins
 * over anything worked out from a file (bw-jaoz.14.6).
 */
describe('what a session says about itself', () => {
  const NOW = new Date('2026-08-22T12:00:00Z').getTime();
  let config = '';

  function said(sessionId: string, what: unknown): void {
    writeFileSync(join(sessionsDir, `${sessionId}.doing.json`), typeof what === 'string' ? what : JSON.stringify(what));
  }

  function record(sessionId: string, agoMs: number): void {
    const folder = join(config, 'projects', '-home-me-project');
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `${sessionId}.jsonl`);
    writeFileSync(path, '{"type":"assistant"}\n');
    const when = (NOW - agoMs) / 1000;
    utimesSync(path, when, when);
  }

  beforeAll(() => {
    config = mkdtempSync(join(tmpdir(), 'told-'));
    sessionsDir = join(config, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = config;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterAll(() => {
    vi.useRealTimers();
    if (wasConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = wasConfig;
  });

  it('takes the word of a session that named its own state, over the record', () => {
    // The record says only that something was written 40 seconds ago, which is
    // the whole of what the old reading had: 'Working'.
    marker('3001', 'a-compacting-chat', { entrypoint: 'sdk-ts' });
    record('a-compacting-chat', 40_000);
    said('a-compacting-chat', { doing: 'summarising', since: NOW - 40_000, detail: 'auto' });

    expect(holdsNow(true).find((h) => h.id === 'a-compacting-chat')).toMatchObject({
      doing: 'summarising',
      detail: 'auto',
      told: true,
      since: NOW - 40_000,
    });
  });

  it('beats the marker’s own busy bit, which cannot say which of the things it is', () => {
    marker('3002', 'a-waiting-terminal', { status: 'busy', statusUpdatedAt: NOW - 5_000 });
    said('a-waiting-terminal', { doing: 'waiting', since: NOW - 5_000, detail: 'Bash: rm -rf build' });

    expect(holdsNow(true).find((h) => h.id === 'a-waiting-terminal')).toMatchObject({
      doing: 'waiting',
      detail: 'Bash: rm -rf build',
      told: true,
    });
  });

  it('forgets a summarising claim nobody ever cleared', () => {
    // There is no hook for the end of a compaction, so a session killed in the
    // middle of one leaves this behind. A bar filling for ever is worse than
    // the honest guess underneath it.
    marker('3003', 'an-abandoned-claim', { entrypoint: 'sdk-ts' });
    record('an-abandoned-claim', 2_000);
    said('an-abandoned-claim', { doing: 'summarising', since: NOW - 3_600_000 });

    expect(holdsNow(true).find((h) => h.id === 'an-abandoned-claim')).toMatchObject({
      doing: 'working',
      told: false,
    });
  });

  it('lets a permission prompt stand however long the person is away', () => {
    // People go to lunch. A prompt is answered by a person, not by a timer, and
    // the hook that clears it fires when the turn ends.
    marker('3004', 'a-long-prompt', { status: 'busy', statusUpdatedAt: NOW - 7_200_000 });
    said('a-long-prompt', { doing: 'waiting', since: NOW - 7_200_000 });

    expect(holdsNow(true).find((h) => h.id === 'a-long-prompt')).toMatchObject({ doing: 'waiting', told: true });
  });

  it('ignores a line it cannot believe, rather than drawing it', () => {
    marker('3005', 'a-half-written-line', { status: 'busy', statusUpdatedAt: NOW - 1_000 });
    said('a-half-written-line', '{"doing":"summari');
    expect(holdsNow(true).find((h) => h.id === 'a-half-written-line')).toMatchObject({ doing: 'working', told: false });

    said('a-half-written-line', { doing: 'napping', since: NOW });
    expect(holdsNow(true).find((h) => h.id === 'a-half-written-line')).toMatchObject({ doing: 'working', told: false });

    said('a-half-written-line', { doing: 'summarising', since: NOW + 600_000 });
    expect(
      holdsNow(true).find((h) => h.id === 'a-half-written-line'),
      'a clock from the future is a clock nobody set',
    ).toMatchObject({ doing: 'working', told: false });
  });

  it('does not restart the turn when the session moves from one state to the next', () => {
    // Running a command, then summarising: two steps of one turn. The step's
    // clock moves with the state; the turn's does not (bw-jaoz.14.4).
    marker('3006', 'a-turn-of-two-halves', { entrypoint: 'sdk-ts' });
    record('a-turn-of-two-halves', 4_000);
    const first = holdsNow(true).find((h) => h.id === 'a-turn-of-two-halves');
    expect(first?.doing).toBe('working');
    const began = first?.turnSince ?? 0;

    said('a-turn-of-two-halves', { doing: 'summarising', since: NOW });
    const next = holdsNow(true).find((h) => h.id === 'a-turn-of-two-halves');
    expect(next?.doing).toBe('summarising');
    expect(next?.since, 'the step began when the session said so').toBe(NOW);
    expect(next?.turnSince, 'the turn is where the burst began').toBe(began);
  });
});
