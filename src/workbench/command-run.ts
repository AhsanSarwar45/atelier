/**
 * A command a chat sent off, read as the terminal that ran it.
 *
 * The sent-away panel files three different things under one word: a helper
 * with its own conversation, a plan, and a COMMAND. Opening any of them drew
 * the same thing — a chat pane, a "Message subagent" box, and, for a command,
 * an empty transcript, because a command has never said anything to anybody.
 * "The UI for the shell has a chat in it" (the manager, 2026-09-04).
 *
 * A command's pane needs the command, what it printed, where it ran and how it
 * ended. This is where those four are found, in the order of how well they are
 * known:
 *
 * 1. **This app's own terminal** (`terminal/create`, ACP's own way of running a
 *    shell). First-hand: we started the process, so the exit code, the working
 *    directory and every byte are ours to read, and nothing has to be reported
 *    to us. Every provider that speaks ACP can use it — the capability is
 *    advertised to all of them.
 * 2. **The call that sent it**, for a provider that runs its own shell and
 *    tells us about it afterwards. The command and the printed text are
 *    usually there; the exit code never is.
 * 3. **The row itself**, which always has the command in `what` and the last
 *    thing said about it in `doing` or `result`.
 *
 * Nothing here is brand-shaped. A row that only reaches tier 3 is drawn as a
 * terminal with less written on it, not as a chat.
 */
import type { SentAway, TranscriptItem, TranscriptTool } from '@/workbench/fold';
import type { TerminalRun } from '@/workbench/protocol';
import { isOver } from '@/workbench/protocol';

/** How a command ended, in one word and one colour. */
export interface Outcome {
  word: string;
  ok: boolean;
}

/** What to say about a command whose exit status nobody can read. */
const ENDED: Record<string, Outcome> = {
  done: { word: 'finished', ok: true },
  failed: { word: 'failed', ok: false },
  stopped: { word: 'stopped', ok: false },
};

/**
 * The call that sent this row off.
 *
 * By the call id, falling back to the row's own — the same key every other part
 * of this app looks a sent-off agent up by, and the two are different strings
 * (see `saidBy`).
 */
function callThatSent(items: TranscriptItem[], row: Pick<SentAway, 'id' | 'toolCallId'>): TranscriptTool | undefined {
  const sentBy = row.toolCallId ?? row.id;
  return items.find((item): item is TranscriptTool => item.kind === 'tool' && item.id === sentBy);
}

/** A string field of a tool call's input, when it is a string with something in it. */
function said(call: TranscriptTool | undefined, field: string): string {
  const value = call?.input?.[field];
  return typeof value === 'string' && value.trim() !== '' ? value : '';
}

/**
 * What has been printed, without printing any of it twice.
 *
 * A background command reaches here from two directions at once: the call that
 * launched it printed the launch, and the row carries the newest line the kit
 * has said about it. Usually they differ; sometimes the kit's line is the whole
 * output again, and stacking them would show a reader the same build twice and
 * make them wonder which end is current.
 */
function printed(parts: (string | null | undefined)[]): string {
  const kept: string[] = [];
  for (const part of parts) {
    const text = part?.trim();
    if (!text) continue;
    if (kept.some((already) => already.includes(text))) continue;
    // The newer, fuller reading replaces the one it contains rather than
    // following it.
    for (let i = kept.length - 1; i >= 0; i -= 1) if (text.includes(kept[i]!)) kept.splice(i, 1);
    kept.push(text);
  }
  return kept.join('\n');
}

/**
 * The terminal to draw for a sent-off command, and what to say about its end.
 *
 * `outcome` is `undefined` when the terminal itself knows — the pane reads the
 * exit code — and an `Outcome` when only the row does. Null is never returned
 * for a command row: a command with nothing known about it is still a command,
 * and an empty grid under its own command line says that honestly.
 */
export function commandRun(
  row: SentAway,
  items: TranscriptItem[],
  seconds: number,
): { run: TerminalRun; outcome?: Outcome | null } {
  const call = callThatSent(items, row);
  const over = isOver(row.state);
  const ended = ENDED[row.state];

  const told = call?.terminal;
  // A terminal reported by an agent that ran the shell itself carries no
  // clock, and this row has one. Ours carries its own and keeps it.
  const ours = told && told.seconds <= 0 ? { ...told, seconds } : told;
  if (ours) {
    // A terminal of ours that still says "running" in a chat that has stopped
    // is a terminal nobody is left to close — the chat that owned it went away
    // (see `nothingIsDriving`). The row knows that; the terminal cannot.
    if (ours.running || over) return { run: ours, outcome: ours.running && over ? (ended ?? null) : undefined };
    // And the other way round: a finished terminal under a row that is still
    // working. That is a command sent to the background — the call that
    // launched it returned at once, and `sleep 300` did not. The code that
    // call exited with is the launcher's, so putting `exit 0` under a command
    // that is still running would be the screen telling the reader two
    // different things at once (measured against Claude, 2026-09-04: the pane
    // read `running` in its header and `✓ exit 0` on the same terminal).
    return { run: { ...ours, exitCode: null, signal: null, running: true }, outcome: null };
  }

  const command = said(call, 'command') || row.what || call?.title || '';
  return {
    run: {
      terminalId: call?.id ?? row.id,
      command,
      cwd: said(call, 'cwd'),
      output: printed([call?.output, over ? row.result : row.doing]),
      truncated: false,
      // Not ours to know: this provider ran the shell itself and reported words.
      exitCode: null,
      signal: null,
      seconds,
      running: !over,
    },
    outcome: over ? (ended ?? null) : null,
  };
}
