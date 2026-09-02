/**
 * Steering one agent from the screen: the controls, the relay, and the card for
 * a question the agent raised for itself (bw-7ks.22.5).
 *
 * Three tiers of reach and they are not equal (§8.2.7). Two are direct — end
 * it, let it run on — and the third is not: nothing can hand words to an agent
 * that is already running, so what the reader types goes to the chat that sent
 * it, naming it. The pane says so and draws the words as relayed, because a box
 * that looked like a chat with the agent would be a lie the reader only finds
 * out about when the answer never comes.
 *
 * And a control a brand cannot do is not drawn at all rather than drawn dead
 * (decision 13), which is the first thing checked here: the panel is handed no
 * controls and there is nothing to click.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import { AgentView } from '@/workbench/agent-view';
import { asView, foldAll, type SentAway } from '@/workbench/fold';
import type { WbpEvent } from '@/workbench/protocol';
import { SentAwayPanel } from '@/workbench/sent-away';
import { PermissionCard } from '@/workbench/transcript-rows';

/** When all of this happened. */
const OFF = '2026-08-20T09:00:00.000Z';

let stamped = 0;
type Said<T> = T extends unknown ? Omit<T, 'seq' | 'sessionId' | 'at'> : never;
function said(e: Said<WbpEvent>): WbpEvent {
  stamped += 1;
  return { ...e, seq: stamped, sessionId: 'chat-1', at: OFF } as WbpEvent;
}

/** Words, drawn as they are: the pane is not what makes a card a link. */
const PLAINLY: Mentions = { split: (text) => [{ kind: 'text', text }], card: () => null };

/** One helper still running, and whatever else the chat has heard about it. */
function aChatWith(more: WbpEvent[] = []): SentAway[] {
  stamped = 0;
  return foldAll([
    said({
      type: 'agent.started',
      agentId: 'task-1',
      toolCallId: 'call-1',
      kind: 'helper',
      what: 'count the rows',
      agentType: 'general-purpose',
      model: 'claude-fable-5',
    }),
    ...more,
  ]).agents;
}

/** Every command the screen posted, in the order it posted them. */
let posted: Record<string, unknown>[] = [];

beforeEach(() => {
  posted = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { body?: string }) => {
      if (!init?.body) {
        return { ok: true, json: async () => ({ items: [], cursor: null, hasOlder: false }) } as Response;
      }
      posted.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The same screen, with the far end refusing everything it is asked. */
function refusing(why: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { body?: string }) => {
      if (!init?.body) {
        return { ok: true, json: async () => ({ items: [], cursor: null, hasOlder: false }) } as Response;
      }
      posted.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return { ok: false, status: 500, text: async () => JSON.stringify({ error: why }) } as Response;
    }),
  );
}

