/**
 * One sent-off agent's own conversation, opened from its row (bw-7ks.22.4).
 *
 * The claim is that nothing is remembered and nothing is fetched: an agent's
 * conversation is the chat's own conversation read by who said it. So the same
 * events are folded both ways — the live tail and a replay of the whole log —
 * and the pane is built from each, because "the same after a restart" is
 * exactly the difference between those two paths (§4).
 *
 * The main agent's own words are in the fixture on purpose. A pane that showed
 * everything would look right on a chat with one helper and be useless on a
 * chat with four.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import { AgentView, saidBy } from '@/workbench/agent-view';
import { EMPTY, foldAll, reduce, type SessionView } from '@/workbench/fold';
import { SentAwayPanel } from '@/workbench/sent-away';
import type { WbpEvent } from '@/workbench/protocol';

/** When all of this happened. */
const OFF = '2026-08-20T09:00:00.000Z';

let stamped = 0;
type Said<T> = T extends unknown ? Omit<T, 'seq' | 'sessionId' | 'at'> : never;
function said(e: Said<WbpEvent>): WbpEvent {
  stamped += 1;
  return { ...e, seq: stamped, sessionId: 'chat-1', at: OFF } as WbpEvent;
}

/** Words, drawn as they are: the pane is not what makes a card a link. */
const PLAINLY: Mentions = { split: (text) => [{ kind: 'text', text }], card: () => null, report: () => null };

/**
 * A chat that says something itself, sends two helpers away, and hears from
 * both of them.
 */
function aChatWithTwoHelpers(): WbpEvent[] {
  stamped = 0;
  return [
    said({ type: 'message.started', messageId: 'm1', role: 'assistant' }),
    said({ type: 'text.delta', messageId: 'm1', text: 'Sending two helpers off.' }),
    said({ type: 'message.completed', messageId: 'm1' }),

    said({
      type: 'agent.started',
      agentId: 'task-1',
      toolCallId: 'call-1',
      kind: 'helper',
      what: 'find the callers',
      agentType: 'general-purpose',
      model: 'claude-opus-4-5-20251101',
    }),
    said({
      type: 'agent.started',
      agentId: 'task-2',
      toolCallId: 'call-2',
      kind: 'helper',
      what: 'read the tests',
      agentType: 'general-purpose',
      model: 'claude-sonnet-4-5-20250929',
    }),

    // The first helper: its reasoning, its words, and a command of its own.
    said({ type: 'thinking.delta', messageId: 't1', text: 'Where would a caller live', parentToolCallId: 'call-1' }),
    said({ type: 'message.completed', messageId: 't1' }),
    said({ type: 'message.started', messageId: 'h1', role: 'assistant', parentToolCallId: 'call-1' }),
    said({ type: 'text.delta', messageId: 'h1', text: 'Reading the router first.' }),
    said({ type: 'message.completed', messageId: 'h1' }),
    said({
      type: 'tool.started',
      toolCallId: 'cmd-1',
      name: 'Bash',
      input: { command: 'rg useSession' },
      title: 'rg useSession',
      parentToolCallId: 'call-1',
    }),
    said({ type: 'tool.completed', toolCallId: 'cmd-1', ok: true, output: 'four callers' }),

    // The second helper, so the pane has something to leave out.
    said({ type: 'message.started', messageId: 'h2', role: 'assistant', parentToolCallId: 'call-2' }),
    said({ type: 'text.delta', messageId: 'h2', text: 'The tests are green.' }),
    said({ type: 'message.completed', messageId: 'h2' }),

    said({ type: 'agent.progress', agentId: 'task-1', seconds: 92, tokens: 20_100, calls: 6 }),
    said({
      type: 'agent.finished',
      agentId: 'task-1',
      state: 'done',
      seconds: 92,
      tokens: 20_100,
      calls: 6,
      model: null,
      result: 'Four callers, all in the workbench.',
    }),
  ];
}

/** The same events down the live tail, one at a time. */
function live(events: WbpEvent[]): SessionView {
  return events.reduce(reduce, EMPTY);
}

const bothWays: [string, (events: WbpEvent[]) => SessionView][] = [
  ['watched live', live],
  ['read back off the record', foldAll],
];

