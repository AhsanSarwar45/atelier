/**
 * A helper works off the manager's screen, and says what it is doing on its own
 * card (bw-pukk).
 *
 * The transcript is HIS turn. Every command, sentence and thought a sent-off
 * helper produced used to be drawn inline in it behind a violet rail, so one
 * scout reading a directory put thirty rows between the question he asked and
 * the answer he was waiting for (his screenshot, 2026-08-25). None of it is
 * lost: the card in the rail says what the helper is doing this second, and the
 * conversation opened from that card is the whole of it.
 *
 * Two things a helper produces are still his news and are still drawn where he
 * is looking — a question it is stopped on, and a failure — because both are
 * things he has to act on and a card he has not opened cannot tell him.
 *
 * The rows are folded both ways, live and read back off the record, because a
 * rule that holds only until the page is reloaded is not a rule (fold.ts).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import { AgentView, saidBy } from '@/workbench/agent-view';
import { EMPTY, foldAll, reduce, type SessionView, type TranscriptItem } from '@/workbench/fold';
import { EVERYTHING, showing } from '@/workbench/message-filter';
import type { WbpEvent } from '@/workbench/protocol';
import { SentAwayPanel } from '@/workbench/sent-away';

const OFF = '2026-08-25T09:00:00.000Z';

let stamped = 0;
type Said<T> = T extends unknown ? Omit<T, 'seq' | 'sessionId' | 'at'> : never;
function said(e: Said<WbpEvent>): WbpEvent {
  stamped += 1;
  return { ...e, seq: stamped, sessionId: 'chat-1', at: OFF } as WbpEvent;
}

/** Words, drawn as they are: none of this is about what makes a card a link. */
const PLAINLY: Mentions = { split: (text) => [{ kind: 'text', text }], card: () => null };

/**
 * A chat that says something of its own, runs a command of its own, and sends
 * one helper off — which then thinks, speaks, runs two commands of its own
 * (one of them failing) and stops on a question.
 */
function aChatWithAHelper(): WbpEvent[] {
  stamped = 0;
  return [
    said({ type: 'message.started', messageId: 'm1', role: 'assistant' }),
    said({ type: 'text.delta', messageId: 'm1', text: 'Sending a scout off.' }),
    said({ type: 'message.completed', messageId: 'm1' }),
    said({
      type: 'tool.started',
      toolCallId: 'mine-1',
      name: 'Read',
      input: {},
      title: 'chat-tab.tsx',
      parentToolCallId: null,
    }),
    said({ type: 'tool.completed', toolCallId: 'mine-1', ok: true, output: 'read it' }),

    // The chat's own row for the work it is handing over. It stays in his
    // transcript: the work has to be accounted for somewhere in his own turn.
    said({
      type: 'tool.started',
      toolCallId: 'call-1',
      name: 'Task',
      input: { description: 'find the side chat list row' },
      title: 'Sending off a scout to find the side chat list row',
      parentToolCallId: null,
    }),
    said({
      type: 'agent.started',
      agentId: 'task-1',
      toolCallId: 'call-1',
      kind: 'helper',
      what: 'find the side chat list row',
      agentType: 'scout',
      model: 'claude-sonnet-4-5-20250929',
    }),

    said({ type: 'thinking.delta', messageId: 't1', text: 'Where would that row live', parentToolCallId: 'call-1' }),
    said({ type: 'message.completed', messageId: 't1' }),
    said({ type: 'message.started', messageId: 'h1', role: 'assistant', parentToolCallId: 'call-1' }),
    said({ type: 'text.delta', messageId: 'h1', text: 'Reading the router first.' }),
    said({ type: 'message.completed', messageId: 'h1' }),

    said({
      type: 'tool.started',
      toolCallId: 'cmd-ok',
      name: 'Grep',
      input: { pattern: 'RailRow' },
      title: 'Searched for RailRow',
      parentToolCallId: 'call-1',
    }),
    said({ type: 'tool.completed', toolCallId: 'cmd-ok', ok: true, output: 'two hits' }),

    said({
      type: 'tool.started',
      toolCallId: 'cmd-bad',
      name: 'Glob',
      input: { pattern: 'workbench' },
      title: 'Looked for workbench',
      parentToolCallId: 'call-1',
    }),
    said({ type: 'tool.completed', toolCallId: 'cmd-bad', ok: false, output: 'no such directory' }),

    said({
      type: 'ask.permission',
      askId: 'ask-1',
      toolName: 'Bash',
      input: { command: 'rm -rf out' },
      title: 'rm -rf out',
      options: [
        { id: 'yes', label: 'Allow', kind: 'allow_once' as const },
        { id: 'no', label: 'Deny', kind: 'deny' as const },
      ],
      parentToolCallId: 'call-1',
    }),
  ];
}

