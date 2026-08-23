/**
 * The hook that says what a session is doing, exercised for real (bw-jaoz.14.6).
 *
 * `doing-told.ts` is careful about every way this file can be wrong, and its own
 * cases feed it strings by hand. What those cases cannot say is whether anything
 * writes the string in the first place — so these run the actual script, with the
 * payloads Claude Code actually hands a hook, against a sessions directory of
 * their own, and read what lands through the reader that will read it in
 * production.
 *
 * Nothing here touches the real `~/.claude`: `CLAUDE_CONFIG_DIR` is pointed at a
 * temporary directory per case, which is the same switch the tool itself honours.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toldDoing } from '../../../src/workbench/doing-told.ts';

// From the repository root, which is where the suite is run from. Asserted
// below rather than assumed: a wrong path here would pass every case by never
// writing anything.
const HOOK = join(process.cwd(), 'workbench/hooks/session-doing.py');
const CHAT = 'ef56704b-9d5e-4c1a-8f21-0b7c33aa1e02';

let config: string;

beforeEach(() => {
  expect(existsSync(HOOK), `the hook is at ${HOOK}`).toBe(true);
  config = mkdtempSync(join(tmpdir(), 'doing-hook-'));
  mkdirSync(join(config, 'sessions'), { recursive: true });
});

afterEach(() => {
  rmSync(config, { recursive: true, force: true });
});

/** The line's path, named the way the reader names it. */
function linePath(id = CHAT): string {
  return join(config, 'sessions', `${id}.doing.json`);
}

/**
 * Fire the hook with one payload, the way the tool fires it: JSON on stdin,
 * `CLAUDE_CONFIG_DIR` in the environment. Throws if the script exits non-zero,
 * because a hook that fails interrupts the session it is describing.
 */
function fire(payload: Record<string, unknown> | string): void {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  execFileSync(HOOK, [], {
    input: body,
    env: { ...process.env, CLAUDE_CONFIG_DIR: config },
    encoding: 'utf8',
  });
}

/** What the reader makes of whatever now stands on disk. */
function readBack(id = CHAT) {
  const path = linePath(id);
  if (!existsSync(path)) return null;
  return toldDoing(readFileSync(path, 'utf8'), Date.now());
}

/** Put a claim there by hand, to watch an event clear it — or leave it. */
function standing(doing: string, detail: string | null = null): void {
  writeFileSync(linePath(), JSON.stringify({ doing, since: Date.now(), detail }));
}

describe('a compaction says so as it begins and ends', () => {
  it('writes summarising the moment it starts, with its own reason', () => {
    const before = Date.now();
    fire({ hook_event_name: 'PreCompact', session_id: CHAT, trigger: 'auto', cwd: '/tmp' });

    const said = readBack();
    expect(said?.doing, 'the one state the record cannot show us').toBe('summarising');
    expect(said?.detail, 'manual is him watching it, auto is the window filling up').toBe('auto');
    expect(said!.since, 'stamped when it happened, not when we looked').toBeGreaterThanOrEqual(before);
    expect(said!.since).toBeLessThanOrEqual(Date.now());
  });

  it('and takes it away the moment it finishes', () => {
    fire({ hook_event_name: 'PreCompact', session_id: CHAT, trigger: 'manual' });
    expect(readBack()?.doing).toBe('summarising');

    fire({ hook_event_name: 'PostCompact', session_id: CHAT, trigger: 'manual' });
    expect(readBack(), 'the bar comes off the screen because the run really ended').toBeNull();
  });

  it('survives the turn ending underneath it', () => {
    // Stop fires on compaction too. A compaction has its own end signal, and a
    // Stop that blanked this would take the bar off mid-fill every time.
    fire({ hook_event_name: 'PreCompact', session_id: CHAT, trigger: 'auto' });
    fire({ hook_event_name: 'Stop', session_id: CHAT });
    expect(readBack()?.doing).toBe('summarising');
  });

  it('is not answered by a tool finishing either', () => {
    fire({ hook_event_name: 'PreCompact', session_id: CHAT, trigger: 'auto' });
    fire({ hook_event_name: 'PostToolUse', session_id: CHAT, tool_name: 'Bash' });
    expect(readBack()?.doing).toBe('summarising');
  });
});

