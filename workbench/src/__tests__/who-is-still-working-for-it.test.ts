/**
 * @vitest-environment node
 *
 * Who is still working for a chat whose own turn has ended (bw-jaoz.14.7).
 *
 * The one thing a chat's own record cannot say. A helper is sent off, the call
 * comes back — 1,344 of the 1,445 dispatches on this machine inside two
 * seconds — and the chat's record then says nothing at all for the whole of the
 * work. So a chat with three agents grinding on its behalf read as a chat
 * nobody had touched in twenty minutes, and drew Idle.
 *
 * The answer is in the helpers' own files, and it takes both of the guards
 * below: a file's last line says whether its work was finished, and its
 * modified time catches the 129 of 1,645 records here that end mid-work because
 * the session they belonged to was killed under them.
 *
 * The two lines are real, off this disk (kit 2.1.216 and 2.1.218), the whole
 * line in each case.
 */
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HELPER_QUIET_MS, helpersWorking } from '../helper-records.ts';

/** A helper's last line with a command out: work asked for and not yet answered. */
const MID_WORK = String.raw`{"parentUuid":"25597248-739b-4009-98da-f416fb160d41","isSidechain":true,"agentId":"ab9bbaa0dac96ed1a","message":{"model":"claude-sonnet-5","id":"msg_011CdKXje47QXfe3vdJSuqjU","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01Xvn7yMks22EkVgyFodinQX","name":"Bash","input":{"command":"scripts/cargo-lim cargo test -p corsetta-core baked_shadow 2>&1 | tail -80","timeout":600000},"caller":{"type":"direct"}}],"stop_reason":"tool_use","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":20317,"cache_read_input_tokens":7917,"output_tokens":139,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":20317},"inference_geo":"not_available","iterations":[{"input_tokens":2,"output_tokens":139,"cache_read_input_tokens":7917,"cache_creation_input_tokens":20317,"cache_creation":{"ephemeral_5m_input_tokens":20317,"ephemeral_1h_input_tokens":0},"type":"message"}],"speed":"standard"},"diagnostics":null},"requestId":"req_011CdKXjckyfVwBheJQ7GPzJ","attributionAgent":"verify-render","type":"assistant","uuid":"bc0d3e6d-499a-449e-86db-58d262e9610b","timestamp":"2026-07-23T19:20:16.846Z","effort":"high","userType":"external","entrypoint":"cli","cwd":"/home/ahsan/dev/corsetta","sessionId":"228e0b79-bc3b-46c7-bb55-5f0705cf5909","version":"2.1.218","gitBranch":"main"}`;

/** A helper's last line with its answer on it: the 1,516-in-1,645 ordinary end. */
const FINISHED = String.raw`{"parentUuid":"62e67ddb-797b-4aeb-b0df-6d0041fce46d","isSidechain":true,"agentId":"aebf6ced0a6e2c038","message":{"model":"claude-sonnet-5","id":"msg_011CdFCgu8Qskm5CChFcsHME","type":"message","role":"assistant","content":[{"type":"text","text":"Build 2 passed.\n\n- ${'`'}cargo build -p corsetta-app --features debug-harness${'`'}: PASS\n- ${'`'}cargo build --release -p corsetta-core --example dump_cloud_shadow${'`'}: PASS"}],"stop_reason":"end_turn","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":842,"cache_read_input_tokens":29321,"output_tokens":71,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":842},"inference_geo":"not_available","iterations":[{"input_tokens":2,"output_tokens":71,"cache_read_input_tokens":29321,"cache_creation_input_tokens":842,"cache_creation":{"ephemeral_5m_input_tokens":842,"ephemeral_1h_input_tokens":0},"type":"message"}],"speed":"standard"},"diagnostics":null},"requestId":"req_011CdFCgsuF2Q3qWjaU6BjJ7","attributionAgent":"verify-render","type":"assistant","uuid":"d2ba8423-944a-417f-924d-4cbc59c6754c","timestamp":"2026-07-21T12:28:06.813Z","effort":"high","userType":"external","entrypoint":"cli","cwd":"/home/ahsan/dev/corsetta","sessionId":"b7280f77-eb99-4071-b80d-7bc02f97ad77","version":"2.1.216","gitBranch":"main"}`;

const now = Date.now();

/** How each helper's file is left: what its last line is, and how long ago it moved. */
interface Left {
  last: string;
  quietMs?: number;
}

/** A chat's record on disk, with the helpers it sent off filed beside it. */
function chatWithHelpers(helpers: Record<string, Left>): string {
  const home = mkdtempSync(join(tmpdir(), 'helpers-working-'));
  const record = join(home, 'a-chat.jsonl');
  writeFileSync(record, '');
  const names = Object.keys(helpers);
  if (names.length === 0) return record;
  const dir = join(home, 'a-chat', 'subagents');
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const { last, quietMs = 0 } = helpers[name]!;
    const file = join(dir, `agent-${name}.jsonl`);
    writeFileSync(file, `${last}\n`);
    // The kit writes this beside every one of them, and it is not a record.
    writeFileSync(join(dir, `agent-${name}.meta.json`), JSON.stringify({ agentType: 'scout' }));
    if (quietMs > 0) {
      const at = (now - quietMs) / 1000;
      utimesSync(file, at, at);
    }
  }
  return record;
}

/** Where a helper's own file is, so a test can ask the disk about it too. */
const fileOf = (record: string, name: string): string =>
  join(record.replace(/\.jsonl$/, ''), 'subagents', `agent-${name}.jsonl`);

describe('the helpers a chat still has out', () => {
  it('counts the one with work outstanding and not the one that answered', () => {
    const record = chatWithHelpers({ a1: { last: MID_WORK }, a2: { last: FINISHED } });
    expect(helpersWorking(record, now).out).toBe(1);
  });

  it('is when the earliest of them went off, which is when its file was made', () => {
    const record = chatWithHelpers({ a1: { last: MID_WORK }, a2: { last: MID_WORK } });
    const answer = helpersWorking(record, now);
    expect(answer.out).toBe(2);
    // Both are working, so the clock the chat shows is the older one's: the
    // seconds a reader sees are the seconds the whole wait has taken, not the
    // seconds since the last of them started.
    const later = statSync(fileOf(record, 'a2')).birthtimeMs;
    if (Number.isFinite(later) && later > 0) {
      expect(answer.since).not.toBeNull();
      expect(answer.since!).toBeLessThanOrEqual(later);
    }
  });

  it('lets a killed helper’s ghost go quiet rather than work for ever', () => {
    // Its last line asks for a tool that will never answer, because the session
    // it belonged to was killed mid-call. 129 files on this machine end that
    // way, and without the bound each one of them is a chat stuck on "Helper
    // working" until somebody deletes the file.
    const record = chatWithHelpers({ a1: { last: MID_WORK, quietMs: HELPER_QUIET_MS + 5_000 } });
    expect(helpersWorking(record, now)).toEqual({ out: 0, since: null });
  });

  it('counts one still inside the bound, where the real pauses are', () => {
    // A minute of silence is an ordinary long tool call: over 203,342 gaps
    // between one line of a helper and its next, the 99th is 62 seconds.
    const record = chatWithHelpers({ a1: { last: MID_WORK, quietMs: 60_000 } });
    expect(helpersWorking(record, now).out).toBe(1);
  });

  it('says nothing is out for a chat that never sent anything off', () => {
    // No directory at all, which is most chats, and the cost of asking must be
    // one failed listing — it is asked of every chat on every beat.
    expect(helpersWorking(chatWithHelpers({}), now)).toEqual({ out: 0, since: null });
  });
});