const live = (events: WbpEvent[]): SessionView => events.reduce(reduce, EMPTY);

const bothWays: [string, (events: WbpEvent[]) => SessionView][] = [
  ['watched live', live],
  ['read back off the record', foldAll],
];

/** What the conversation would draw, with nothing switched off. */
const inHisTranscript = (view: SessionView): TranscriptItem[] => showing(view.items, EVERYTHING);

const idsOf = (items: TranscriptItem[]): string[] => items.map((i) => i.id);

describe.each(bothWays)('a chat %s', (_name, fold) => {
  const view = fold(aChatWithAHelper());
  const drawn = inHisTranscript(view);

  it('draws the chat’s own words and the chat’s own commands', () => {
    expect(idsOf(drawn)).toContain('m1');
    expect(idsOf(drawn)).toContain('mine-1');
  });

  it('draws the call that sent the helper off, which is the chat’s own row', () => {
    // The work has to be accounted for somewhere in his turn, and this is it.
    expect(idsOf(drawn)).toContain('call-1');
  });

  it('draws none of what the helper ran, said or thought', () => {
    expect(idsOf(drawn)).not.toContain('cmd-ok');
    expect(idsOf(drawn)).not.toContain('h1');
    expect(idsOf(drawn)).not.toContain('t1');
  });

  it('draws the command the helper failed at, because a helper going wrong is his news', () => {
    expect(idsOf(drawn)).toContain('cmd-bad');
    const failed = drawn.find((i) => i.id === 'cmd-bad');
    expect(failed?.kind === 'tool' && failed.status).toBe('failed');
  });

  it('draws the question the helper is stopped on, because it is waiting on him', () => {
    expect(idsOf(drawn)).toContain('ask-1');
    const ask = drawn.find((i) => i.id === 'ask-1');
    expect(ask?.kind === 'ask' && ask.parentId).toBe('call-1');
  });

  it('says on the row that the helper has stopped working and is waiting to be answered', () => {
    expect(view.agents.find((a) => a.id === 'task-1')?.state).toBe('waiting');
  });

  it('puts the row back to work when the question is answered', () => {
    const answered = fold([
      ...aChatWithAHelper(),
      said({ type: 'ask.resolved', askId: 'ask-1', chosen: 'yes' }),
    ]);
    expect(answered.agents.find((a) => a.id === 'task-1')?.state).toBe('running');
  });

  /**
   * The other two roads a helper can stop on. A form it was told to fill in
   * and a plan it put up for approval hold it exactly the way a permission
   * does, and a row that went on spinning through either of them would be the
   * same spinner beside stopped work.
   */
  const answeredTheFirst = (): WbpEvent[] => [
    ...aChatWithAHelper(),
    said({ type: 'ask.resolved', askId: 'ask-1', chosen: 'yes' }),
  ];

  it('says the same about a helper stopped on a form it was told to fill in', () => {
    const asking = said({
      type: 'question.requested',
      requestId: 'q-1',
      blocking: true,
      questions: [{
        id: 'which', header: 'Which one', prompt: 'Which router?',
        selection: 'single' as const,
        options: [{ id: 'a', label: 'app' }, { id: 'b', label: 'pages' }],
        allowCustom: false, secret: false,
      }],
      parentToolCallId: 'call-1',
    });
    const stopped = fold([...answeredTheFirst(), asking]);
    expect(stopped.agents.find((a) => a.id === 'task-1')?.state).toBe('waiting');

    const filled = fold([
      ...answeredTheFirst(),
      asking,
      said({ type: 'question.resolved', requestId: 'q-1', answers: [{ questionId: 'which', optionIds: ['a'] }] }),
    ]);
    expect(filled.agents.find((a) => a.id === 'task-1')?.state).toBe('running');
  });

  it('says the same about a helper stopped on a plan it put up for approval', () => {
    const putUp = said({
      type: 'plan.proposed',
      proposalId: 'plan-1',
      markdown: '1. Read the router',
      actions: [{ id: 'go', kind: 'approve' as const, label: 'Go ahead' }],
      parentToolCallId: 'call-1',
    });
    const stopped = fold([...answeredTheFirst(), putUp]);
    expect(stopped.agents.find((a) => a.id === 'task-1')?.state).toBe('waiting');

    const approved = fold([
      ...answeredTheFirst(),
      putUp,
      said({ type: 'plan.resolved', proposalId: 'plan-1', status: 'approved' as const, actionId: 'go' }),
    ]);
    expect(approved.agents.find((a) => a.id === 'task-1')?.state).toBe('running');
  });

  it('still gives the helper’s own conversation every one of those rows', () => {
    const row = view.agents.find((a) => a.id === 'task-1')!;
    expect(saidBy(view.items, row).map((i) => i.id)).toEqual(['t1', 'h1', 'cmd-ok', 'cmd-bad', 'ask-1']);

    render(<AgentView row={row} items={view.items} sessionId="chat-1" controls={[]} mentions={PLAINLY} onClose={() => {}} />);
    const pane = screen.getByTestId('agent-view-said');
    expect(pane.textContent).toContain('Reading the router first.');
    expect(pane.textContent).toContain('Searched for RailRow');
  });
});

