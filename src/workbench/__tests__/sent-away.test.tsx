/**
 * Everything the chat handed to something else, as rows beside it.
 *
 * The kit was always saying this and the screen was always throwing it away: a
 * chat that sent four helpers off drew four grey commands and no answer to
 * "what is running, on which model, for how long, at what price"
 * (bw-7ks.22.3).
 *
 * Both folds are checked on the same events, because the live tail and the
 * replay are two paths to one conversation and a difference between them is a
 * panel that changes when you reload it (§4).
 *
 * The clock is held still for the drawing, because a row counts its own seconds
 * between the kit's reports and a test that reads the real clock proves only
 * what time it was when it ran.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMPTY, foldAll, reduce, type SentAway, type SessionView } from '@/workbench/fold';
import type { WbpEvent } from '@/workbench/protocol';
import { SentAwayPanel, forHowLong, modelNamed, spend } from '@/workbench/sent-away';

/** When everything below was sent away. */
const OFF = '2026-08-20T09:00:00.000Z';

/** A minute and two seconds later, which is when the panel is drawn. */
const NOW = '2026-08-20T09:01:02.000Z';

let stamped = 0;
type Said<T> = T extends unknown ? Omit<T, 'seq' | 'sessionId' | 'at'> : never;
function said(e: Said<WbpEvent>): WbpEvent {
  stamped += 1;
  return { ...e, seq: stamped, sessionId: 'chat-1', at: OFF } as WbpEvent;
}

/**
 * A turn that sends all four kinds of work away: a helper given a brief, a
 * command left running, a watch, and a scripted run of agents.
 */
function sentAway(): WbpEvent[] {
  return [
    // The helper, named twice on purpose — the kit's level list and its edge
    // both name a task and the SDK says either may arrive first.
    said({
      type: 'agent.started',
      agentId: 'task-1',
      toolCallId: 'call-1',
      kind: 'helper',
      what: 'find the callers',
      agentType: 'general-purpose',
      model: null,
    }),
    said({
      type: 'agent.started',
      agentId: 'task-1',
      toolCallId: null,
      kind: 'helper',
      what: '',
      agentType: null,
      model: 'claude-opus-4-5-20251101',
    }),
    said({ type: 'agent.progress', agentId: 'task-1', seconds: 31, tokens: 12_400, calls: 6, doing: 'Reading the router' }),
    said({ type: 'agent.progress', agentId: 'task-1', seconds: 90, tokens: 20_100, calls: 9 }),

    said({
      type: 'agent.started',
      agentId: 'bash-1',
      toolCallId: 'call-2',
      kind: 'command',
      what: 'npm test',
      agentType: null,
      model: null,
    }),
    said({ type: 'agent.progress', agentId: 'bash-1', seconds: 20, tokens: 0, calls: 0, state: 'parked' }),

    said({
      type: 'agent.started',
      agentId: 'watch-1',
      toolCallId: 'call-3',
      kind: 'watch',
      what: 'tests/results',
      agentType: null,
      model: null,
    }),

    said({
      type: 'agent.started',
      agentId: 'run-1',
      toolCallId: 'call-4',
      kind: 'run',
      what: 'review the branch',
      agentType: null,
      model: 'claude-sonnet-4-5-20250929',
    }),
    said({ type: 'agent.progress', agentId: 'run-1', seconds: 45, tokens: 88_000, calls: 12, doing: 'Judging findings' }),
    // Finished carrying nothing but the verdict, which is how the kit's own
    // notification arrives.
    said({
      type: 'agent.finished',
      agentId: 'run-1',
      state: 'done',
      seconds: 0,
      tokens: 0,
      calls: 0,
      model: null,
      result: 'Three findings, one real.',
    }),
  ];
}

/** The same events down the live tail, one at a time. */
function live(events: WbpEvent[]): SessionView {
  return events.reduce(reduce, EMPTY);
}

const bothWays: [string, (events: WbpEvent[]) => SessionView][] = [
  ['the live tail', live],
  ['a replay', (events) => foldAll(events)],
];

