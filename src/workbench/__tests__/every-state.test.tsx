/**
 * Every state a chat can be in, against every place it is drawn.
 *
 * The manager's ask, 2026-08-21: "make sure that under every permutation, the
 * status is shown correctly everywhere. that the badge and the message in chat
 * for in progress operations show correctly in all circumstance." So the cases
 * below are the cells of that grid rather than a list of functions — who holds
 * the chat, what it is doing, and for each cell the three things the reader
 * sees at once: the mark on the row, the badge beside it, and the line at the
 * foot of the chat.
 *
 * The grid is:
 *
 * - **held by** — nobody (a chat of ours), a terminal, another program.
 * - **doing** — each of our own driver's ten states; and for a held chat, what
 *   its holder says and what the end of its record says.
 * - **drawn on** — the mark (chat-state.ts, drawn by chat-state-chip.tsx on the
 *   list, in the bar and on a board card), the badge beside it, the line under
 *   the last message (working-line.ts), and the line where the writing box
 *   would be (heldLine).
 *
 * The shapes a record's end can take are ground rather than invention: they
 * were counted over every record on this machine and set against the kit's own
 * reader, and the table of them is docs/agent-workbench.md §6.3.5 (bw-96is.27).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RECORD_QUIET_MS,
  answerOwed,
  chatState,
  heldDoing,
  heldLine,
  holderOnly,
  type ChatState,
  type HeldChat,
} from '@/workbench/chat-state';
import { ChatStateChip, ExternalBadge } from '@/workbench/chat-state-chip';
import { withLive } from '@/workbench/chat-sidebar';
import { liveState, type LiveSession } from '@/workbench/live';
import type { RestoreRow, SessionState } from '@/workbench/protocol';
import { workingLine } from '@/workbench/working-line';

afterEach(cleanup);

const NOW = 1_787_138_400_000;
/** When the turn on screen began, for every cell that counts seconds. */
const BEGAN = NOW - 42_000;

function held(over: Partial<HeldChat> = {}): HeldChat {
  return { id: 'ef56704b', holder: 'terminal', doing: 'working', since: BEGAN, ...over };
}

/** What the row and the bar draw: the chip, or nothing at all. */
function mark(state: ChatState): { word: string | null; moving: boolean } {
  render(<ChatStateChip state={state} testId="cell" />);
  const chip = screen.queryByTestId('cell');
  if (!chip) return { word: null, moving: false };
  return { word: chip.getAttribute('data-word'), moving: chip.getAttribute('data-working') === 'yes' };
}

/** What the body draws under the last message, in the words of whoever owes it. */
function body(state: ChatState, over: Partial<Parameters<typeof workingLine>[0]> = {}) {
  return workingLine({
    busy: false,
    label: '',
    since: null,
    waiting: false,
    thought: 0,
    state,
    running: null,
    ...over,
  });
}

/** A user line, the way the kit writes one. */
function person(content: unknown, over: Record<string, unknown> = {}) {
  return { type: 'user', message: { role: 'user', content }, ...over };
}

/** An assistant line, the way the kit writes one. */
function agent(content: unknown[]) {
  return { type: 'assistant', message: { role: 'assistant', content } };
}

// ---------------------------------------------------------------------------
// Nobody else holds it: a chat of ours, in each of its ten states.
// ---------------------------------------------------------------------------

