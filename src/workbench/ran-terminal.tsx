/**
 * A command an agent ran, drawn as the terminal that ran it.
 *
 * Not a conversation. A shell is a command, a stream of characters, and a way
 * it ended, and the app drew all three as a paragraph of grey text under a
 * chat row: the command's own output flattened into words, no exit code, no
 * cwd, and — for work sent to the background — a pane whose only content was a
 * transcript with nothing in it. "The UI for the shell has a chat in it"
 * (the manager, 2026-09-04).
 *
 * ## Where the facts come from
 *
 * ACP's own terminals (`terminal/create`, `terminal/output`,
 * `terminal/wait_for_exit`), which every provider speaks and which this app
 * serves itself. The agent asks US to run the command, so this side owns the
 * process: the command line, the directory, the bytes and the exit status are
 * all first-hand rather than reported. Nothing here is Claude-shaped, and a
 * row cannot hang waiting for a provider to remember to say a command
 * finished — the thing that finished it is us.
 *
 * ## Why xterm and not a `<pre>`
 *
 * Because output is not text. It is bytes with escape sequences in them: a
 * build that paints its errors red, a test runner that rewrites its own
 * progress line, a `\r` that means "start this line again". Put that in a
 * `<pre>` and the reader gets `[0;31m` sprayed through it and every rewritten
 * line stacked one under the next. The app already has the parser that gets
 * this right and already ships the font that draws it (terminal-pane.tsx);
 * this is the same grid with nobody typing into it.
 */
'use client';

import { useEffect, useRef } from 'react';

import { Terminal } from '@xterm/xterm';
import { Check, Clock, Folder, X } from 'lucide-react';

import { Panel } from '@/components/ui/panel';
import { cn } from '@/lib/utils';
import type { Outcome } from '@/workbench/command-run';
import { forHowLong } from '@/workbench/elapsed';
import type { TerminalRun } from '@/workbench/protocol';

import '@xterm/xterm/css/xterm.css';

/** The same face the app's live terminals are drawn in, for the same reasons. */
const GRID_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "Symbols Nerd Font Mono", monospace';

/**
 * How the command ended, in the one word a reader wants first.
 *
 * A signal beats an exit code because a killed command has no exit code to
 * report — the pair is exclusive, not a fallback — and zero is drawn as
 * nothing at all: every command that works exits zero, and a green tick beside
 * every successful line is a screen that has stopped saying anything.
 */
export function howItEnded(run: TerminalRun): Outcome | null {
  if (run.running) return null;
  if (run.signal) return { word: run.signal, ok: false };
  if (run.exitCode === null) return { word: 'ended', ok: true };
  return { word: run.exitCode === 0 ? 'exit 0' : `exit ${run.exitCode}`, ok: run.exitCode === 0 };
}

/**
 * The grid, fed only what it has not already been given.
 *
 * Output arrives as the whole tail every time, because that is what the client
 * holds — so writing all of it on each update would repaint the command from
 * the top a few times a second, and the reader would never see the bottom of
 * a build. Only the new suffix is written.
 *
 * When the new text is NOT an extension of what was drawn, the head has been
 * dropped to stay inside the byte cap, and the only honest thing is to clear
 * and draw what there is: pretending the missing middle is still above would
 * put a build's errors under the wrong command.
 */
function useGrid(run: TerminalRun, rows: number) {
  const host = useRef<HTMLDivElement | null>(null);
  const term = useRef<Terminal | null>(null);
  const written = useRef('');

  useEffect(() => {
    const box = host.current;
    if (!box) return;
    // No theme, so the sixteen ANSI colours stay the ones the programs inside
    // drew with. Repainting them for the app's own scale makes half of them
    // unreadable, which is the note terminal-pane.tsx already carries.
    const grid = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      fontFamily: GRID_FONT,
      fontSize: 12,
      rows,
      scrollback: 5000,
    });
    grid.open(box);
    term.current = grid;
    written.current = '';
    return () => {
      term.current = null;
      grid.dispose();
    };
  }, [rows]);

  useEffect(() => {
    const grid = term.current;
    if (!grid) return;
    const now = run.output;
    if (now.startsWith(written.current)) {
      const fresh = now.slice(written.current.length);
      if (fresh) grid.write(fresh);
    } else {
      grid.reset();
      grid.write(now);
    }
    written.current = now;
  }, [run.output]);

  return host;
}