describe.each(bothWays)('a chat %s', (_name, fold) => {
  const view = fold(aChatWithTwoHelpers());

  it('gives each helper its own conversation, and neither of them the chat’s', () => {
    // Asked by the ROW, which is what the pane has: the kit gives a helper an
    // id of its own and stamps its words with the call that sent it instead.
    const first = saidBy(view.items, view.agents.find((a) => a.id === 'task-1')!);
    const second = saidBy(view.items, view.agents.find((a) => a.id === 'task-2')!);

    // Its reasoning, its words and its command — and nothing else's.
    expect(first.map((i) => i.kind)).toEqual(['thinking', 'message', 'tool']);
    expect(second.map((i) => i.kind)).toEqual(['message']);

    const words = (items: typeof first) =>
      items.flatMap((i) => (i.kind === 'message' || i.kind === 'thinking' ? [i.text] : []));
    expect(words(first).join(' ')).toContain('Reading the router');
    expect(words(first).join(' ')).not.toContain('The tests are green');
    expect(words(second).join(' ')).not.toContain('Sending two helpers off');
  });

  it('does not confuse a helper’s own id with the call that sent it', () => {
    const row = view.agents.find((a) => a.id === 'task-1')!;
    expect(row.toolCallId, 'the fixture no longer tells the two apart').not.toBe(row.id);
    // Read by the agent's own id — the mistake — the pane is empty.
    expect(saidBy(view.items, { id: row.id, toolCallId: null })).toEqual([]);
    expect(saidBy(view.items, row).length).toBe(3);
  });

  it('leaves the chat’s own words to the chat', () => {
    const mine = view.items.filter((i) => !('parentId' in i) || i.parentId === null);
    expect(mine.some((i) => i.kind === 'message' && i.text.includes('Sending two helpers off'))).toBe(true);
  });

  it('draws that agent’s conversation, its numbers and its answer', () => {
    const row = view.agents.find((a) => a.id === 'task-1')!;
    render(<AgentView row={row} items={view.items} sessionId="chat-1" controls={[]} mentions={PLAINLY} onClose={() => {}} />);

    expect(screen.getByTestId('agent-view-what')).toHaveTextContent('find the callers');
    expect(screen.getByTestId('agent-view-model')).toHaveTextContent('opus-4-5');
    expect(screen.getByTestId('agent-view-for')).toHaveTextContent('1m 32s');
    expect(screen.getByTestId('agent-view-spend')).toHaveTextContent('20k');
    expect(screen.getByTestId('agent-view-state')).toHaveTextContent('done');
    expect(screen.getByTestId('agent-view-result')).toHaveTextContent('Four callers');

    // Its own words are there, the other helper's are not, and neither are the
    // chat's — which is the whole difference between this and the transcript.
    const said = screen.getByTestId('agent-view-said');
    expect(said.textContent).toContain('Reading the router first.');
    expect(said.textContent).not.toContain('The tests are green.');
    expect(said.textContent).not.toContain('Sending two helpers off.');
    expect(screen.getByTestId('agent-view').getAttribute('data-said')).toBe('3');
  });
});

describe('the pane itself', () => {
  const view = live(aChatWithTwoHelpers());

  it('says so plainly when the agent has not said anything yet', () => {
    const row = { ...view.agents.find((a) => a.id === 'task-2')!, state: 'running' as const };
    render(
      <AgentView
        row={{ ...row, id: 'nobody', toolCallId: 'nobody' }}
        items={view.items}
        sessionId="chat-1"
        controls={[]}
        mentions={PLAINLY}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('agent-view-nothing')).toBeInTheDocument();
  });

  it('counts a running agent off the same clock as the row that was clicked', () => {
    // The kit reports about twice a minute, so between reports its own count is
    // stale and the row counts on by itself. A pane reading the raw count said
    // `0s` beside a row reading `2s` — one agent, two accounts of it.
    const row = {
      ...view.agents.find((a) => a.id === 'task-1')!,
      state: 'running' as const,
      seconds: 2,
      startedAt: Date.now() - 30_000,
    };
    const { unmount } = render(<SentAwayPanel items={[]} agents={[row]} sessionId="chat-1" controls={[]} />);
    const onTheRow = screen.getByTestId('sent-away-for').textContent;
    unmount();

    render(<AgentView row={row} items={view.items} sessionId="chat-1" controls={[]} mentions={PLAINLY} onClose={() => {}} />);
    expect(screen.getByTestId('agent-view-for').textContent).toBe(onTheRow);
    expect(onTheRow).toBe('30s');
  });

  it('reads one second, not two, when the row and the pane are on screen together', () => {
    // A pane is opened by a click, and a click never lands on the instant the
    // row was drawn on. With a clock each, the two round to different numbers
    // and one agent has two ages on one screen.
    vi.useFakeTimers();
    try {
      const row = {
        ...view.agents.find((a) => a.id === 'task-1')!,
        state: 'running' as const,
        seconds: 2,
        startedAt: Date.now() - 30_000,
      };
      render(<SentAwayPanel items={[]} agents={[row]} sessionId="chat-1" controls={[]} />);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      render(<AgentView row={row} items={view.items} sessionId="chat-1" controls={[]} mentions={PLAINLY} onClose={() => {}} />);

      expect(screen.getByTestId('agent-view-for').textContent).toBe(screen.getByTestId('sent-away-for').textContent);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes on the button, on the ground behind it and on the key a reader tries first', () => {
    const shut = vi.fn();
    const row = view.agents.find((a) => a.id === 'task-1')!;
    const { unmount } = render(
      <AgentView row={row} items={view.items} sessionId="chat-1" controls={[]} mentions={PLAINLY} onClose={shut} />,
    );

    screen.getByTestId('agent-view-close').click();
    expect(shut).toHaveBeenCalledTimes(1);

    // The ground behind it, and not the pane itself: a click inside must not
    // shut what it was aimed at.
    screen.getByTestId('agent-view-said').click();
    expect(shut).toHaveBeenCalledTimes(1);
    screen.getByTestId('agent-view').click();
    expect(shut).toHaveBeenCalledTimes(2);

    // At whatever holds focus, which is where a browser puts a key press: the
    // shell listens on the page rather than on the window (bw-dks8.10).
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(shut).toHaveBeenCalledTimes(3);

    // And it stops listening on the way out.
    unmount();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(shut).toHaveBeenCalledTimes(3);
  });
});
