/**
 * @vitest-environment node
 *
 * Steering one agent the chat sent away (bw-7ks.22.5): ending that one, letting
 * it run on in the background, and the question it raised for itself arriving
 * with its own name on it.
 *
 * The three tiers of §8.2.7 are three different kinds of reach and only two of
 * them are direct. Stopping and parking go to the kit about that one piece of
 * work; a question it raised comes back through the kit's permission hook,
 * which names the CALL that asked and not the agent — so the row it belongs to
 * has to be worked out here, from the parentage every one of that helper's
 * words already carries.
 *
 * Held across the seam like its neighbours: the real driver reads the kit's
 * real messages and the real reducer folds them, so what is checked is what the
 * screen would be handed.
 */
import { describe, expect, it, vi } from 'vitest';

import { foldAll } from '../../../src/workbench/fold.ts';
import type { WbpEvent } from '../../../src/workbench/protocol.ts';
import { ClaudeDriver } from '../drivers/claude.ts';

/** The chat's own helper, sent off. The shapes are the kit's own. */
const SENT_OFF = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'afa98b872c4df37bc',
  tool_use_id: 'toolu_01SentItOff',
  description: 'Count the rows and report',
  subagent_type: 'general-purpose',
  task_type: 'local_agent',
};

/** The helper speaking, and reaching for a command of its own. */
const HELPER_REACHES = {
  type: 'assistant',
  parent_tool_use_id: SENT_OFF.tool_use_id,
  message: {
    id: 'msg_of_the_helper',
    model: 'claude-fable-5',
    content: [{ type: 'tool_use', id: 'toolu_theHelpersBash', name: 'Bash', input: { command: 'wc -l rows.csv' } }],
  },
};

/** The chat itself reaching for a command, which belongs to nobody but it. */
const CHAT_REACHES = {
  type: 'assistant',
  message: {
    id: 'msg_of_the_chat',
    model: 'claude-opus-5',
    content: [{ type: 'tool_use', id: 'toolu_theChatsBash', name: 'Bash', input: { command: 'ls' } }],
  },
};

/**
 * A driver reading the kit, with its emitted events collected.
 *
 * `emit` is the driver's own, reached past its privacy for the same reason its
 * neighbours do it: the alternative is `start()`, which launches a real agent
 * process.
 */
function reading(messages: Record<string, unknown>[]): { driver: ClaudeDriver; events: WbpEvent[] } {
  const events: WbpEvent[] = [];
  const driver = new ClaudeDriver();
  (driver as unknown as { emit: (e: Omit<WbpEvent, 'seq' | 'sessionId' | 'at'>) => void }).emit = (e) =>
    events.push({ ...e, seq: events.length, sessionId: 's1', at: '2026-08-20T12:00:00.000Z' } as WbpEvent);
  for (const m of messages) driver.draw(m);
  return { driver, events };
}

/** Whatever the kit would be asked, standing in for the session it runs. */
function kitThatAnswers(park: boolean): {
  stopTask: (id: string) => Promise<void>;
  backgroundTasks: (call?: string) => Promise<boolean>;
} {
  return { stopTask: vi.fn(async () => {}), backgroundTasks: vi.fn(async () => park) };
}

const asks = (events: WbpEvent[]): Extract<WbpEvent, { type: 'ask.permission' }>[] =>
  events.filter((e): e is Extract<WbpEvent, { type: 'ask.permission' }> => e.type === 'ask.permission');

/**
 * The states a row was told to read as. A progress report that names no state
 * is one carrying something else — the model, the numbers — and says nothing
 * about whether the row is working.
 */
const states = (events: WbpEvent[]): string[] =>
  events
    .filter((e) => e.type === 'agent.progress')
    .map((e) => (e as { state?: string }).state)
    .filter((s): s is string => s !== undefined);

describe('a question the agent raised for itself', () => {
  it('arrives naming the call that sent that agent off', () => {
    const { driver, events } = reading([SENT_OFF, HELPER_REACHES]);
    void driver.onPermissionRequest('Bash', { command: 'wc -l rows.csv' }, { toolUseID: 'toolu_theHelpersBash' });

    // Not the helper's own call: the call that SENT it, which is what every one
    // of its words is already stamped with, so the card lands where it belongs.
    expect(asks(events)[0]?.parentToolCallId).toBe('toolu_01SentItOff');
  });

  it('and the chat’s own question belongs to nobody', () => {
    const { driver, events } = reading([SENT_OFF, CHAT_REACHES]);
    void driver.onPermissionRequest('Bash', { command: 'ls' }, { toolUseID: 'toolu_theChatsBash' });

    expect(asks(events)[0]?.parentToolCallId).toBeUndefined();
    // And no row moved: nothing the reader can see was waiting on him.
    expect(states(events)).toEqual([]);
  });

  it('stops the row reading as working until it is answered', async () => {
    const { driver, events } = reading([SENT_OFF, HELPER_REACHES]);
    const answered = driver.onPermissionRequest('Bash', { command: 'wc -l rows.csv' }, { toolUseID: 'toolu_theHelpersBash' });

    expect(states(events)).toEqual(['waiting']);

    driver.answer(asks(events)[0]!.askId, 'allow_once');
    await answered;

    // Working again, and the row said so itself rather than waiting for the
    // kit's next report about it.
    expect(states(events)).toEqual(['waiting', 'running']);
  });

  it('names the brief in the conversation, so the card says who asked', () => {
    const { driver, events } = reading([SENT_OFF, HELPER_REACHES]);
    void driver.onPermissionRequest('Bash', { command: 'wc -l rows.csv' }, { toolUseID: 'toolu_theHelpersBash' });

    const ask = foldAll(events).items.find((i) => i.kind === 'ask');
    expect(ask).toMatchObject({ parentId: 'toolu_01SentItOff', askedBy: 'Count the rows and report' });
  });
});