export function RanTerminal({
  run,
  rows = 12,
  outcome,
  className,
}: {
  run: TerminalRun;
  /** How tall the grid is, in lines. The row uses fewer than a whole pane does. */
  rows?: number;
  /**
   * What to say instead of the exit status, when something outside the terminal
   * knows better how this ended.
   *
   * A command drawn from a provider that does not use this app's terminals has
   * no exit code to read — what it has is the chat's own account of the row
   * ("stopped", "the chat went to sleep"), and printing `ended` over that would
   * throw away the only thing anybody knows.
   */
  outcome?: Outcome | null;
  className?: string;
}) {
  const host = useGrid(run, rows);
  const ended = outcome === undefined ? howItEnded(run) : outcome;

  return (
    <Panel
      inset="none"
      data-testid="ran-terminal"
      data-running={run.running ? 'yes' : 'no'}
      data-exit-code={run.exitCode ?? ''}
      className={cn('overflow-hidden', className)}
    >
      {/* The command, on a prompt, because that is the one line that says what
          the reader is looking at. Selectable: the commonest thing anybody
          wants from a command an agent ran is to run it again themselves. */}
      <div className="flex items-start gap-2 border-b border-border/60 px-2 py-1.5">
        <span aria-hidden="true" className="shrink-0 select-none pt-px font-mono text-xs text-success">
          $
        </span>
        <code
          data-testid="ran-terminal-command"
          className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs text-foreground"
        >
          {run.command}
        </code>
      </div>

      {/* The head is gone when the output outgrew its cap, and that is said
          where the missing part would be rather than at the bottom, so a
          reader scrolling up meets the notice before they draw a conclusion
          from a line that has no beginning. */}
      {run.truncated && (
        <p data-testid="ran-terminal-truncated" className="px-2 pt-1 font-mono text-[11px] text-warning">
          … earlier output dropped
        </p>
      )}

      <div data-testid="ran-terminal-grid" ref={host} className="px-1 py-1" />

      <div className="flex flex-wrap items-center gap-3 border-t border-border/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
        {/* Only when it is known. A provider that runs its own shell tells us
            the command and the output and nothing else, and an empty folder
            icon is a claim that it ran in no directory. */}
        {run.cwd && (
          <span data-testid="ran-terminal-cwd" className="flex min-w-0 items-center gap-1" title={run.cwd}>
            <Folder className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{run.cwd}</span>
          </span>
        )}
        {/* Only when somebody counted. A provider that ran the shell itself
            never said how long it took, and `0s` under a build that took four
            minutes is worse than no clock at all. */}
        {run.seconds > 0 && (
          <span className="flex shrink-0 items-center gap-1" data-testid="ran-terminal-for">
            <Clock className="h-3 w-3" aria-hidden="true" />
            {forHowLong(run.seconds)}
          </span>
        )}
        {ended ? (
          <span
            data-testid="ran-terminal-exit"
            className={cn('flex shrink-0 items-center gap-1', ended.ok ? 'text-success' : 'text-danger')}
          >
            {ended.ok ? <Check className="h-3 w-3" aria-hidden="true" /> : <X className="h-3 w-3" aria-hidden="true" />}
            {ended.word}
          </span>
        ) : (
          <span data-testid="ran-terminal-running" className="shrink-0 text-foreground/70">
            running
          </span>
        )}
      </div>
    </Panel>
  );
}
