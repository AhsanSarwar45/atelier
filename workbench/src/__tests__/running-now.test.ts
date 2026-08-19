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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { procStartFromStat } from '../../../src/workbench/running.ts';
import { runningNow } from '../running.ts';

/** A config directory of our own; the tool's is never touched. */
let sessionsDir = '';
const wasConfig = process.env.CLAUDE_CONFIG_DIR;

/** A marker naming a process that really is alive: this one. */
function marker(name: string, sessionId: string): void {
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