describe('ending one, and letting one run on', () => {
  it('ends that one piece of work by its own name', async () => {
    const { driver } = reading([SENT_OFF]);
    const kit = kitThatAnswers(true);
    (driver as unknown as { q: unknown }).q = kit;

    await driver.stopAgent('afa98b872c4df37bc');

    // The row's id IS the task id, which is what the kit takes.
    expect(kit.stopTask).toHaveBeenCalledWith('afa98b872c4df37bc');
  });

  it('parks it by the call that started it, which is the other id', async () => {
    const { driver } = reading([SENT_OFF]);
    const kit = kitThatAnswers(true);
    (driver as unknown as { q: unknown }).q = kit;

    expect(await driver.parkAgent('afa98b872c4df37bc')).toBe(true);
    // Parking is asked about the tool_use block, not the task — the two ids are
    // different and handing over the wrong one parks the whole turn.
    expect(kit.backgroundTasks).toHaveBeenCalledWith('toolu_01SentItOff');
  });

  it('and says no, without asking, for a row this chat never called', async () => {
    // A helper the kit wrote no call for was already running in the background;
    // there is nothing to hand back.
    const { driver } = reading([{ ...SENT_OFF, tool_use_id: undefined }]);
    const kit = kitThatAnswers(true);
    (driver as unknown as { q: unknown }).q = kit;

    expect(await driver.parkAgent('afa98b872c4df37bc')).toBe(false);
    expect(kit.backgroundTasks).not.toHaveBeenCalled();
  });

  it('and a no is an answer about the work, so the row says it is already there', async () => {
    // The kit says no to one thing only: nothing of that name was in the
    // FOREGROUND. Which is not a failed click — it is the work telling us where
    // it already is, and a row that went on offering to park it would be
    // offering something that has happened (bw-7ks.22.24).
    const { driver, events } = reading([SENT_OFF]);
    (driver as unknown as { q: unknown }).q = kitThatAnswers(false);

    expect(await driver.parkAgent('afa98b872c4df37bc')).toBe(false);
    expect(states(events)).toEqual(['parked']);
  });

  it('and does not say it twice when the kit parks it', async () => {
    // The kit reports that one itself, and a row moved from both ends is a row
    // that reads parked before the kit agrees it is.
    const { driver, events } = reading([SENT_OFF]);
    (driver as unknown as { q: unknown }).q = kitThatAnswers(true);

    expect(await driver.parkAgent('afa98b872c4df37bc')).toBe(true);
    expect(states(events)).toEqual([]);
  });

  it('offers all three tiers, which is what the screen draws buttons from', () => {
    expect(new ClaudeDriver().agentControls()).toEqual(['stop', 'park', 'say']);
  });
});

/** The kit's own word that the work is over, whichever way it went. */
const ended = (status: string, summary: string) => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: 'afa98b872c4df37bc',
  status,
  summary,
  usage: { total_tokens: 12_000, tool_uses: 3, duration_ms: 45_000 },
});

/**
 * The receipt of the call that dispatched it, which comes back a moment later
 * carrying what the run cost. A stopped helper's call is still answered.
 */
const RECEIPT = {
  type: 'user',
  message: {
    content: [{ type: 'tool_result', tool_use_id: 'toolu_01SentItOff', is_error: false, content: 'Counted 412 rows' }],
  },
  tool_use_result: { totalTokens: 12_000, totalToolUseCount: 3, totalDurationMs: 45_000 },
};

const endings = (events: WbpEvent[]): { state: string; result: string | null }[] =>
  events
    .filter((e) => e.type === 'agent.finished')
    .map((e) => ({ state: (e as { state: string }).state, result: (e as { result: string | null }).result }));

const rowOf = (events: WbpEvent[]) => foldAll(events).agents.find((a) => a.id === 'afa98b872c4df37bc');