describe('the controls on a row', () => {
  it('draws none at all for a brand that has none', () => {
    // Hidden, not faked: a button that cannot do the thing written on it is
    // worse than no button.
    render(<SentAwayPanel items={[]} agents={aChatWith()} sessionId="chat-1" controls={[]} onOpen={() => {}} />);

    expect(screen.queryByTestId('sent-away-steer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sent-away-stop')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sent-away-park')).not.toBeInTheDocument();
  });

  it('draws the rows anyway when the controls arrive malformed', () => {
    // The controls list is what the screen was handed, and what it was handed
    // is whatever the running sidecar sent. A value that is not a list is not a
    // reason to lose the panel: the rows are the point, the controls are the
    // trimming, and a chat that cannot say what it can steer can steer nothing
    // (bw-7ks.22.31).
    const view = asView({ menu: { agentControls: null } } as never);
    render(<SentAwayPanel items={[]} agents={aChatWith()} sessionId="chat-1" controls={view.menu.agentControls} onOpen={() => {}} />);

    expect(screen.getByTestId('sent-away-open')).toBeInTheDocument();
    expect(screen.queryByTestId('sent-away-steer')).not.toBeInTheDocument();
  });

  it('draws only the ones the brand named', () => {
    render(<SentAwayPanel items={[]} agents={aChatWith()} sessionId="chat-1" controls={['stop']} onOpen={() => {}} />);

    expect(screen.getByTestId('sent-away-stop')).toBeInTheDocument();
    expect(screen.queryByTestId('sent-away-park')).not.toBeInTheDocument();
  });

  it('draws none on one that has already finished', () => {
    // There is nothing to steer. The row still says what it cost and what it
    // answered; it just cannot be told anything.
    const done = aChatWith([
      said({
        type: 'agent.finished',
        agentId: 'task-1',
        state: 'done',
        result: '412 rows',
        seconds: 20,
        tokens: 4000,
        calls: 1,
        model: 'claude-fable-5',
      }),
    ]);

    render(<SentAwayPanel items={[]} agents={done} sessionId="chat-1" controls={['stop', 'park']} onOpen={() => {}} />);

    expect(screen.queryByTestId('sent-away-steer')).not.toBeInTheDocument();
  });

  it('and no park on one already running in the background', () => {
    const parked = aChatWith([said({ type: 'agent.progress', agentId: 'task-1', seconds: 5, tokens: 100, calls: 1, state: 'parked' })]);

    render(<SentAwayPanel items={[]} agents={parked} sessionId="chat-1" controls={['stop', 'park']} onOpen={() => {}} />);

    expect(screen.getByTestId('sent-away-stop')).toBeInTheDocument();
    expect(screen.queryByTestId('sent-away-park')).not.toBeInTheDocument();
  });

  it('asks about that one agent, not about the chat', async () => {
    render(<SentAwayPanel items={[]} agents={aChatWith()} sessionId="chat-1" controls={['stop', 'park']} onOpen={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sent-away-park'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('sent-away-stop'));
    });

    expect(posted).toEqual([
      { type: 'agent.park', sessionId: 'chat-1', agentId: 'task-1' },
      { type: 'agent.stop', sessionId: 'chat-1', agentId: 'task-1' },
    ]);
  });

  it('says so when the stop does not land', async () => {
    // The one thing that must never look like success. The button comes back to
    // life either way, so without this line a refused stop reads exactly like a
    // stop that worked and the reader walks off believing it is over.
    refusing('the chat is not answering');
    render(<SentAwayPanel items={[]} agents={aChatWith()} sessionId="chat-1" controls={['stop', 'park']} onOpen={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sent-away-stop'));
    });

    const said = screen.getByTestId('sent-away-steer-error').textContent ?? '';
    expect(said).toContain('Not stopped');
    expect(said).toContain('the chat is not answering');
    // And the controls are still there to try again.
    expect(screen.getByTestId('sent-away-stop')).toBeEnabled();
  });

  it('says which one did not land, and forgets it on the next try', async () => {
    refusing('the chat is not answering');
    render(<SentAwayPanel items={[]} agents={aChatWith()} sessionId="chat-1" controls={['stop', 'park']} onOpen={() => {}} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sent-away-park'));
    });
    expect(screen.getByTestId('sent-away-steer-error').textContent).toContain('Not sent to the background');

    // A second attempt that works clears it, rather than leaving a complaint
    // about something that has since happened.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }) as Response),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('sent-away-stop'));
    });
    expect(screen.queryByTestId('sent-away-steer-error')).not.toBeInTheDocument();
  });

  it('and opening it is still one click, with the controls beside it', async () => {
    // The row is one big button and the controls sit next to it, not inside it:
    // nested, every click on Stop would also open the pane.
    const opened: string[] = [];
    render(<SentAwayPanel items={[]} agents={aChatWith()} sessionId="chat-1" controls={['stop']} onOpen={(id) => opened.push(id)} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('sent-away-stop'));
    });
    expect(opened).toEqual([]);

    fireEvent.click(screen.getByTestId('sent-away-open'));
    expect(opened).toEqual(['task-1']);
  });
});

