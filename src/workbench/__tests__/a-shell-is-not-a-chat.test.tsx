/**
 * A command opens as the terminal that ran it, never as a conversation
 * (bw-t26l.20).
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
import { render, screen } from '@testing-library/react';
import { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import { AgentView } from '@/workbench/agent-view';
import { commandRun } from '@/workbench/command-run';
import { EMPTY, foldAll, reduce, type SessionView } from '@/workbench/fold';
import type { TerminalRun, WbpEvent } from '@/workbench/protocol';

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