describe('a stop is the last word about that row', () => {
  it('and the receipt of the call it was sent by does not undo it', () => {
    // Two writers end the same row: the kit's notification about the work, and
    // the tool_result of the call that dispatched it. The second one comes back
    // clean whatever happened to the work, so reading it as an ending rewrites
    // what he did into a finish, with nothing on the screen to say otherwise
    // (bw-7ks.22.27).
    const { events } = reading([SENT_OFF, ended('killed', 'Stopped by you'), RECEIPT]);

    expect(endings(events)).toEqual([{ state: 'stopped', result: 'Stopped by you' }]);
    expect(rowOf(events)).toMatchObject({ state: 'stopped', result: 'Stopped by you' });
  });

  it('and neither does a later ending arriving from anywhere else', () => {
    const { events } = reading([SENT_OFF, ended('killed', 'Stopped by you')]);
    events.push({
      type: 'agent.finished',
      agentId: 'afa98b872c4df37bc',
      state: 'done',
      result: 'All 412 rows counted',
      seconds: 45,
      tokens: 12_000,
      calls: 3,
      model: null,
      seq: events.length,
      sessionId: 's1',
      at: '2026-08-20T12:00:00.000Z',
    } as WbpEvent);

    expect(rowOf(events)).toMatchObject({ state: 'stopped', result: 'Stopped by you' });
  });

  it('but an ordinary finish still lands, and carries what the run cost', () => {
    const { events } = reading([SENT_OFF, ended('completed', 'Counted them'), RECEIPT]);

    expect(rowOf(events)).toMatchObject({ state: 'done', seconds: 45, tokens: 12_000, calls: 3 });
  });
});

describe('and the row is told at once, not when the kit gets round to it', () => {
  it('reads stopped the moment the kit takes the stop', async () => {
    const { driver, events } = reading([SENT_OFF]);
    (driver as unknown as { q: unknown }).q = kitThatAnswers(true);

    await driver.stopAgent('afa98b872c4df37bc');

    expect(endings(events)).toEqual([{ state: 'stopped', result: null }]);
  });

  it('and a stop asked for after it finished does not un-finish it', async () => {
    const { driver, events } = reading([SENT_OFF, ended('completed', 'Counted them')]);
    (driver as unknown as { q: unknown }).q = kitThatAnswers(true);

    await driver.stopAgent('afa98b872c4df37bc');

    expect(states(events)).toEqual([]);
    expect(rowOf(events)).toMatchObject({ state: 'done' });
  });
});

/** A routine status ping about that work, of the kind the kit keeps sending. */
const status = (state: string, backgrounded?: boolean) => ({
  type: 'system',
  subtype: 'task_updated',
  task_id: 'afa98b872c4df37bc',
  patch: { status: state, ...(backgrounded === undefined ? {} : { is_backgrounded: backgrounded }) },
});

describe('and nothing that arrives afterwards reopens it', () => {
  it('a status saying it is running does not undo the stop', () => {
    // The kit goes on talking about a piece of work for a moment after it is
    // over. Everything that ENDS a row already refuses to be overruled; the
    // routine status pings did not, so one landing a beat after the stop put
    // the row back to running (bw-7ks.22.30).
    const { events } = reading([SENT_OFF, ended('killed', 'Stopped by you'), status('in_progress')]);

    expect(states(events), 'the row was told to read as running again').toEqual([]);
    expect(rowOf(events)).toMatchObject({ state: 'stopped', result: 'Stopped by you' });
  });

  it('nor does one saying it is running after it finished', () => {
    const { events } = reading([SENT_OFF, ended('completed', 'Counted them'), status('in_progress')]);

    expect(states(events), 'the row was told to read as running again').toEqual([]);
    expect(rowOf(events)).toMatchObject({ state: 'done', result: 'Counted them' });
  });

  it('and a row left in the background after it ended is not drawn as parked', () => {
    const { events } = reading([SENT_OFF, ended('completed', 'Counted them'), status('in_progress', true)]);

    expect(states(events), 'the row was told to read as parked after it ended').toEqual([]);
    expect(rowOf(events)).toMatchObject({ state: 'done' });
  });

  it('but a status about work still going on is drawn as it always was', () => {
    const { events } = reading([SENT_OFF, status('in_progress', true)]);

    expect(rowOf(events)).toMatchObject({ state: 'parked' });
  });

  it('returns a parked helper to running when the kit says in progress', () => {
    const { events } = reading([
      SENT_OFF,
      status('in_progress', true),
      status('in_progress', false),
    ]);

    expect(states(events)).toEqual(['parked', 'running']);
    expect(rowOf(events)).toMatchObject({ state: 'running' });
  });

  it.each([
    ['completed', 'done'],
    ['failed', 'failed'],
    ['killed', 'stopped'],
  ])('treats a terminal %s update as a finished helper even without a notification', (statusName, state) => {
    const { events } = reading([SENT_OFF, status(statusName)]);

    expect(endings(events)).toEqual([{ state, result: null }]);
    expect(rowOf(events)).toMatchObject({ state });
  });
});
