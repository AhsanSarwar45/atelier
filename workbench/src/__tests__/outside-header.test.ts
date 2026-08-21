/**
 * @vitest-environment node
 *
 * What a chat begun in a terminal is running, read off its own record.
 *
 * The screen learns the model and the mode from two events, and both are
 * published only where this app drives the agent. A chat begun in a terminal is
 * imported and followed and never driven, so the line above it drew neither for
 * its whole life — the word "claude" alone (bw-ja9l.2).
 *
 * Both facts are on disk. Measured on the manager's own record on 2026-08-21:
 * 59 lines of `type: "permission-mode"` in one 1,697-line file, and 358
 * assistant replies each carrying the model that wrote them. The kit's own
 * reader hands back neither — it returns conversation, and a mode line is not
 * conversation — which is why this reads the file.
 *
 * The one thing it must never do is answer from the owner's settings. The store
 * row for such a chat holds a mode copied from them at import time, and the
 * terminal it is describing may be in any mode at all: a badge saying "Ask
 * first" over a terminal that skips every check is worse than a blank line
 * (bw-7ks.23).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runningIn, RecordTail } from '../record-tail.ts';

let dir: string;
let path: string;

/** The line the kit writes every time the mode changes, and nothing else. */
const modeLine = (mode: string) =>
  JSON.stringify({ type: 'permission-mode', permissionMode: mode, sessionId: 'sess' }) + '\n';

/** A reply, carrying the model that wrote it. */
const reply = (model: string, uuid: string, sidechain = false) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    sessionId: 'sess',
    ...(sidechain ? { isSidechain: true } : {}),
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] },
  }) + '\n';

/** A prompt somebody typed, which the kit stamps with the mode it was in. */
const typed = (uuid: string, mode?: string) =>
  JSON.stringify({
    type: 'user',
    uuid,
    sessionId: 'sess',
    ...(mode ? { permissionMode: mode, promptSource: 'typed' } : {}),
    message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
  }) + '\n';

/** Bookkeeping the kit also writes, which says nothing about either. */
const noise = (i: number) =>
  JSON.stringify({ type: 'file-history-snapshot', sessionId: 'sess', n: i }) + '\n';

const write = (...lines: string[]) => writeFileSync(path, lines.join(''));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outside-header-'));
  mkdirSync(join(dir, 'projects', 'a-project'), { recursive: true });
  path = join(dir, 'projects', 'a-project', 'sess.jsonl');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('what a chat begun outside this app is running', () => {
  it('reads the mode it was last put in and the model that last answered', async () => {
    write(
      modeLine('default'),
      typed('u1'),
      reply('claude-sonnet-5', 'a1'),
      modeLine('bypassPermissions'),
      typed('u2'),
      reply('claude-opus-5', 'a2'),
    );

    expect(await runningIn(path)).toEqual({
      permissionMode: 'bypassPermissions',
      model: 'claude-opus-5',
    });
  });

  it('says nothing rather than guessing when the record says nothing', async () => {
    // A chat with turns in it and no mode line and no reply of its own. The
    // answer here is a blank line on the screen — never the owner's settings,
    // which describe this machine and not that terminal (bw-7ks.23).
    write(typed('u1'), noise(1), typed('u2'));

    expect(await runningIn(path)).toEqual({ permissionMode: null, model: null });
  });

  it('says nothing about a record that is not there at all', async () => {
    expect(await runningIn(join(dir, 'projects', 'a-project', 'nobody.jsonl'))).toEqual({
      permissionMode: null,
      model: null,
    });
  });

  it('takes the mode off a typed prompt too, when that is the last thing that says one', async () => {
    // The kit stamps the mode onto the prompts a person types as well as onto
    // its own lines. Both are the mode at that moment.
    write(modeLine('default'), reply('claude-opus-5', 'a1'), typed('u2', 'plan'));

    expect((await runningIn(path)).permissionMode).toBe('plan');
  });

  it('never reports a helper’s model as the chat’s own', async () => {
    // A chat's helpers answer on models of their own, on sidechain lines. The
    // chat is running opus whatever the helper it sent off is running.
    write(reply('claude-opus-5', 'a1'), reply('claude-haiku-4-5-20251001', 'h1', true));

    expect((await runningIn(path)).model).toBe('claude-opus-5');
  });

  it('never reports the kit’s own word for a message with no model behind it', async () => {
    // An interruption is written as an assistant line with `<synthetic>` where
    // the model goes — 391 of them across the manager's records.
    write(reply('claude-opus-5', 'a1'), reply('<synthetic>', 'a2'));

    expect((await runningIn(path)).model).toBe('claude-opus-5');
  });

  it('finds both in a record far longer than one look at its end', async () => {
    // The read starts small at the END and widens, because the answer is the
    // LAST thing said on each subject. A record whose mode was set once, a
    // hundred thousand bytes ago, still has to answer.
    const filler = Array.from({ length: 400 }, (_, i) => typed(`u${i}`) + noise(i)).join('');
    writeFileSync(
      path,
      modeLine('acceptEdits') + reply('claude-fable-5', 'a1') + filler,
    );

    expect(await runningIn(path)).toEqual({
      permissionMode: 'acceptEdits',
      model: 'claude-fable-5',
    });
  });

  it('reports a mode the terminal changes while it is being watched', async () => {
    write(modeLine('default'), reply('claude-opus-5', 'a1'));
    const tail = new RecordTail(path);
    await tail.toEnd();

    // Nothing has arrived, so nothing is claimed either way.
    expect((await tail.grown()).running).toEqual({ permissionMode: null, model: null });

    // The terminal is switched. That writes a mode line and no conversation at
    // all, and the screen still has to follow it.
    writeFileSync(
      path,
      modeLine('default') + reply('claude-opus-5', 'a1') + modeLine('bypassPermissions'),
    );
    const grown = await tail.grown();

    expect(grown.fresh).toEqual([]);
    expect(grown.running).toEqual({ permissionMode: 'bypassPermissions', model: null });
  });
});