describe.each(bothWays)('what the chat sent away, down %s', (_name, build) => {
  const view = build(sentAway());
  const row = (id: string) => view.agents.find((a) => a.id === id)!;

  it('keeps one row per piece of work, in the order it was sent', () => {
    expect(view.agents.map((a) => a.id)).toEqual(['task-1', 'bash-1', 'watch-1', 'run-1']);
  });

  it('draws one row for a helper the kit names twice', () => {
    expect(view.agents.filter((a) => a.id === 'task-1')).toHaveLength(1);
    expect(row('task-1')).toMatchObject({
      toolCallId: 'call-1',
      what: 'find the callers',
      agentType: 'general-purpose',
      model: 'claude-opus-4-5-20251101',
    });
  });

  it('carries the kind, the clock and the spend the kit reported', () => {
    expect(row('task-1')).toMatchObject({ kind: 'helper', state: 'running', seconds: 90, tokens: 20_100, calls: 9 });
    expect(row('task-1').startedAt).toBe(Date.parse(OFF));
  });

  it('keeps the last thing it said when a later beat says nothing new', () => {
    expect(row('task-1').doing).toBe('Reading the router');
  });

  it('takes the state a beat reports without touching the rest', () => {
    expect(row('bash-1')).toMatchObject({ kind: 'command', state: 'parked', what: 'npm test' });
  });

  it('leaves work nobody has reported on at nothing spent', () => {
    expect(row('watch-1')).toMatchObject({ kind: 'watch', state: 'running', seconds: 0, tokens: 0, doing: null });
  });

  it('keeps the last figures it was given when the finish carries none', () => {
    expect(row('run-1')).toMatchObject({
      state: 'done',
      seconds: 45,
      tokens: 88_000,
      calls: 12,
      model: 'claude-sonnet-4-5-20250929',
      result: 'Three findings, one real.',
    });
  });

  it('forgets them all when the conversation is replaced', () => {
    expect(build([...sentAway(), said({ type: 'transcript.reset' })]).agents).toEqual([]);
  });
});

describe('the live tail and a replay', () => {
  it('agree on every row', () => {
    expect(live(sentAway()).agents).toEqual(foldAll(sentAway()).agents);
  });
});

describe('the numbers, said short enough to sit in a column', () => {
  it('rounds time to the unit a glance needs', () => {
    expect(forHowLong(0)).toBe('0s');
    expect(forHowLong(59)).toBe('59s');
    expect(forHowLong(60)).toBe('1m 00s');
    expect(forHowLong(124)).toBe('2m 04s');
    expect(forHowLong(4800)).toBe('1h 20m');
  });

  it('rounds spend, keeping a digit while the figure is small', () => {
    expect(spend(940)).toBe('940');
    expect(spend(1240)).toBe('1.2k');
    expect(spend(20_100)).toBe('20k');
    expect(spend(1_240_000)).toBe('1.2M');
  });

  it('says the model without the vendor or the date', () => {
    expect(modelNamed('claude-opus-4-5-20251101')).toBe('opus-4-5');
    expect(modelNamed('gpt-5-codex')).toBe('gpt-5-codex');
    expect(modelNamed(null)).toBeNull();
  });
});