describe('a permission prompt is the one wait worth a word', () => {
  // Every payload below is the shape the tool actually sends (2.1.240): the
  // tool is named inside the sentence and nowhere else. An earlier version of
  // this suite hand-fed a tool_name field that does not exist, so it passed
  // while the chip drew a whole sentence (bw-jaoz.14.13).
  it('names the tool it is asking about, out of the sentence it is asked in', () => {
    fire({
      hook_event_name: 'Notification',
      session_id: CHAT,
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Bash',
    });
    const said = readBack();
    expect(said?.doing).toBe('waiting');
    expect(said?.detail).toBe('Bash');
  });

  it('says the sentence whole rather than nothing when it is worded some other way', () => {
    fire({
      hook_event_name: 'Notification',
      session_id: CHAT,
      notification_type: 'permission_prompt',
      message: 'Claude is asking about something',
    });
    expect(readBack()?.detail).toBe('Claude is asking about something');
  });

  it('reads a tool_name straight if a later version ever sends one', () => {
    fire({
      hook_event_name: 'Notification',
      session_id: CHAT,
      notification_type: 'permission_prompt',
      tool_name: 'Edit',
      message: 'Claude needs your permission to use Edit',
    });
    expect(readBack()?.detail).toBe('Edit');
  });

  it('says nothing at all when the notification is just a nudge', () => {
    // `idle_prompt` says the session has been quiet, which the marker's own
    // busy bit already says. A word here would only be a way to disagree.
    fire({ hook_event_name: 'Notification', session_id: CHAT, notification_type: 'idle_prompt' });
    expect(readBack()).toBeNull();
  });

  it('ends when the tool it was asking about runs', () => {
    fire({
      hook_event_name: 'Notification',
      session_id: CHAT,
      notification_type: 'permission_prompt',
      message: 'Claude needs your permission to use Edit',
    });
    fire({ hook_event_name: 'PostToolUse', session_id: CHAT, tool_name: 'Edit' });
    expect(readBack(), 'he answered it, so nothing is being asked').toBeNull();
  });

  it('ends when he types instead of answering', () => {
    standing('waiting', 'Bash');
    fire({ hook_event_name: 'UserPromptSubmit', session_id: CHAT, prompt: 'never mind' });
    expect(readBack()).toBeNull();
  });

  it('ends when the turn does, however it ended', () => {
    standing('waiting', 'Bash');
    fire({ hook_event_name: 'Stop', session_id: CHAT });
    expect(readBack()).toBeNull();
  });
});

describe('the session going away takes its word with it', () => {
  it('clears whatever stood, compaction included', () => {
    standing('summarising', 'auto');
    fire({ hook_event_name: 'SessionEnd', session_id: CHAT, reason: 'exit' });
    expect(readBack()).toBeNull();
  });

  it('does not mind there being nothing to clear', () => {
    fire({ hook_event_name: 'Stop', session_id: CHAT });
    fire({ hook_event_name: 'PostCompact', session_id: CHAT });
    expect(readBack()).toBeNull();
  });
});

describe('nothing it can be handed makes it fail', () => {
  it('takes a payload that is not JSON at all', () => {
    expect(() => fire('half a {')).not.toThrow();
  });

  it('takes a payload with no session in it', () => {
    expect(() => fire({ hook_event_name: 'PreCompact', trigger: 'auto' })).not.toThrow();
  });

  it('takes an event it has never heard of', () => {
    expect(() => fire({ hook_event_name: 'SomethingNew', session_id: CHAT })).not.toThrow();
    expect(readBack()).toBeNull();
  });

  it('refuses a session id that would write somewhere else', () => {
    // The id names a file. One with a separator in it names a file in another
    // directory, and this script is running with the user's own rights.
    fire({ hook_event_name: 'PreCompact', session_id: '../escaped', trigger: 'auto' });
    expect(existsSync(join(config, 'escaped.doing.json'))).toBe(false);
    expect(existsSync(join(config, 'sessions', '../escaped.doing.json'))).toBe(false);
  });

  it('leaves nothing half-written behind it', () => {
    // The line is renamed into place, so a reader on the next beat sees one
    // whole claim or the previous one — never a temporary file that looks like
    // a marker or a session.
    fire({ hook_event_name: 'PreCompact', session_id: CHAT, trigger: 'auto' });
    const left = execFileSync('ls', ['-A', join(config, 'sessions')], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(left).toEqual([`${CHAT}.doing.json`]);
  });
});
