/**
 * Knowing which chats somebody is working in right now.
 *
 * Every fixture here was copied off a real machine on 2026-08-19 (bw-dmxj.3):
 * the marker is this very session's, the `/proc` line is the process that wrote
 * it, and the six markers present at the time named six live processes whose
 * start times all matched the kernel's.
 *
 * The liveness test is injected, so these cases can ask what happens to a dead
 * process and to a recycled process number without killing anything.
 */
import { describe, expect, it } from 'vitest';

import { parseMarker, procStartFromStat, runningChats, startedByAPerson } from '@/workbench/running';
import type { IsAlive, SessionMarker } from '@/workbench/running';

/** A marker exactly as Claude Code wrote it, extra fields and all. */
const REAL_MARKER = JSON.stringify({
  pid: 1870877,
  sessionId: 'ef56704b-d82d-4c52-aa84-940c056a1006',
  cwd: '/home/ahsan/dev/beads-web/worktrees/bw-dmxj',
  startedAt: 1787137216129,
  procStart: '1558291',
  version: '2.1.235',
  peerProtocol: 1,
  kind: 'interactive',
  entrypoint: 'cli',
  messagingSocketPath: '/run/user/1000/cc-socks/1870877.sock',
  name: 'beads-web-0a',
  nameSource: 'derived',
  nameSince: 1787137216129,
  status: 'busy',
  updatedAt: 1787138388339,
  statusUpdatedAt: 1787138388339,
});

/** The `/proc/1870877/stat` line for that same process, verbatim. */
const REAL_STAT =
  '1870877 (claude) S 1867814 1870877 1867814 34824 1870877 4194304 522493 16423813 17345 380 3686 245 12435 ' +
  '2228 20 0 28 0 1558291 7072473088 89989 18446744073709551615 26892288 89114160 140733514141904 0 0 0 0 4096 ' +
  '2072145151 0 0 0 17 5 0 0 0 0 0 89118256 332988416 359387136 140733514144219 140733514144226 140733514144226 ' +
  '140733514149850 0';

function marker(over: Partial<SessionMarker> = {}): SessionMarker {
  return {
    sessionId: 'ef56704b-d82d-4c52-aa84-940c056a1006',
    pid: 1870877,
    cwd: '/home/ahsan/dev/beads-web/worktrees/bw-dmxj',
    startedAt: 1787137216129,
    procStart: '1558291',
    entrypoint: 'cli',
    kind: 'interactive',
    ...over,
  };
}

/**
 * A stand-in for the machine: the process numbers that exist, and when each one
 * started. It answers the same two questions the real test asks — is the number
 * taken, and is it taken by the same process — so a recycled number is a row in
 * a table here rather than a race nobody can reproduce.
 */
function machine(processes: Record<number, string>): IsAlive {
  return (m) => processes[m.pid] === m.procStart;
}

describe('reading one marker file', () => {
  it('takes the fields it acts on out of a real marker and ignores the rest', () => {
    expect(parseMarker(REAL_MARKER)).toEqual({
      sessionId: 'ef56704b-d82d-4c52-aa84-940c056a1006',
      pid: 1870877,
      cwd: '/home/ahsan/dev/beads-web/worktrees/bw-dmxj',
      startedAt: 1787137216129,
      procStart: '1558291',
      entrypoint: 'cli',
      kind: 'interactive',
    });
  });

  it('says nothing rather than throwing, on a file caught half-written', () => {
    expect(parseMarker('{"pid":1870877,"sessionId":"ef5670')).toBeNull();
    expect(parseMarker('')).toBeNull();
    expect(parseMarker('null')).toBeNull();
    expect(parseMarker('[1,2,3]')).toBeNull();
  });

  it('refuses a marker missing something it would have to guess at', () => {
    const whole = JSON.parse(REAL_MARKER) as Record<string, unknown>;
    for (const field of ['sessionId', 'pid', 'cwd', 'startedAt', 'procStart', 'entrypoint', 'kind']) {
      const without = { ...whole };
      delete without[field];
      expect(parseMarker(JSON.stringify(without))).toBeNull();
    }
  });

  it('refuses a field of the wrong shape as firmly as a missing one', () => {
    const whole = JSON.parse(REAL_MARKER) as Record<string, unknown>;
    // A number, not the string the tool writes: the comparison would never match.
    expect(parseMarker(JSON.stringify({ ...whole, procStart: 1558291 }))).toBeNull();
    expect(parseMarker(JSON.stringify({ ...whole, pid: '1870877' }))).toBeNull();
    expect(parseMarker(JSON.stringify({ ...whole, pid: 0 }))).toBeNull();
    expect(parseMarker(JSON.stringify({ ...whole, sessionId: '' }))).toBeNull();
  });
});