describe('the panel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function drawn() {
    const agents = foldAll(sentAway()).agents;
    render(<SentAwayPanel items={[]} agents={agents} sessionId="chat-1" controls={[]} />);
    return Object.fromEntries(
      screen.getAllByTestId('sent-away-row').map((el) => [el.getAttribute('data-agent')!, el]),
    );
  }

  it('draws nothing at all when the chat has sent nothing away', () => {
    const { container } = render(<SentAwayPanel items={[]} agents={[]} sessionId="chat-1" controls={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('gives every piece of sent-off work a row of its own', () => {
    drawn();
    const panel = screen.getByTestId('sent-away-panel');
    expect(panel).toHaveAttribute('data-rows', '4');
    expect(panel, 'the finished run is still counted as running').toHaveAttribute('data-running', '3');
    expect(screen.getAllByTestId('sent-away-row').map((el) => el.getAttribute('data-kind'))).toEqual([
      'helper',
      'command',
      'watch',
      'run',
    ]);
  });

  it('carries what it is, which model, how long and what it spent', () => {
    const rows = drawn();
    const helper = rows['task-1']!;
    expect(helper).toHaveAttribute('data-state', 'running');
    expect(helper.querySelector('[data-testid="sent-away-kind"]')).toHaveTextContent('helper');
    expect(helper.querySelector('[data-testid="sent-away-agent-type"]')).toHaveTextContent('general-purpose');
    expect(helper.querySelector('[data-testid="sent-away-what"]')).toHaveTextContent('find the callers');
    expect(helper.querySelector('[data-testid="sent-away-model"]')).toHaveTextContent('opus-4-5');
    // The kit's own count, which is ahead of the row's: it knows about pauses.
    expect(helper.querySelector('[data-testid="sent-away-for"]')).toHaveTextContent('1m 30s');
    expect(helper.querySelector('[data-testid="sent-away-spend"]')).toHaveTextContent('20k');
    expect(helper.querySelector('[data-testid="sent-away-calls"]')).toHaveTextContent('9 calls');
    // What it is doing is the chat's own mark now — the same chip the chat's
    // own line and the row in the list wear — rather than a line of italics
    // this panel drew for itself (bw-pukk.2).
    const mark = helper.querySelector('[data-testid="sent-away-state"]')!;
    expect(mark).toHaveAttribute('data-word', 'Working');
    expect(mark).toHaveTextContent('Reading the router');
  });

  it('draws no agent definition, not even a placeholder, when the kit never named one', () => {
    const rows = drawn();
    expect(rows['bash-1']!.querySelector('[data-testid="sent-away-agent-type"]')).toBeNull();
  });

  it('counts its own seconds between the kit’s reports', () => {
    const rows = drawn();
    const command = rows['bash-1']!;
    const clock = () => command.querySelector('[data-testid="sent-away-for"]')!.textContent;

    // The kit last said 20s a minute ago, and a clock that jumps in
    // half-minutes reads as a clock that has stopped.
    expect(clock()).toBe('1m 02s');
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(clock()).toBe('1m 07s');
  });

  it('goes quiet when the work is over, and keeps its answer', () => {
    const rows = drawn();
    const run = rows['run-1']!;
    expect(run).toHaveAttribute('data-state', 'done');
    expect(run.querySelector('[data-testid="sent-away-state"]')).toHaveAttribute('data-word', 'Done');
    expect(run.querySelector('[data-testid="sent-away-result"]')).toHaveTextContent('Three findings, one real.');
    expect(
      run.querySelector('[data-testid="sent-away-state"]'),
      'a finished row is still saying what it is doing',
    ).not.toHaveTextContent('Judging findings');

    // And its clock has stopped: what it took is what it took.
    expect(run.querySelector('[data-testid="sent-away-for"]')).toHaveTextContent('45s');
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(run.querySelector('[data-testid="sent-away-for"]')).toHaveTextContent('45s');
  });

  it.each(['Claude', 'Codex'])('draws a terminal %s helper as Done, never Working', (provider) => {
    const id = `${provider.toLowerCase()}-helper`;
    const agents = foldAll([
      said({
        type: 'agent.started', agentId: id, toolCallId: `${id}-call`, kind: 'helper',
        what: `Inspect with ${provider}`, agentType: 'reviewer', model: null,
      }),
      said({
        type: 'agent.finished', agentId: id, state: 'done', seconds: 23,
        tokens: 100, calls: 2, model: null, result: 'Inspection complete.',
      }),
    ]).agents;

    render(<SentAwayPanel items={[]} agents={agents} sessionId="chat-1" controls={[]} />);

    const mark = screen.getByTestId('sent-away-state');
    expect(mark).toHaveAttribute('data-word', 'Done');
    expect(mark).not.toHaveTextContent('Working');
  });

  it('says which of them are waiting on you', () => {
    const rows = drawn();
    expect(rows['bash-1']!.querySelector('[data-testid="sent-away-state"]')).toHaveAttribute('data-word', 'In background');
    expect(rows['task-1']!.querySelector('[data-testid="sent-away-state"]')).toHaveAttribute('data-word', 'Working');
  });

  /**
   * The whole row is the way into that agent's own conversation, not a mark on
   * it: a target the size of one word beside the words is a target the reader
   * misses, and there is nothing else on the row to click (bw-7ks.22.4).
   */
  it('hands back which one was clicked, wherever on the row the click landed', () => {
    const opened: string[] = [];
    const view = foldAll(sentAway());
    render(<SentAwayPanel items={[]} agents={view.agents} sessionId="chat-1" controls={[]} onOpen={(id) => opened.push(id)} />);

    const row = screen.getByTestId('sent-away-panel').querySelector('[data-agent="task-1"]')!;
    (row.querySelector('[data-testid="sent-away-open"]') as HTMLElement).click();
    // On the words themselves, which is where a reader aims.
    (row.querySelector('[data-testid="sent-away-what"]') as HTMLElement).click();
    // And on its clock, at the other end of the row.
    (row.querySelector('[data-testid="sent-away-for"]') as HTMLElement).click();

    expect(opened).toEqual(['task-1', 'task-1', 'task-1']);
  });
});

/**
 * What is still going, and only that, until the reader asks for the rest
 * (bw-pl2v.2).
 *
 * A session that sends off forty helpers drew forty rows, and the two still
 * working were somewhere in the middle of them. The split is `isOver` and
 * nothing else — done, failed and stopped are all behind the one control,
 * because a reader who wants the one that failed wants the one that finished.
 */
describe('the running ones on top, the finished ones behind a control', () => {
  /** One still running, and however many endings are asked for. */
  function ended(...states: ('done' | 'failed' | 'stopped')[]): SentAway[] {
    return foldAll([
      said({ type: 'agent.started', agentId: 'live-1', toolCallId: 'c-live', kind: 'helper', what: 'still going', agentType: null, model: null }),
      ...states.flatMap((state, i) => [
        said({ type: 'agent.started', agentId: `over-${i}`, toolCallId: `c-${i}`, kind: 'helper', what: `over ${i}`, agentType: null, model: null }),
        said({ type: 'agent.finished', agentId: `over-${i}`, state, seconds: 3, tokens: 10, calls: 1, model: null, result: null }),
      ]),
    ]).agents;
  }

  const draw = (agents: SentAway[]) =>
    render(<SentAwayPanel items={[]} agents={agents} sessionId="chat-1" controls={[]} />);

  /** Which agents a group holds, top to bottom. */
  const inside = (testId: string) =>
    Array.from(screen.getByTestId(testId).querySelectorAll('[data-testid="sent-away-row"]')).map((el) =>
      el.getAttribute('data-agent'),
    );

  const control = () => screen.getByTestId('toggle-stopped-agents');

  it('lists only what is still going, above the control', () => {
    draw(ended('done', 'failed', 'stopped'));

    expect(inside('sent-away-running')).toEqual(['live-1']);
    expect(inside('sent-away-stopped')).toEqual(['over-0', 'over-1', 'over-2']);
    // Shut on arrival, and shut by the class rather than by unmounting: the
    // rows keep their answers and their stopped clocks behind it.
    expect(screen.getByTestId('sent-away-stopped')).toHaveClass('hidden');
    expect(control()).toHaveAttribute('aria-expanded', 'false');
  });

  it('puts the running group above the finished one', () => {
    draw(ended('done'));
    const panel = screen.getByTestId('sent-away-panel');
    const running = screen.getByTestId('sent-away-running');
    const over = screen.getByTestId('sent-away-stopped');

    expect(panel.contains(running) && panel.contains(over)).toBe(true);
    expect(running.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('carries the count in the words, so the reader knows before opening it', () => {
    draw(ended('stopped'));
    expect(control()).toHaveTextContent('Show 1 completed');
  });

  it('says how many when there is more than one', () => {
    draw(ended('done', 'failed', 'stopped'));
    expect(control()).toHaveTextContent('Show 3 completed');
  });

  it('opens on a click and shuts on the next one', () => {
    draw(ended('done', 'stopped'));

    act(() => control().click());
    expect(screen.getByTestId('sent-away-stopped')).toHaveClass('flex');
    expect(screen.getByTestId('sent-away-stopped')).not.toHaveClass('hidden');
    expect(control()).toHaveAttribute('aria-expanded', 'true');
    expect(control()).toHaveTextContent('Hide 2 completed');

    act(() => control().click());
    expect(screen.getByTestId('sent-away-stopped')).toHaveClass('hidden');
    expect(control()).toHaveAttribute('aria-expanded', 'false');
  });

  it('names the group it controls, so a reader not looking at it is told what opened', () => {
    draw(ended('done'));
    expect(control().getAttribute('aria-controls')).toBe(screen.getByTestId('sent-away-stopped').id);
  });

  it('draws no control at all while nothing has finished', () => {
    draw(ended());
    expect(inside('sent-away-running')).toEqual(['live-1']);
    expect(screen.queryByTestId('toggle-stopped-agents')).toBeNull();
    expect(screen.queryByTestId('sent-away-stopped')).toBeNull();
  });

  it('keeps the control when everything has finished, over an empty space', () => {
    // No placeholder under an empty running list: the control below it already
    // says where the rows went.
    draw(foldAll([
      said({ type: 'agent.started', agentId: 'over-a', toolCallId: 'c-a', kind: 'helper', what: 'over', agentType: null, model: null }),
      said({ type: 'agent.finished', agentId: 'over-a', state: 'stopped', seconds: 3, tokens: 10, calls: 1, model: null, result: null }),
    ]).agents);

    expect(inside('sent-away-running')).toEqual([]);
    expect(screen.getByTestId('sent-away-running')).toBeEmptyDOMElement();
    expect(control()).toHaveTextContent('Show 1 completed');
  });
});

/**
 * A row that is over stays as it ended (bw-7ks.22.30).
 *
 * Two writers end a row and a third keeps talking about it: the kit's own
 * notification, the receipt of the call that dispatched it, and the routine
 * status pings that go on arriving for a moment afterwards. The endings were
 * already settled between themselves; the pings were not, and a 'still running'
 * landing a beat after a stop put the row back to running — his stop undone,
 * with nothing on the screen to say it ever happened.
 */
describe.each(bothWays)('a row that is over, down %s', (_name, build) => {
  /** Sent off, then over, then a routine status ping about it afterwards. */
  const after = (ending: WbpEvent[], ping: Said<WbpEvent>): SessionView =>
    build([
      said({
        type: 'agent.started',
        agentId: 'late-1',
        toolCallId: 'call-late',
        kind: 'helper',
        what: 'count the rows',
        agentType: 'general-purpose',
        model: null,
      }),
      said({ type: 'agent.progress', agentId: 'late-1', seconds: 30, tokens: 9_000, calls: 4 }),
      ...ending,
      said(ping),
    ]);

  const stopped = [
    said({
      type: 'agent.finished',
      agentId: 'late-1',
      state: 'stopped',
      seconds: 30,
      tokens: 9_000,
      calls: 4,
      model: 'claude-fable-5',
      result: null,
    }),
  ];
  const finished = [
    said({
      type: 'agent.finished',
      agentId: 'late-1',
      state: 'done',
      seconds: 45,
      tokens: 12_000,
      calls: 6,
      model: 'claude-fable-5',
      result: 'All 412 rows counted.',
    }),
  ];

  it('is not put back to running by a status that arrives after he stopped it', () => {
    const view = after(stopped, { type: 'agent.progress', agentId: 'late-1', seconds: 31, tokens: 9_400, calls: 5, state: 'running' });
    expect(view.agents[0]).toMatchObject({ state: 'stopped', seconds: 30, tokens: 9_000, calls: 4 });
  });

  it('is not reopened by a status that arrives after it finished', () => {
    const view = after(finished, { type: 'agent.progress', agentId: 'late-1', seconds: 46, tokens: 1, calls: 1, state: 'running' });
    expect(view.agents[0]).toMatchObject({ state: 'done', result: 'All 412 rows counted.' });
  });

  it('keeps the numbers it ended with rather than whatever the late word carries', () => {
    const view = after(finished, { type: 'agent.progress', agentId: 'late-1', seconds: 0, tokens: 0, calls: 0 });
    expect(view.agents[0]).toMatchObject({ seconds: 45, tokens: 12_000, calls: 6 });
  });

  it('accepts higher final usage without writing another ending or reopening the row', () => {
    const view = after(finished, { type: 'agent.progress', agentId: 'late-1', seconds: 50, tokens: 14_000, calls: 7, finalUsage: true });
    expect(view.agents[0]).toMatchObject({
      state: 'done', result: 'All 412 rows counted.', seconds: 50, tokens: 14_000, calls: 7,
    });
  });

  it('still learns which model it ran, which is the one fact that arrives late by design', () => {
    const view = after(
      [
        said({
          type: 'agent.finished',
          agentId: 'late-1',
          state: 'done',
          seconds: 45,
          tokens: 12_000,
          calls: 6,
          model: null,
          result: 'All 412 rows counted.',
        }),
      ],
      { type: 'agent.progress', agentId: 'late-1', seconds: 45, tokens: 12_000, calls: 6, model: 'claude-fable-5' },
    );
    expect(view.agents[0]).toMatchObject({ state: 'done', model: 'claude-fable-5' });
  });
});
