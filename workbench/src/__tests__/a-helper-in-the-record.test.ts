/**
 * @vitest-environment node
 *
 * The agents a chat sent off, found in the record after everyone has gone home
 * (bw-7ks.22.7).
 *
 * A helper's turns are in none of the files this app used to open. The kit
 * keeps the chat's own record — where a helper appears as one call and one
 * answer — and writes the helper's whole conversation into a file of its own
 * beside it, with a second file naming the call that sent it off. So a chat
 * read back from disk had no agents at all: an empty panel, nothing to open,
 * and a card that only a helper ever touched on no chat anywhere.
 *
 * The shapes here are the kit's own, taken from a record on this machine
 * (2026-08-20, kit 2.1.237).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { helpersOf } from '../helper-records.ts';

/** What one call cost: 100 + 1000 + 500 + 400, every part of it counted. */
const SPENT = {
  input_tokens: 100,
  cache_creation_input_tokens: 1000,
  cache_read_input_tokens: 500,
  output_tokens: 400,
};

/** One helper's own record: the brief, a call it made, and its answer. */
const TURNS = [
  {
    parentUuid: null,
    isSidechain: true,
    agentId: 'a1',
    type: 'user',
    timestamp: '2026-08-20T12:00:00.000Z',
    message: { role: 'user', content: 'Count the rows and report' },
  },
  {
    isSidechain: true,
    agentId: 'a1',
    type: 'assistant',
    timestamp: '2026-08-20T12:00:20.000Z',
    message: {
      model: 'claude-fable-5',
      role: 'assistant',
      usage: SPENT,
      content: [{ type: 'tool_use', id: 'toolu_inside', name: 'Bash', input: { command: 'wc -l rows.csv' } }],
    },
  },
  {
    isSidechain: true,
    agentId: 'a1',
    type: 'user',
    timestamp: '2026-08-20T12:00:30.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_inside', content: '412 rows.csv' }],
    },
  },
  {
    isSidechain: true,
    agentId: 'a1',
    type: 'assistant',
    timestamp: '2026-08-20T12:00:45.000Z',
    message: {
      model: 'claude-fable-5',
      role: 'assistant',
      usage: SPENT,
      content: [{ type: 'text', text: '412 rows.' }],
    },
  },
];

/** The kit's second file: what the work was and which call sent it off. */
const META = {
  agentType: 'general-purpose',
  description: 'Count the rows and report',
  toolUseId: 'toolu_01SentItOff',
  spawnDepth: 1,
};

/** A chat's record on disk, with whatever helpers it sent off beside it. */
function chatOnDisk(helpers: Record<string, { turns?: unknown[]; meta?: unknown }>): string {
  const home = mkdtempSync(join(tmpdir(), 'helper-records-'));
  const record = join(home, 'a-chat.jsonl');
  writeFileSync(record, '');
  const names = Object.keys(helpers);
  if (names.length === 0) return record;
  const dir = join(home, 'a-chat', 'subagents');
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const helper = helpers[name]!;
    writeFileSync(join(dir, `agent-${name}.jsonl`), (helper.turns ?? []).map((l) => JSON.stringify(l)).join('\n'));
    if (helper.meta !== undefined) {
      writeFileSync(join(dir, `agent-${name}.meta.json`), JSON.stringify(helper.meta));
    }
  }
  return record;
}

describe('the agents a chat sent off, read back from the record', () => {
  it('finds one beside the chat, with its row and its conversation', () => {
    const [helper] = helpersOf(chatOnDisk({ a1: { turns: TURNS, meta: META } }));

    expect(helper).toBeDefined();
    // The row: what it was, which call sent it, what it ran on.
    expect(helper!.agentId).toBe('a1');
    expect(helper!.toolCallId).toBe('toolu_01SentItOff');
    expect(helper!.agentType).toBe('general-purpose');
    expect(helper!.what).toBe('Count the rows and report');
    expect(helper!.model).toBe('claude-fable-5');
    // Its numbers, which the kit states nowhere once the run is over: the
    // clock is its own first and last line, the spend is every call added up —
    // both of them twice here — and a call is a call it made itself.
    expect(helper!.seconds).toBe(45);
    expect(helper!.tokens).toBe(4000);
    expect(helper!.calls).toBe(1);
    expect(helper!.result).toBe('412 rows.');
    // Its conversation, in the order it happened: the brief it was given, the
    // command it ran with what that printed, and the answer it came back with.
    expect(helper!.entries).toEqual([
      { kind: 'said', role: 'user', text: 'Count the rows and report', images: [] },
      { kind: 'call', id: 'toolu_inside', name: 'Bash', input: { command: 'wc -l rows.csv' }, output: '412 rows.csv', ok: true },
      { kind: 'said', role: 'assistant', text: '412 rows.', images: [] },
    ]);
  });

  it('says a chat that sent nothing off sent nothing off', () => {
    expect(helpersOf(chatOnDisk({}))).toEqual([]);
  });

  it('still draws one the kit wrote no second file for', () => {
    // No meta is no call to hang it off, which is a row without a place in the
    // conversation rather than no row: it ran, and it spent what it spent.
    const [helper] = helpersOf(chatOnDisk({ a1: { turns: TURNS } }));
    expect(helper!.toolCallId).toBeNull();
    expect(helper!.what).toBe('');
    expect(helper!.tokens).toBe(4000);
  });

  it('lists them in the order they went off', () => {
    const later = TURNS.map((line) => ({ ...line, agentId: 'a2', timestamp: '2026-08-20T13:00:00.000Z' }));
    const found = helpersOf(chatOnDisk({ a2: { turns: later, meta: META }, a1: { turns: TURNS, meta: META } }));
    expect(found.map((h) => h.agentId)).toEqual(['a1', 'a2']);
  });
});