describe('typing something for a running agent', () => {
  const pane = (agents: SentAway[], controls: Parameters<typeof AgentView>[0]['controls']) =>
    render(
      <AgentView row={agents[0]!} items={[]} sessionId="chat-1" controls={controls} mentions={PLAINLY} onClose={() => {}} />,
    );

  it('is not offered by a brand that cannot relay', () => {
    pane(aChatWith(), []);
    expect(screen.queryByTestId('agent-view-relay')).not.toBeInTheDocument();
  });

  it('goes to the chat that sent it, naming which agent it is for', async () => {
    pane(aChatWith(), ['say']);

    fireEvent.change(screen.getByTestId('agent-view-relay-text'), { target: { value: '  only the first column  ' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('agent-view-relay-send'));
    });

    expect(posted).toEqual([{ type: 'agent.say', sessionId: 'chat-1', agentId: 'task-1', text: 'only the first column' }]);
  });

  it('sends nothing on an empty box', () => {
    pane(aChatWith(), ['say']);
    expect(screen.getByTestId('agent-view-relay-send')).toBeDisabled();
    expect(posted).toEqual([]);
  });

  it('says so when the words never left, and keeps them in the box', async () => {
    // Clearing the box is how this pane says the words went. On a refusal it
    // keeps them, so the reader can send them again without retyping.
    refusing('the chat is not answering');
    pane(aChatWith(), ['say']);

    fireEvent.change(screen.getByTestId('agent-view-relay-text'), { target: { value: 'only the first column' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('agent-view-relay-send'));
    });

    const said = screen.getByTestId('agent-view-relay-error').textContent ?? '';
    expect(said).toContain('Not sent');
    expect(said).toContain('the chat is not answering');
    expect(screen.getByTestId('agent-view-relay-text')).toHaveValue('only the first column');
  });

  it('draws what was relayed as relayed, never as said to it', () => {
    const told = aChatWith([said({ type: 'agent.relayed', agentId: 'task-1', text: 'only the first column' })]);
    pane(told, ['say']);

    const shown = screen.getByTestId('agent-view-relayed');
    expect(shown).toHaveAttribute('data-count', '1');
    expect(shown.textContent).toContain('Messages');
    expect(shown.textContent).toContain('only the first column');
    // And it is not in what the agent itself said, because it did not say it.
    expect(screen.getByTestId('agent-view-said').textContent).not.toContain('only the first column');
  });

  it('is not offered once it is over', () => {
    const done = aChatWith([
      said({
        type: 'agent.finished',
        agentId: 'task-1',
        state: 'done',
        result: '412 rows',
        seconds: 20,
        tokens: 4000,
        calls: 1,
        model: 'claude-fable-5',
      }),
    ]);
    pane(done, ['say']);

    expect(screen.queryByTestId('agent-view-relay')).not.toBeInTheDocument();
  });
});

describe('a question the agent raised for itself', () => {
  const card = (extra: { sentBy?: string | null; askedBy?: string | null }) =>
    render(
      <PermissionCard
        sessionId="chat-1"
        askId="ask-1"
        title="Bash: wc -l rows.csv"
        toolName="Bash"
        options={[{ id: 'allow_once', label: 'Allow once', kind: 'allow_once' }]}
        chosen={null}
        {...extra}
      />,
    );

  it('says which agent is asking, so the reader is not answering for the chat', () => {
    card({ sentBy: 'call-1', askedBy: 'count the rows' });

    expect(screen.getByTestId('permission-asked-by')).toHaveTextContent('Asked by count the rows');
    expect(screen.getByTestId('permission-card')).toHaveAttribute('data-sent-by', 'call-1');
  });

  it('still says an agent is asking when it has no brief to name', () => {
    card({ sentBy: 'call-1', askedBy: null });
    expect(screen.getByTestId('permission-asked-by')).toHaveTextContent('an agent this chat sent off');
  });

  it('and says nothing of the sort about the chat’s own question', () => {
    card({ sentBy: null, askedBy: null });

    expect(screen.queryByTestId('permission-asked-by')).not.toBeInTheDocument();
    expect(screen.getByTestId('permission-card')).not.toHaveAttribute('data-sent-by');
  });
});
