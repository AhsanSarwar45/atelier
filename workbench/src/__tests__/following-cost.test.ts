/**
 * @vitest-environment node
 *
 * What watching one chat costs while somebody else works in it.
 *
 * Every beat that found the record moved used to read the whole file and take
 * it apart again — 158 megabytes and 475ms on the manager's longest
 * conversation, every 1.5 seconds, on the one thread the sidecar answers every
 * other request from. Nothing older can change: the kit only ever appends. So
 * what is counted here is bytes, not seconds — a record that grew by two lines
 * costs two lines to follow, whatever it already held (bw-uiyz.6).
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findRecord, recordSize, RecordTail } from '../record-tail.ts';

let dir: string;
let path: string;

/** One line of a record, in the shape the kit writes it. */
function line(what: 'user' | 'assistant', text: string, uuid: string): string {
  return (
    JSON.stringify({
      type: what,
      uuid,
      sessionId: 'sess',
      message: { role: what, content: [{ type: 'text', text }] },
    }) + '\n'
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'following-cost-'));
  // Laid out the way the kit lays it out: one folder per project, the chat's
  // record named after the chat.
  mkdirSync(join(dir, 'projects', 'a-project'), { recursive: true });
  path = join(dir, 'projects', 'a-project', 'sess.jsonl');
  // A record with a past in it: the whole point is that this is never read.
  writeFileSync(path, Array.from({ length: 500 }, (_, i) => line('user', `old ${i}`, `old-${i}`)).join(''));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('following a chat somebody else is driving', () => {
  it('a record that grows twice is read from the end both times and never from the start', async () => {
    const tail = new RecordTail(path);
    await tail.toEnd();
    const past = recordSize('sess', dir) ?? 0;
    expect(past).toBeGreaterThan(10_000);

    const first = line('assistant', 'the first new thing', 'new-1');
    appendFileSync(path, first);
    const one = await tail.grown();
    expect(one.read).toBe(Buffer.byteLength(first));
    expect(one.fresh.map((l) => l.uuid)).toEqual(['new-1']);

    const second = line('user', 'and the second', 'new-2') + line('assistant', 'answered', 'new-3');
    appendFileSync(path, second);
    const two = await tail.grown();
    expect(two.read).toBe(Buffer.byteLength(second));
    expect(two.fresh.map((l) => l.uuid)).toEqual(['new-2', 'new-3']);

    // Both looks together cost less than one line of the past they never read.
    expect(one.read + two.read).toBeLessThan(past / 100);
  });

  it('a beat that finds nothing new reads nothing at all', async () => {
    const tail = new RecordTail(path);
    await tail.toEnd();
    const quiet = await tail.grown();
    // `running` is what the record says the chat is in and on; a beat that read
    // nothing has read nothing on either subject either (bw-ja9l.2).
    expect(quiet).toEqual({
      fresh: [],
      rewritten: false,
      read: 0,
      running: { permissionMode: null, model: null, effort: null },
    });
  });

  it('carries on from a byte another reader stopped at', async () => {
    const upto = recordSize('sess', dir) ?? 0;
    appendFileSync(path, line('assistant', 'after the reading', 'new-1'));
    const tail = new RecordTail(path);
    tail.seek(upto);
    const grown = await tail.grown();
    expect(grown.fresh.map((l) => l.uuid)).toEqual(['new-1']);
    expect(grown.read).toBeLessThan(500);
  });

  it('a line caught half-written is read whole on the next look', async () => {
    const tail = new RecordTail(path);
    await tail.toEnd();
    const whole = line('assistant', 'written in two pieces', 'new-1');
    const half = whole.slice(0, 30);
    appendFileSync(path, half);
    expect((await tail.grown()).fresh).toEqual([]);
    appendFileSync(path, whole.slice(30));
    expect((await tail.grown()).fresh.map((l) => l.uuid)).toEqual(['new-1']);
  });

  it('a record rewritten shorter says so rather than replaying its opening', async () => {
    const tail = new RecordTail(path);
    await tail.toEnd();
    truncateSync(path, 200);
    const grown = await tail.grown();
    expect(grown.rewritten).toBe(true);
    expect(grown.fresh).toEqual([]);
    expect(grown.read).toBe(0);
  });

  it('the kit\'s own bookkeeping and other agents\' turns are not the conversation', async () => {
    const tail = new RecordTail(path);
    await tail.toEnd();
    appendFileSync(
      path,
      JSON.stringify({ type: 'summary', summary: 'a title the kit made up' }) +
        '\n' +
        JSON.stringify({ type: 'assistant', uuid: 'side-1', isSidechain: true, message: {} }) +
        '\n' +
        JSON.stringify({ type: 'user', uuid: 'meta-1', isMeta: true, message: {} }) +
        '\n' +
        'not json at all\n' +
        line('assistant', 'the only real one', 'new-1'),
    );
    expect((await tail.grown()).fresh.map((l) => l.uuid)).toEqual(['new-1']);
  });

  it('finds a chat\'s record without being told where the kit keeps it', () => {
    expect(findRecord('sess', dir)).toBe(path);
    expect(findRecord('nobody', dir)).toBe(null);
  });
});

/**
 * The byte a later open carries on from.
 *
 * `position` is how far the reader has READ, and a look that caught a line
 * half-written holds the rest of it in hand rather than in the file — so
 * remembering that byte across opens would start the next reader inside a line
 * and lose it. What is remembered is the byte after the last whole line
 * (bw-uiyz.19).
 */
describe('where a chat has been read up to, between opens', () => {
  it('stops before a line that is still being written, and the next open reads it whole', async () => {
    const tail = new RecordTail(path);
    await tail.toEnd();

    const whole = line('assistant', 'a finished thing', 'new-1');
    const half = line('assistant', 'still being written', 'new-2').slice(0, 30);
    appendFileSync(path, whole + half);
    const first = await tail.grown();
    expect(first.fresh.map((l) => l.uuid)).toEqual(['new-1']);
    // Read past the half line, but only settled before it.
    expect(tail.position).toBeGreaterThan(tail.throughLine);
    expect(tail.throughLine).toBe(tail.position - Buffer.byteLength(half));

    // The rest of that line lands, and a reader starting where the last one
    // settled gets it whole and gets nothing it has already had.
    appendFileSync(path, line('assistant', 'still being written', 'new-2').slice(30));
    const next = new RecordTail(path);
    next.seek(tail.throughLine);
    const second = await next.grown();
    expect(second.fresh.map((l) => l.uuid)).toEqual(['new-2']);
  });

  it('is the whole file once everything in it has been taken in', async () => {
    const tail = new RecordTail(path);
    tail.seek(0);
    await tail.grown();
    expect(tail.throughLine).toBe(recordSize('sess', dir));
  });
});