describe('a chat of ours, nobody else in it', () => {
  const cells: Array<[SessionState, string, boolean, boolean]> = [
    // state, word, mark moves, counts seconds
    ['starting', 'Coming back', true, true],
    ['thinking', 'Thinking', true, true],
    ['streaming', 'Answering', true, true],
    ['running_tool', 'Working', true, true],
    ['waiting_permission', 'Waiting for you', false, true],
    ['idle', 'Ready', false, false],
    ['stopped', 'Stopped', false, false],
    ['errored', 'Failed', false, false],
    ['ended', 'Ended', false, false],
    ['dormant', 'Asleep', false, false],
  ];

  for (const [state, word, moving, counts] of cells) {
    it(`${state}: the mark says "${word}"${moving ? ' and moves' : ''}, and no badge`, () => {
      const read = chatState({ state, since: BEGAN });
      expect(read.word).toBe(word);
      expect(read.working).toBe(moving);
      expect(read.external).toBeNull();
      expect(read.since).toBe(counts ? BEGAN : null);
      expect(mark(read)).toEqual({ word, moving });
    });
  }

  it('thinking: the driver\'s own word beats the state\'s, on the row as in the bar', () => {
    const read = chatState({ state: 'thinking', label: 'Pulling the branch apart', since: BEGAN });
    expect(read.word).toBe('Pulling the branch apart');
    expect(mark(read).word).toBe('Pulling the branch apart');
  });

  it('running_tool: the body draws the driver\'s line while the turn is in flight', () => {
    const read = chatState({ state: 'running_tool', label: 'Reading', since: BEGAN });
    expect(body(read, { busy: true, label: 'Reading', since: BEGAN })).toEqual({
      label: 'Reading',
      since: BEGAN,
      reported: 0,
      waiting: false,
      thought: 0,
    });
  });

  it('waiting_permission: the body draws the waiting mark, not the working one', () => {
    const read = chatState({ state: 'waiting_permission', since: BEGAN });
    const line = body(read, { busy: true, label: 'Waiting for you', since: BEGAN, waiting: true });
    expect(line?.waiting).toBe(true);
  });

  it('idle: nothing is drawn under the last message', () => {
    expect(body(chatState({ state: 'idle' }))).toBeNull();
  });

  it('a chat that ended: it says Ended and the body is still', () => {
    const read = chatState({ state: 'ended' });
    expect(read.word).toBe('Ended');
    expect(read.working).toBe(false);
    expect(body(read)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Somebody else holds it: the two kinds of holder against the three things
// they can be doing.
// ---------------------------------------------------------------------------

describe('the mark beside the word', () => {
  const EVERY: SessionState[] = [
    'starting',
    'idle',
    'thinking',
    'streaming',
    'running_tool',
    'waiting_permission',
    'stopped',
    'errored',
    'ended',
    'dormant',
  ];

  it('stands beside every state and not only the two that move', () => {
    // A chat at rest was a bare word in a pill, on a line where every chip
    // beside it carries a mark. And "Stopped", "Failed" and "Ended" all looked
    // alike until they were read (bw-ja9l.12).
    const seen = new Set<string>();
    for (const state of EVERY) {
      const read = chatState({ state, since: BEGAN });
      render(<ChatStateChip state={read} testId="cell" />);
      const drawn = screen.getByTestId('cell').querySelector('[data-mark]');
      expect(drawn, `${state} draws a mark`).not.toBeNull();
      expect(drawn?.getAttribute('data-mark'), `${state} names it`).toBe(read.mark);
      seen.add(drawn?.getAttribute('class') ?? '');
      cleanup();
    }

    // Ten states, but not ten marks: the four that are working share one, which
    // is the point of the mark — the standing, not the verb.
    expect(seen.size, 'a state at rest is told from a state that failed').toBeGreaterThan(4);
  });

  it('is the only thing that moves, and only while something is happening', () => {
    const moving = (state: SessionState): boolean => {
      render(<ChatStateChip state={chatState({ state, since: BEGAN })} testId="cell" />);
      const drawn = screen.getByTestId('cell').querySelector('[data-mark]');
      const cls = drawn?.getAttribute('class') ?? '';
      cleanup();
      return /animate-/.test(cls);
    };

    expect(moving('running_tool'), 'a chat mid-turn must not look still').toBe(true);
    expect(moving('waiting_permission'), 'nor one asking him something').toBe(true);
    expect(moving('idle'), 'a chat at rest must not twitch').toBe(false);
    expect(moving('errored')).toBe(false);
    expect(moving('dormant')).toBe(false);
  });
});

describe('a chat somebody else holds', () => {
  for (const holder of ['terminal', 'program'] as const) {
    it(`${holder}, working: the mark says Working and counts, and the badge stands beside it`, () => {
      const read = chatState({ state: 'dormant', held: held({ holder, doing: 'working' }) });
      expect(read).toEqual({
        working: true,
        waiting: false,
        word: 'Working',
        mark: 'working',
        since: BEGAN,
        external: { holder },
      });
      expect(mark(read)).toEqual({ word: 'Working', moving: true });
    });

    it(`${holder}, idle: the mark says Idle and counts nothing, and the badge stays`, () => {
      const read = chatState({ state: 'dormant', held: held({ holder, doing: 'idle', since: null }) });
      expect(read.word).toBe('Idle');
      expect(read.working).toBe(false);
      expect(read.since).toBeNull();
      expect(read.external).toEqual({ holder });
      expect(mark(read)).toEqual({ word: 'Idle', moving: false });
    });

    it(`${holder}, nothing known: no mark at all, and the badge is the whole claim`, () => {
      const read = chatState({ state: 'dormant', held: held({ holder, doing: 'unknown', since: null }) });
      expect(read.word).toBe('');
      expect(read.working).toBe(false);
      expect(read.external).toEqual({ holder });
      // The chip draws nothing rather than an empty pill.
      expect(mark(read).word).toBeNull();
      render(<ExternalBadge holder={holder} />);
      expect(screen.getByTestId('chat-external').getAttribute('data-holder')).toBe(holder);
    });
  }

  it('held beats our own asleep: a terminal mid-turn is never drawn Asleep', () => {
    const read = chatState({ state: 'dormant', held: held({ doing: 'working' }) });
    expect(read.word).toBe('Working');
  });

  it('held and working: the body draws the holder\'s turn, and never the waiting mark', () => {
    const read = chatState({ state: 'dormant', held: held({ doing: 'working' }) });
    const line = body(read);
    expect(line).toEqual({ label: 'Working', since: BEGAN, reported: 0, waiting: false, thought: 0 });
  });

  it('held and working a command: the body names the command they are running', () => {
    const read = chatState({ state: 'dormant', held: held({ doing: 'working' }) });
    expect(body(read, { running: { title: 'rg --files', seconds: 7 } })).toEqual({
      label: 'rg --files',
      since: BEGAN,
      reported: 7,
      waiting: false,
      thought: 0,
    });
  });

  it('held and idle: the body draws nothing at all', () => {
    expect(body(chatState({ state: 'dormant', held: held({ doing: 'idle', since: null }) }))).toBeNull();
  });

  it('held: the line where the box would be says who has it, and adds working only when it is', () => {
    const busy = chatState({ state: 'dormant', held: held({ holder: 'terminal', doing: 'working' }) });
    const quiet = chatState({ state: 'dormant', held: held({ holder: 'terminal', doing: 'idle', since: null }) });
    expect(heldLine(busy)).toContain('terminal, and is working in it now');
    expect(heldLine(quiet)).toContain('terminal.');
    expect(heldLine(quiet)).not.toContain('working');
  });

  it('the facts went stale: the badge survives, the mark and its clock do not', () => {
    const read = chatState({ state: 'dormant', held: holderOnly(held({ doing: 'working' })) });
    expect(read.external).toEqual({ holder: 'terminal' });
    expect(read.word).toBe('');
    expect(read.since).toBeNull();
    expect(body(read)).toBeNull();
  });

  it('a holder that died mid-turn: nothing holds it, so it is our own chat again', () => {
    // The sidecar drops it from the running set, so no `held` reaches here at
    // all — and the row falls back to what our own side knows, which is asleep.
    const read = chatState({ state: 'dormant', held: null });
    expect(read.word).toBe('Asleep');
    expect(read.external).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What a held chat is doing, from the two signals there are.
// ---------------------------------------------------------------------------

describe('what the machine says a held chat is doing', () => {
  const base = { status: null, statusAt: null, recordMovedAt: NOW, owed: false, burstAt: null, now: NOW };

  it('its own process says busy: working, from the moment it said so', () => {
    expect(heldDoing({ ...base, status: 'busy', statusAt: BEGAN })).toEqual({
      doing: 'working',
      since: BEGAN,
    });
  });

  it('its own process says idle: idle, whatever the record looks like', () => {
    expect(heldDoing({ ...base, status: 'idle', owed: true })).toEqual({ doing: 'idle', since: null });
  });

  it('no word from the process, a turn in flight: working', () => {
    expect(heldDoing({ ...base, owed: true, recordMovedAt: NOW - 600_000 }).doing).toBe('working');
  });

  it('no word, nothing owed, the record just moved: working', () => {
    expect(heldDoing({ ...base, recordMovedAt: NOW - 1_000 }).doing).toBe('working');
  });

  it('no word, nothing owed, the record quiet past the window: idle', () => {
    expect(heldDoing({ ...base, recordMovedAt: NOW - RECORD_QUIET_MS - 1 }).doing).toBe('idle');
  });

  it('no word and no record: nothing is claimed', () => {
    expect(heldDoing({ ...base, recordMovedAt: null })).toEqual({ doing: 'unknown', since: null });
  });

  it('the seconds count from where the burst began, not from the beat', () => {
    expect(heldDoing({ ...base, owed: true, burstAt: BEGAN, recordMovedAt: NOW }).since).toBe(BEGAN);
  });
});

// ---------------------------------------------------------------------------
// The end of a record, shape by shape. Ground: docs/agent-workbench.md §6.3.5.
// ---------------------------------------------------------------------------

describe('the last thing written in a record', () => {
  it('the person typed something: an answer is owed', () => {
    expect(answerOwed(person('run the tests'))).toBe(true);
  });

  it('the person typed something, in blocks: an answer is owed', () => {
    expect(answerOwed(person([{ type: 'text', text: 'run the tests' }]))).toBe(true);
  });

  it('the person sent a picture and no words: an answer is owed', () => {
    expect(answerOwed(person([{ type: 'image', source: {} }]))).toBe(true);
  });

  it('a tool answered back: the turn goes on', () => {
    expect(answerOwed(person([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]))).toBe(true);
  });

  it('a command that was refused: the agent still owes the next word', () => {
    expect(
      answerOwed(
        person([{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'The user doesn\'t want to proceed' }]),
      ),
    ).toBe(true);
  });

  it('a turn the person stopped: nothing is owed', () => {
    expect(answerOwed(person([{ type: 'text', text: '[Request interrupted by user]' }]))).toBe(false);
  });

  it('a tool call the person stopped: nothing is owed', () => {
    expect(answerOwed(person([{ type: 'text', text: '[Request interrupted by user for tool use]' }]))).toBe(false);
  });

  it('a slash command the person typed: its echo owes nothing', () => {
    expect(answerOwed(person('<command-name>/compact</command-name>'))).toBe(false);
  });

  it('what that command printed: owes nothing either', () => {
    expect(answerOwed(person('<local-command-stdout>Compacted </local-command-stdout>'))).toBe(false);
  });

  it('a record the tool rewrote under us: the summary it left owes nothing by itself', () => {
    expect(answerOwed(person('This session is being continued…', { isCompactSummary: true }))).toBe(false);
  });

  it('and the prompt after that rewrite is owed as any other', () => {
    expect(answerOwed(person('carry on'))).toBe(true);
  });

  it('a helper finished and said so: the agent is expected to answer it', () => {
    expect(answerOwed(person('<task-notification> <task-id>b01og</task-id> done'))).toBe(true);
  });

  it('the agent asked for a tool: an answer is owed', () => {
    expect(answerOwed(agent([{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }]))).toBe(true);
  });

  it('the agent said a word and then asked for a tool: an answer is owed', () => {
    expect(
      answerOwed(agent([{ type: 'text', text: 'Reading it now.' }, { type: 'tool_use', id: 'a', name: 'Bash', input: {} }])),
    ).toBe(true);
  });

  it('the agent only thought: the turn is still in flight', () => {
    expect(answerOwed(agent([{ type: 'thinking', thinking: 'the file is…' }]))).toBe(true);
  });

  it('the agent thought and then said its piece: the turn is over', () => {
    expect(answerOwed(agent([{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'Done.' }]))).toBe(false);
  });

  it('the agent said its piece: the turn is over', () => {
    expect(answerOwed(agent([{ type: 'text', text: 'Done.' }]))).toBe(false);
  });

  it('the turn failed and the kit wrote the error as the answer: the turn is over', () => {
    expect(answerOwed({ ...agent([{ type: 'text', text: 'API Error: 500' }]), isApiErrorMessage: true })).toBe(false);
  });

  it('nothing could be read at all: no claim, and the quiet timer decides', () => {
    expect(answerOwed(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The two ends joined: what the reader actually sees for a held chat whose
// only evidence is the end of its record.
// ---------------------------------------------------------------------------

describe('a held chat read from its record alone', () => {
  function readFrom(last: unknown, movedAt: number): ChatState {
    const doing = heldDoing({
      status: null,
      statusAt: null,
      recordMovedAt: movedAt,
      owed: answerOwed(last as never),
      burstAt: BEGAN,
      now: NOW,
    });
    return chatState({
      state: 'dormant',
      held: { id: 'ef56704b', holder: 'terminal', ...doing },
    });
  }

  it('mid-think, and quiet for a minute: still Working, and the body still moves', () => {
    const read = readFrom(agent([{ type: 'thinking', thinking: '…' }]), NOW - 60_000);
    expect(read.working).toBe(true);
    expect(read.word).toBe('Working');
    expect(read.since).toBe(BEGAN);
    expect(body(read)).not.toBeNull();
  });

  it('a turn the person stopped an hour ago: Idle, and the body is still', () => {
    const read = readFrom(person([{ type: 'text', text: '[Request interrupted by user]' }]), NOW - 3_600_000);
    expect(read.working).toBe(false);
    expect(read.word).toBe('Idle');
    expect(body(read)).toBeNull();
  });

  it('a slash command typed an hour ago: Idle, not Working for ever', () => {
    const read = readFrom(person('<command-name>/compact</command-name>'), NOW - 3_600_000);
    expect(read.word).toBe('Idle');
  });

  it('a slash command typed a moment ago: still Working, because the record just moved', () => {
    const read = readFrom(person('<command-name>/compact</command-name>'), NOW - 1_000);
    expect(read.word).toBe('Working');
  });

  it('an answer finished an hour ago: Idle, and the badge is all that is left', () => {
    const read = readFrom(agent([{ type: 'text', text: 'Done.' }]), NOW - 3_600_000);
    expect(read.word).toBe('Idle');
    expect(read.external).toEqual({ holder: 'terminal' });
  });

  it('a command in flight an hour into it: Working, because the tool is still out', () => {
    const read = readFrom(agent([{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }]), NOW - 3_600_000);
    expect(read.word).toBe('Working');
  });
});

// ---------------------------------------------------------------------------
// The same chat, on the row and in the bar above it. The list is fetched once
// and everything after it arrives on the live stream, so the row and the bar
// only agree if that stream's word and clock reach the row (bw-96is.31).
// ---------------------------------------------------------------------------

describe('the row and the bar say the same thing', () => {
  const PROJECT = 'p1';

  function live(over: Partial<LiveSession> = {}): LiveSession {
    return {
      id: 's1',
      brand: 'claude',
      externalId: null,
      projectId: PROJECT,
      projectPath: '/home/me/project',
      title: 'A chat of ours',
      state: 'running_tool',
      activity: 'Pulling the branch apart',
      waitingFor: null,
      busySince: new Date(BEGAN).toISOString(),
      lastActiveAt: new Date(NOW).toISOString(),
      lastSpokeAt: null,
      startedAt: new Date(BEGAN).toISOString(),
      beads: [],
      ...over,
    };
  }

  function listed(over: Partial<RestoreRow> = {}): RestoreRow {
    return {
      sessionId: 's1',
      externalId: null,
      brand: 'claude',
      title: 'A chat of ours',
      lastActiveAt: new Date(BEGAN).toISOString(),
      state: 'dormant',
      origin: 'app',
      projectId: PROJECT,
      cwdHint: '/home/me/project',
      folder: 'project',
      branch: null,
      beads: [],
      ...over,
    };
  }

  /** The row's own reading, exactly as the list draws it. */
  function fromRow(row: RestoreRow) {
    return chatState({
      state: row.state,
      label: row.activity,
      since: row.busySince ? Date.parse(row.busySince) : null,
      held: row.held ?? null,
    });
  }

  it('a chat already on the list: the row draws the driver\'s word and its clock, as the bar does', () => {
    const session = live();
    const [row] = withLive([listed()], [session], PROJECT);
    expect(fromRow(row!)).toEqual(liveState(session));
    expect(fromRow(row!).word).toBe('Pulling the branch apart');
    expect(fromRow(row!).since).toBe(BEGAN);
    expect(mark(fromRow(row!))).toEqual({ word: 'Pulling the branch apart', moving: true });
  });

  it('a chat that started after the list was fetched: the same, on the row it joins as', () => {
    const session = live({ id: 's2' });
    const [row] = withLive([], [session], PROJECT);
    expect(fromRow(row!)).toEqual(liveState(session));
  });

  for (const state of ['starting', 'thinking', 'streaming', 'running_tool', 'waiting_permission'] as const) {
    it(`${state}: row and bar agree on the word, the clock and whether the mark moves`, () => {
      const session = live({ state, activity: null });
      const [row] = withLive([listed()], [session], PROJECT);
      expect(fromRow(row!)).toEqual(liveState(session));
    });
  }

  it('the driver falls quiet: the row stops counting the moment the bar does', () => {
    const session = live({ state: 'idle', activity: null, busySince: null });
    const [row] = withLive([listed({ state: 'running_tool' })], [session], PROJECT);
    expect(fromRow(row!)).toEqual(liveState(session));
    expect(fromRow(row!).since).toBeNull();
    expect(mark(fromRow(row!))).toEqual({ word: 'Ready', moving: false });
  });

  it('a row the stream has never spoken about: read from its own state, and counting nothing', () => {
    const read = fromRow(listed({ state: 'dormant' }));
    expect(read.word).toBe('Asleep');
    expect(read.since).toBeNull();
  });

  it('somebody else holds it: the row draws the holder and not our own stale word', () => {
    const row = listed({
      state: 'dormant',
      externalId: 'ef56704b',
      activity: 'Pulling the branch apart',
      busySince: new Date(BEGAN).toISOString(),
      held: held({ holder: 'terminal', doing: 'idle', since: null }),
    });
    const read = fromRow(row);
    expect(read.word).toBe('Idle');
    expect(read.external).toEqual({ holder: 'terminal' });
    expect(read.since).toBeNull();
  });
});