/**
 * The card in the rail, which is where the work went.
 *
 * Its line is read from the helper's own rows rather than from the progress the
 * kit sends about it: the kit reports about twice a minute, and a card a
 * half-minute behind is a card that says a file is being read that was read
 * already.
 */
describe('what the helper’s card says it is doing', () => {
  const EVENTS = aChatWithAHelper();

  /** The chat as it stood the moment that event landed. */
  const asOf = (found: (e: WbpEvent) => boolean): SessionView =>
    live(EVENTS.slice(0, EVENTS.findIndex(found) + 1));

  const startedRunning = (id: string) => (e: WbpEvent) => e.type === 'tool.started' && e.toolCallId === id;

  const cardFor = (view: SessionView, doing: string | null = null): HTMLElement => {
    const row = { ...view.agents.find((a) => a.id === 'task-1')!, doing };
    render(<SentAwayPanel agents={[row]} items={view.items} sessionId="chat-1" controls={[]} />);
    return screen.getByTestId('sent-away-state');
  };

  it('wears the same mark the chat’s own line and the row in the list wear', () => {
    // The chip, not a line of italic text of its own: one vocabulary for what
    // anything in this app is doing, and one component that draws it.
    const chip = cardFor(asOf(startedRunning('cmd-ok')));
    expect(chip.querySelector('[data-testid="chat-state-mark"]')).not.toBeNull();
  });

  it('names the command the helper is running right now', () => {
    // The Grep has started and has not come back.
    const chip = cardFor(asOf(startedRunning('cmd-ok')));
    expect(chip.getAttribute('data-word')).toBe('Running');
    expect(chip.textContent).toContain('Searched for RailRow');
  });

  it('follows the helper on to the next command as the rows arrive', () => {
    const chip = cardFor(asOf(startedRunning('cmd-bad')));
    expect(chip.textContent).toContain('Looked for workbench');
    expect(chip.textContent).not.toContain('Searched for RailRow');
  });

  it('says it is thinking while that is all it is doing', () => {
    const chip = cardFor(asOf((e) => e.type === 'thinking.delta'));
    expect(chip.getAttribute('data-word')).toBe('Thinking');
  });

  it('falls back to the kit’s own last word before the helper has said anything', () => {
    const chip = cardFor(asOf((e) => e.type === 'agent.started'), 'Getting started');
    expect(chip.textContent).toContain('Getting started');
  });

  it('settles when the helper finishes, rather than going blank', () => {
    const finished = live([
      ...aChatWithAHelper(),
      said({
        type: 'agent.finished',
        agentId: 'task-1',
        state: 'done',
        seconds: 50,
        tokens: 9_000,
        calls: 4,
        model: null,
        result: 'The row is in chat-sidebar.tsx.',
      }),
    ]);
    const chip = cardFor(finished);
    expect(chip.getAttribute('data-word')).toBe('Done');
    // And it stops claiming the present tense of a thing that has stopped.
    expect(chip.textContent).not.toContain('Looked for workbench');
  });

  it('counts no seconds of its own, because the row beside it already counts them', () => {
    // Two counts of one agent that disagree by a second is a fault this app has
    // already fixed once (bw-jaoz.6).
    const chip = cardFor(asOf(startedRunning('cmd-ok')));
    expect(chip.textContent).not.toMatch(/\d+s/);
  });
});