describe('the process’s start time, out of its stat line', () => {
  it('reads field 22 off a real line', () => {
    expect(procStartFromStat(REAL_STAT)).toBe('1558291');
  });

  it('is not fooled by a program whose own name holds spaces and brackets', () => {
    const awkward = REAL_STAT.replace('(claude)', '(claude (worker) 2)');
    expect(procStartFromStat(awkward)).toBe('1558291');
  });

  it('says nothing about a line it cannot read', () => {
    expect(procStartFromStat('')).toBeNull();
    expect(procStartFromStat('1870877 claude S 1 2 3')).toBeNull();
    expect(procStartFromStat('1870877 (claude) S 1 2 3')).toBeNull();
  });
});

describe('which chats somebody is working in', () => {
  it('a marker whose process is still there is a chat being worked in', () => {
    const running = runningChats([marker()], machine({ 1870877: '1558291' }));
    expect(Array.from(running.keys())).toEqual(['ef56704b-d82d-4c52-aa84-940c056a1006']);
    expect(running.get('ef56704b-d82d-4c52-aa84-940c056a1006')).toEqual({
      sessionId: 'ef56704b-d82d-4c52-aa84-940c056a1006',
      pid: 1870877,
      cwd: '/home/ahsan/dev/beads-web/worktrees/bw-dmxj',
      startedAt: 1787137216129,
      entrypoint: 'cli',
    });
  });

  it('a marker left behind by a process that is gone is not', () => {
    expect(runningChats([marker()], machine({}))).toEqual(new Map());
  });

  it('a process number handed to something else since is not that chat', () => {
    // The number is taken, so existence alone would call this chat alive. The
    // process behind it booted at a different moment, so it is not the one that
    // wrote the marker — it is whatever the kernel gave the number to next.
    const recycled = runningChats([marker()], machine({ 1870877: '9042117' }));
    expect(recycled.size).toBe(0);
  });

  it('sorts a whole directory into the ones being worked in and the ones not', () => {
    const markers = [
      marker(),
      marker({ sessionId: 'a-terminal-chat', pid: 12937, procStart: '5608', startedAt: 1787121689052 }),
      marker({ sessionId: 'a-crashed-chat', pid: 823422, procStart: '1408348', startedAt: 1787135716274 }),
    ];
    const running = runningChats(markers, machine({ 1870877: '1558291', 12937: '5608' }));
    expect(Array.from(running.keys()).sort()).toEqual(['a-terminal-chat', 'ef56704b-d82d-4c52-aa84-940c056a1006']);
  });

  it('a chat opened twice is named by its newest process', () => {
    const older = marker({ pid: 100, procStart: '111', startedAt: 1_000 });
    const newer = marker({ pid: 200, procStart: '222', startedAt: 2_000 });
    const running = runningChats([older, newer], machine({ 100: '111', 200: '222' }));
    expect(running.size).toBe(1);
    expect(running.get(older.sessionId)?.pid).toBe(200);
  });

  it('and by the older one when the newer has died — the question is who is there now', () => {
    const older = marker({ pid: 100, procStart: '111', startedAt: 1_000 });
    const newer = marker({ pid: 200, procStart: '222', startedAt: 2_000 });
    const running = runningChats([newer, older], machine({ 100: '111' }));
    expect(running.get(older.sessionId)?.pid).toBe(100);
  });

  it('nothing running is an empty answer, not a failure', () => {
    expect(runningChats([], machine({ 1870877: '1558291' })).size).toBe(0);
  });
});

describe('who is at the other end', () => {
  const running = (entrypoint: string) =>
    runningChats([marker({ entrypoint })], machine({ 1870877: '1558291' })).get(marker().sessionId)!;

  it('a terminal chat is a person typing', () => {
    expect(startedByAPerson(running('cli'))).toBe(true);
  });

  it('one an SDK host drives is not', () => {
    expect(startedByAPerson(running('sdk-cli'))).toBe(false);
    expect(startedByAPerson(running('sdk-ts'))).toBe(false);
  });
});
