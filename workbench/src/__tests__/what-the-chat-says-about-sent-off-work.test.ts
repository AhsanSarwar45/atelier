/**
 * @vitest-environment node
 *
 * What a chat says about work it handed to something else, and whether the
 * reader has to turn anything on to read it (bw-7ks.22.6).
 *
 * The panel is a reading of the work; these lines are the record of it, sitting
 * where it happened in the conversation. Both, never one instead of the other:
 * the panel says three helpers are running, and only the conversation says the
 * second one went off between the two commands the reader is looking at.
 *
 * Which is worth nothing if the lines are not IN the record, and both ways of
 * losing them are held here: "Sent off" was dropped from the conversation
 * outright, so a chat that delegated its whole turn read as a chat that fell
 * silent; and the line saying one came back was dropped as a repeat of the
 * helper's own answer, which it quotes on purpose, so the panel said finished
 * and the conversation never said it came home.
 *
 * Being in the record and being on his screen are two different questions, and
 * this file asks both. An agent going and coming home is drawn on the panel —
 * what it is, what it is doing, what it spent — so repeating it in the chat
 * says the same thing twice: those lines are the machine's own and start
 * switched off, and only one that FAILED speaks unasked. That is the manager's
 * ruling of 2026-08-20 (bw-6jq5). Every one of them is still one switch away,
 * which is what `everythingSaid` holds.
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

  it('holds all five in the record, in the order they happened', () => {
    // Sent off, retrying, finished, failed, given up — in that order, because
    // the record is the conversation and the conversation is in time.
    expect(everythingSaid(FIVE)).toEqual([
      'Sent off: Sleep 45 seconds then report',
      'Retrying (2 of 5) after HTTP 529',
      // The line names the agent and then says, in English, what became of it.
      // It used to end in the kit's own word in brackets — "(completed)" — which
      // reads as English only for as long as the kit's words happen to be
      // English (bw-iiv6).
      'Sleep 45 seconds then report finished: Slept and reported',
      // These two are other agents, whose going off this chat never heard.
      'A sent-off agent failed: Could not read the file',
      'A sent-off agent was stopped: Given up on',
    ]);
  });

  it('draws only the two he can act on before he touches a switch', () => {
    // The service being ridden out is why his chat is sitting there, and the
    // helper that failed is work he asked for that did not happen. An agent
    // leaving, arriving home fine, or being given up on is the panel's news.
    expect(readerSees(FIVE)).toEqual([
      'Retrying (2 of 5) after HTTP 529',
      'A sent-off agent failed: Could not read the file',
    ]);
  });

  it('says nothing at all about work a helper sent away', () => {
    // Not the going and not the coming home: the helper's own command is on the
    // helper's own conversation, where it is somebody's.
    expect(everythingSaid([A_HELPER_S, ended('br1aixx0b', 'completed', 'Slept')])).toEqual([]);
  });

  it('says one came back even when its whole answer was one word', () => {
    // The chat skips a quiet line a line just before it already said, which is
    // for the kit saying one thing in two shapes. A helper is a second voice,
    // not a second shape: kept in the same breath, "DONE" from the helper ate
    // "DONE (completed)" from the chat, and the panel said finished while the
    // conversation never said it came home.
    const said = everythingSaid([SENT_OFF, ANSWERED, ended('afa98b872c4df37bc', 'completed', 'DONE')]);
    expect(said).toEqual(['Sent off: Sleep 45 seconds then report', 'Sleep 45 seconds then report finished: DONE']);
  });

  it('and still says the chat’s own, with a helper’s work in among it', () => {
    const said = everythingSaid([
      SENT_OFF,
      A_HELPER_S,
      ended('br1aixx0b', 'completed', 'Slept'),
      ended('afa98b872c4df37bc', 'completed', 'Slept and reported'),
    ]);
    expect(said).toEqual([
      'Sent off: Sleep 45 seconds then report',
      'Sleep 45 seconds then report finished: Slept and reported',
    ]);
  });
});
