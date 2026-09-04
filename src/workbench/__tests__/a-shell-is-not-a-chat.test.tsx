/**
 * A command opens as the terminal that ran it, never as a conversation
 * (bw-t26l.20) — and is drawn as a shell on its row, without the two things a
 * shell has never had (bw-sb5g).
 *
 * The terminal belongs to what the row OPENS, and to nothing else. Drawn under
 * every command in the conversation as well, it turned a transcript of a day's
 * work into a column of black rectangles, which is not what was asked for and
 * is not what the conversation is for.
 *
 * The sent-away panel files helpers, plans and commands under one word, and
 * every one of them opened the same pane: a transcript, a "Message subagent"
 * box, and — for a command, which has never said a word to anybody — nothing
 * at all between them. "The UI for the shell has a chat in it" (the manager,
 * 2026-09-04).
 *
 * The terminal here is the real xterm, given the one thing jsdom lacks
 * (`matchMedia`, which the renderer asks for the moment a grid opens), so what
 * these cases put on screen is parsed by the parser that parses it in a
 * browser. What reaches the grid is read off `write`, because jsdom lays
 * nothing out and a grid with no measurable character draws no rows.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import { AgentView } from '@/workbench/agent-view';
import { commandRun } from '@/workbench/command-run';
import { EMPTY, foldAll, reduce, type SessionView } from '@/workbench/fold';
import { isOver, type TerminalRun, type WbpEvent } from '@/workbench/protocol';
import { SentAwayPanel } from '@/workbench/sent-away';
import { TranscriptRow } from '@/workbench/transcript-rows';

const AT = '2026-09-04T09:00:00.000Z';
const PLAINLY: Mentions = { split: (text) => [{ kind: 'text', text }], card: () => null };

let stamped = 0;
type Said<T> = T extends unknown ? Omit<T, 'seq' | 'sessionId' | 'at'> : never;
function said(e: Said<WbpEvent>): WbpEvent {
  stamped += 1;
  return { ...e, seq: stamped, sessionId: 'chat-1', at: AT } as WbpEvent;
}

/** One terminal this app ran itself, as `terminal/create` reports it. */
function ourTerminal(over: Partial<TerminalRun> = {}): TerminalRun {
  return {
    terminalId: 'term-1',
    command: 'cargo test --lib',
    cwd: '/home/dev/app/server',
    output: 'running 3 tests\ntest result: ok.\n',
    truncated: false,
    exitCode: 0,
    signal: null,
    seconds: 12,
    running: false,
    ...over,
  };
}

/**
 * A chat that runs a command in the background, told the way a provider that
 * uses this app's terminals tells it.
 */
function ranACommand(terminal: TerminalRun | null): WbpEvent[] {
  stamped = 0;
  return [
    said({
      type: 'tool.started',
      toolCallId: 'call-1',
      name: 'Bash',
      input: { command: 'cargo test --lib', cwd: '/home/dev/app/server' },
      title: 'cargo test --lib',
      parentToolCallId: null,
    }),
    said({
      type: 'agent.started',
      agentId: 'task-1',
      toolCallId: 'call-1',
      kind: 'command',
      what: 'cargo test --lib',
      agentType: 'shell',
      model: null,
    }),
    said({ type: 'tool.completed', toolCallId: 'call-1', ok: true, output: 'running 3 tests', terminal }),
    said({
      type: 'agent.finished',
      agentId: 'task-1',
      state: 'done',
      result: 'running 3 tests\ntest result: ok.',
      seconds: 12,
      tokens: 0,
      calls: 0,
      model: null,
    }),
  ];
}

function view(events: WbpEvent[]): SessionView {
  return events.reduce(reduce, EMPTY);
}

