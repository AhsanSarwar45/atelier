/**
 * @vitest-environment node
 *
 * What a chat says about work it handed to something else, and whether the
 * reader has to turn anything on to read it (bw-7ks.22.6).
 *
 * Agent lifecycle is a categorized operation record, never assistant prose.
 * The helper panel and the spawn/wait command rows say who started, finished,
 * failed, or was waited on. These tests hold the other half of that contract:
 * Claude's parallel system notifications must not become ordinary notes even
 * when every machine-message filter is enabled. A service retry remains a note
 * because it is session status, not a projection of one helper lifecycle.
 *
 * It holds them across the seam rather than either side of it: the real driver reads the kit's real messages, the real reducer folds
 * them into a conversation, and the browser's real filter — with nothing
 * touched — is asked whether each line survives. Nothing here is stood in for,
 * because a stand-in on either side is exactly where the fault lived.
 *
 * A helper's own work is the one thing this chat says nothing about, and it is
 * checked here for the same reason: the driver stopped drawing it a row
 * (bw-7ks.22.18) and went on announcing it in the conversation, so the row was
 * honest and the sentence beside it was not.
 */
import { describe, expect, it } from 'vitest';

import { foldAll } from '../../../src/workbench/fold.ts';
import { EVERYTHING, QUIET, showing } from '../../../src/workbench/message-filter.ts';
import type { WbpEvent } from '../../../src/workbench/protocol.ts';
import { ClaudeDriver } from '../drivers/claude.ts';

/** The chat's own helper, sent off. Captured from a real run, 2026-08-20. */
const SENT_OFF = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'afa98b872c4df37bc',
  tool_use_id: 'toolu_01GDoyt2caPUwy8LmHwbcma1',
  description: 'Sleep 45 seconds then report',
  subagent_type: 'general-purpose',
  task_type: 'local_agent',
};

/** The three ways the kit says a piece of sent-off work is over. */
const ended = (task: string, status: string, summary: string) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: task,
  status,
  summary,
  usage: { total_tokens: 12_000, tool_uses: 3, duration_ms: 45_000 },
});

/** The service being ridden out, which happens to a helper like anything else. */
const RETRYING = {
  type: 'system',
  subtype: 'api_retry',
  attempt: 2,
  max_retries: 5,
  retry_delay_ms: 1000,
  error_status: 529,
};

/** A helper's own command: the same shape as the chat's own, one flag apart. */
const A_HELPER_S = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'br1aixx0b',
  owned_by_subagent: true,
  tool_use_id: 'toolu_01JHPyJ8qeiC7mtF6QMDRAe2',
  description: 'Sleep for 45 seconds in foreground',
  task_type: 'local_bash',
};

/**
 * The helper's own answer, arriving under the call that sent it off.
 *
 * Short answers are the norm — a helper told to report back reports back in a
 * word — and the line saying it came back quotes that word by design.
 */
const ANSWERED = {
  type: 'assistant',
  parent_tool_use_id: SENT_OFF.tool_use_id,
  message: { id: 'msg_of_the_helper', model: 'claude-opus-5', content: [{ type: 'text', text: 'DONE' }] },
};

/**
 * The conversation these messages make, as the reader has it before he touches
 * a switch.
 *
 * `emit` is the driver's own, reached past its privacy: the alternative is
 * `start()`, which launches a real agent process. Everything after it is the
 * shipping path — the sidecar stamps the three fields it adds here, the browser
 * folds, the browser filters.
 */
function linesOf(messages: Record<string, unknown>[], off: ReadonlySet<string>): string[] {
  const events: WbpEvent[] = [];
  const driver = new ClaudeDriver();
  (driver as unknown as { emit: (e: Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>) => void }).emit = (e) =>
    events.push({ ...e, seq: events.length, sessionId: 's1', at: '2026-08-20T12:00:00.000Z' } as WbpEvent);
  for (const m of messages) driver.draw(m);
  return showing(foldAll(events).items, off)
    .map((item) => (item.kind === 'note' ? item.text : ''))
    .filter(Boolean);
}

/** What is on his screen before he touches a switch. */
const readerSees = (messages: Record<string, unknown>[]): string[] => linesOf(messages, QUIET);

/** What the record holds, which is what the one switch gives him back. */
const everythingSaid = (messages: Record<string, unknown>[]): string[] => linesOf(messages, EVERYTHING);

describe('what a chat says about the work it sent away', () => {
  const FIVE = [
    SENT_OFF,
    RETRYING,
    ended('afa98b872c4df37bc', 'completed', 'Slept and reported'),
    ended('t-2', 'failed', 'Could not read the file'),
    ended('t-3', 'stopped', 'Given up on'),
  ];

  it('keeps lifecycle notifications out of prose while retaining session retries', () => {
    expect(everythingSaid(FIVE)).toEqual(['Retrying (2 of 5) after HTTP 529']);
  });

  it('shows the session retry without duplicating failed-agent lifecycle prose', () => {
    expect(readerSees(FIVE)).toEqual(['Retrying (2 of 5) after HTTP 529']);
  });

  it('says nothing at all about work a helper sent away', () => {
    // Not the going and not the coming home: the helper's own command is on the
    // helper's own conversation, where it is somebody's.
    expect(everythingSaid([A_HELPER_S, ended('br1aixx0b', 'completed', 'Slept')])).toEqual([]);
  });

  it('keeps a one-word helper result in its child chat and categorized row', () => {
    const said = everythingSaid([SENT_OFF, ANSWERED, ended('afa98b872c4df37bc', 'completed', 'DONE')]);
    expect(said).toEqual([]);
  });

  it('does not leak nested helper bookkeeping into the parent prose', () => {
    const said = everythingSaid([
      SENT_OFF,
      A_HELPER_S,
      ended('br1aixx0b', 'completed', 'Slept'),
      ended('afa98b872c4df37bc', 'completed', 'Slept and reported'),
    ]);
    expect(said).toEqual([]);
  });
});