describe('what a command is read from', () => {
  it('reads this app’s own terminal first, exit code and all', () => {
    const events = ranACommand(ourTerminal());
    // Both folds: a chat read back from the record never sees these events
    // arrive, and a terminal that survived only the live one would leave every
    // reopened chat drawing the poorer reading.
    for (const { agents, items } of [view(events), foldAll(events)]) {
      const { run, outcome } = commandRun(agents[0]!, items, 12);

      expect(run.exitCode).toBe(0);
      expect(run.cwd).toBe('/home/dev/app/server');
      expect(run.output).toContain('test result: ok.');
      // Nothing overrides it: the terminal is ours, so it knows how it ended.
      expect(outcome).toBeUndefined();
    }
  });

  it('still draws a terminal for a provider that ran the shell itself', () => {
    const { agents, items } = view(ranACommand(null));
    const { run, outcome } = commandRun(agents[0]!, items, 12);

    expect(run.command).toBe('cargo test --lib');
    expect(run.cwd).toBe('/home/dev/app/server');
    expect(run.output).toContain('test result: ok.');
    // No exit code exists to read, so the row's own account is what is said,
    // rather than a made-up `exit 0`.
    expect(run.exitCode).toBeNull();
    expect(outcome).toEqual({ word: 'finished', ok: true });
  });

  it('does not print the same output twice when both tellings carry it', () => {
    const { agents, items } = view(ranACommand(null));
    const { run } = commandRun(agents[0]!, items, 12);
    // The call printed `running 3 tests`; the row's result begins with the
    // same line. One reading, the fuller one, reaches the grid.
    expect(run.output).toBe('running 3 tests\ntest result: ok.');
  });

  it('shows the command the call was made with, not the placeholder it opened as', () => {
    // A pending Bash call is titled `Terminal` and carries no arguments; the
    // command line follows a message later, on the call. A terminal that was
    // named before that and never mentioned again — nothing printed, nothing
    // exited — keeps the placeholder unless the call is read.
    const events = ranACommand(ourTerminal({ command: 'Terminal', output: '', seconds: 0 })).slice(0, 3);
    const { agents, items } = view(events);
    const { run } = commandRun(agents[0]!, items, 8);

    expect(run.command).toBe('cargo test --lib');
  });

  it('does not put the launcher’s exit code under a command still running', () => {
    // A backgrounded command: the call that launched it returned at once,
    // exit 0, and the work it started is still going. Read off the pane on
    // 2026-09-04 — the header said `running` and the terminal in it said
    // `✓ exit 0`, about the same `sleep 300`.
    const events = ranACommand(ourTerminal({ output: '', seconds: 0 })).slice(0, 3);
    const { agents, items } = view(events);
    expect(isOver(agents[0]!.state)).toBe(false);

    const { run, outcome } = commandRun(agents[0]!, items, 41);

    expect(run.command).toBe('cargo test --lib');
    expect(run.running).toBe(true);
    // The 0 belongs to whatever put it in the background, not to the command.
    expect(run.exitCode).toBeNull();
    expect(outcome).toBeNull();
    // And the clock the row has been keeping, since the call's own is spent.
    expect(run.seconds).toBe(41);
  });

  it('says how a chat that went to sleep left a terminal of ours still running', () => {
    const events = [
      ...ranACommand(ourTerminal({ running: true, exitCode: null })).slice(0, 3),
      said({ type: 'session.state', state: 'dormant', label: 'Asleep' }),
    ];
    const { agents, items } = view(events);
    const { run, outcome } = commandRun(agents[0]!, items, 30);

    expect(run.running).toBe(true);
    // The terminal cannot know; the row does (`nothingIsDriving`), so the row
    // is what the footer says.
    expect(outcome).toEqual({ word: 'stopped', ok: false });
  });
});

describe('the pane a command opens', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('draws the terminal, and no conversation to have with a shell', () => {
    const written: string[] = [];
    vi.spyOn(Terminal.prototype, 'write').mockImplementation(function wrote(this: Terminal, data: string | Uint8Array) {
      written.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
    });

    const { agents, items } = view(ranACommand(ourTerminal()));
    render(
      <AgentView
        row={agents[0]!}
        items={items}
        sessionId="chat-1"
        controls={['say', 'stop']}
        mentions={PLAINLY}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId('agent-view-shell')).toBeTruthy();
    expect(screen.getByTestId('ran-terminal-command').textContent).toBe('cargo test --lib');
    expect(screen.getByTestId('ran-terminal-cwd').textContent).toContain('/home/dev/app/server');
    expect(screen.getByTestId('ran-terminal-exit').textContent).toContain('exit 0');
    // What the command printed went to the parser, not to a paragraph.
    expect(written.join('')).toContain('test result: ok.');

    // The two things that made it a chat.
    expect(screen.queryByTestId('agent-view-said')).toBeNull();
    expect(screen.queryByTestId('agent-view-relay')).toBeNull();
    // And nothing asked for a transcript that was never going to exist.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('opens a helper on its conversation, exactly as before', () => {
    const events = [
      said({
        type: 'agent.started',
        agentId: 'help-1',
        toolCallId: 'call-9',
        kind: 'helper',
        what: 'find the callers',
        agentType: 'general-purpose',
        model: null,
      }),
      said({ type: 'message.started', messageId: 'h1', role: 'assistant', parentToolCallId: 'call-9' }),
      said({ type: 'text.delta', messageId: 'h1', text: 'Reading the router first.' }),
      said({ type: 'message.completed', messageId: 'h1' }),
    ];
    const { agents, items } = foldAll(events);
    render(
      <AgentView
        row={agents[0]!}
        items={items}
        sessionId="chat-1"
        controls={['say']}
        mentions={PLAINLY}
        onClose={() => {}}
      />,
    );

    expect(screen.getByTestId('agent-view-said')).toBeTruthy();
    expect(screen.queryByTestId('agent-view-shell')).toBeNull();
  });
});

/**
 * What the reader is handed in the rail, before anything is opened.
 *
 * A command spends nothing — this machine runs it, not a model — so the coins
 * beside it always read `0`, and what it "answered" is the tail of its own
 * output, which is two lines torn out of the middle of a build. Both were
 * drawn because the row was written for a helper and a command borrowed it
 * whole (bw-sb5g.2).
 */
describe('the row a command gets in the rail', () => {
  const railFor = (events: WbpEvent[]) => {
    const { agents, items } = foldAll(events);
    render(<SentAwayPanel agents={agents} items={items} sessionId="chat-1" controls={[]} />);
    // Finished work sits behind the control that names how many there are.
    fireEvent.click(screen.getByTestId('toggle-stopped-agents'));
  };

  it('says SHELL, and neither what it cost nor what it answered', () => {
    railFor(ranACommand(ourTerminal()));

    expect(screen.getByTestId('sent-away-row').getAttribute('data-kind')).toBe('command');
    // The word on the row is the thing the reader is looking at. The CSS
    // uppercases it; the word underneath is what is asserted.
    expect(screen.getByTestId('sent-away-kind').textContent).toBe('shell');
    expect(screen.queryByTestId('sent-away-spend')).toBeNull();
    expect(screen.queryByTestId('sent-away-result')).toBeNull();
  });

  it('leaves a helper’s row exactly as it was', () => {
    railFor([
      said({
        type: 'agent.started',
        agentId: 'help-1',
        toolCallId: 'call-9',
        kind: 'helper',
        what: 'find the callers',
        agentType: 'general-purpose',
        model: null,
      }),
      said({
        type: 'agent.finished',
        agentId: 'help-1',
        state: 'done',
        result: 'Three callers, all in the router.',
        seconds: 40,
        tokens: 12_000,
        calls: 3,
        model: null,
      }),
    ]);

    expect(screen.getByTestId('sent-away-kind').textContent).toBe('helper');
    expect(screen.getByTestId('sent-away-spend')).toBeTruthy();
    expect(screen.getByTestId('sent-away-result').textContent).toContain('Three callers');
  });
});

/**
 * And the conversation is left alone (bw-sb5g.1).
 *
 * The same events, folded the same way, drawn by the row the transcript draws
 * with: a command reads as a command in it, with what it printed behind its
 * own click, and no grid mounted anywhere. A terminal under every command in
 * the conversation turned a transcript of a day's work into a column of black
 * rectangles.
 */
describe('the same command in the conversation', () => {
  it('draws no terminal, and keeps the body it always had', () => {
    const { items } = foldAll(ranACommand(ourTerminal()));
    const call = items.find((item) => item.kind === 'tool');
    expect(call, 'the command should be a tool row').toBeTruthy();

    render(<TranscriptRow item={call!} sessionId="chat-1" mentions={PLAINLY} onLook={() => {}} />);

    expect(screen.queryByTestId('ran-terminal')).toBeNull();
    // The row is titled in the app's own words ("Ran the Rust tests"), so the
    // way in is the row itself rather than the command it was made with.
    fireEvent.click(screen.getByRole('button', { name: /Ran the Rust tests/ }));
    expect(screen.getByTestId('tool-output')).toBeTruthy();
  });
});
