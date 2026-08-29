import type { ModelChoice } from '../../../src/workbench/protocol.ts';

import type { ClaudeModelRow } from './claude.ts';

/**
 * One model this Claude install answers to but does not advertise.
 *
 * `supportedModels()` names six rows and no more: the aliases that follow
 * whatever was released last, plus a default. The install itself recognises
 * fourteen models and takes any of them by name, so a reader who wants the Opus
 * he was working with last month has no way to ask for it — the menu simply
 * does not contain it (bw-xtic.2).
 *
 * What is written here is that install's own register, read out of the copy
 * under `~/.local/share/claude/versions`: the name it prints, the levels it
 * says the model reasons at, and the window it gives. Nothing is guessed. When
 * a newer install ships a new model, this list is what has to be caught up.
 */
export type ClaudeCatalogEntry = {
  /** The name the install is given on the command line. */
  id: string;
  displayName: string;
  /** What it is for, in the one line the picker has room for. */
  description: string;
  /** The levels it reasons at, in order. Empty when it takes no direction. */
  effortLevels: string[];
  /**
   * The day the install itself says this model reaches end of life, as
   * `YYYY-MM-DD`. Absent for a model with no date against it.
   *
   * Kept as a date rather than as a finished sentence because the day it stops
   * working arrives whether or not anyone edits this file: a model dated in the
   * future is offered, the same entry answers for itself once the day passes,
   * and nobody has to notice.
   */
  endOfLife?: string;
  /** Why it cannot be picked here, for a reason no date accounts for. */
  unavailable?: string;
};

/**
 * The levels, as the install works them out.
 *
 * It starts from all five and takes away what a model cannot do: `xhigh` from
 * everything before Opus 4.7, Sonnet 4.6 and Fable 5; `max` from everything
 * before Opus 4.6; and every level at all from the handful it names outright —
 * Opus 4 and 4.1, Sonnet 4 and 4.5, Haiku 4.5. Opus 4.5 is on none of those
 * lists but the first two, which is why it keeps three.
 */
const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_XHIGH = ['low', 'medium', 'high', 'max'];
const PLAIN = ['low', 'medium', 'high'];
const NONE: string[] = [];

/**
 * Every model the install recognises, strongest first within each family.
 *
 * The dates come from the install's own end-of-life register, the one it reads
 * to print "is deprecated and will reach end-of-life on …" — so a model shuts
 * here on the day it stops answering there, not on the day someone remembers.
 * Mythos is shut for a reason no date accounts for: it is served only to an
 * invited organisation.
 *
 * All of them are listed rather than hidden, so that a reader looking for a
 * model he remembers finds out what became of it, instead of finding nothing
 * and doubting the menu.
 */
export const CLAUDE_MODEL_CATALOG: ClaudeCatalogEntry[] = [
  { id: 'claude-fable-5', displayName: 'Fable 5', effortLevels: ALL,
    description: 'Most capable, for the hardest and longest-running work · 1M context' },
  { id: 'claude-opus-5', displayName: 'Opus 5', effortLevels: ALL,
    description: 'Best for everyday, complex work · 1M context' },
  { id: 'claude-opus-4-8', displayName: 'Opus 4.8', effortLevels: ALL,
    description: 'The strongest of the Opus 4 series · 1M context' },
  { id: 'claude-opus-4-7', displayName: 'Opus 4.7', effortLevels: ALL,
    description: 'The Opus before 4.8 · 1M context' },
  { id: 'claude-opus-4-6', displayName: 'Opus 4.6', effortLevels: NO_XHIGH,
    description: 'Older Opus, still served · 200K context' },
  { id: 'claude-opus-4-5', displayName: 'Opus 4.5', effortLevels: PLAIN,
    description: 'The last Opus that reasons at three levels rather than five · 200K context' },
  { id: 'claude-opus-4-1', displayName: 'Opus 4.1', effortLevels: NONE,
    description: 'The Opus that followed 4 · 200K context',
    endOfLife: '2026-08-05' },
  { id: 'claude-opus-4-0', displayName: 'Opus 4', effortLevels: NONE,
    description: 'The first Opus 4 · 200K context',
    endOfLife: '2026-06-15' },
  { id: 'claude-sonnet-5', displayName: 'Sonnet 5', effortLevels: ALL,
    description: 'Near-Opus quality at Sonnet speed · 1M context' },
  { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', effortLevels: NO_XHIGH,
    description: 'The Sonnet before 5 · 200K context' },
  { id: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5', effortLevels: NONE,
    description: 'Older Sonnet, still served · 200K context' },
  { id: 'claude-sonnet-4-0', displayName: 'Sonnet 4', effortLevels: NONE,
    description: 'The first Sonnet 4 · 200K context',
    endOfLife: '2026-06-15' },
  { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5', effortLevels: NONE,
    description: 'Fastest, for quick answers · 200K context' },
  { id: 'claude-mythos-5', displayName: 'Mythos 5', effortLevels: ALL,
    description: 'Fable 5 under another name · 1M context',
    unavailable: 'Project Glasswing only' },
];

/** The catalogued versions this install did not already name for itself. */
function unannounced(announced: ClaudeModelRow[]): ClaudeCatalogEntry[] {
  const named = new Set(announced.map((row) => row.value));
  return CLAUDE_MODEL_CATALOG.filter((entry) => !named.has(entry.id));
}

/**
 * The rows the rest of the driver reasons about: what the install announced,
 * then every version it did not.
 *
 * The effort picker reads its levels off the row belonging to the model in use,
 * so a version picked from the lower band has to have a row of its own — or
 * choosing Opus 4.8 would silently take the levels of whatever sits first in
 * the list (bw-1jfs).
 */
export function claudeModelRows(announced: ClaudeModelRow[]): ClaudeModelRow[] {
  return [
    ...announced,
    ...unannounced(announced).map((entry) => ({
      value: entry.id,
      resolvedModel: entry.id,
      displayName: entry.displayName,
      description: entry.description,
      supportsEffort: entry.effortLevels.length > 0,
      supportedEffortLevels: entry.effortLevels,
    })),
  ];
}

/** The day a date names, read as UTC so a timezone cannot move it. */
function day(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/**
 * Why this model cannot be picked today, or nothing if it can.
 *
 * A date in the future is not a reason: the model still answers until the day
 * arrives, and saying so early would take a working model off the reader.
 */
function shutBecause(entry: ClaudeCatalogEntry, now: Date): string | undefined {
  if (entry.unavailable) return entry.unavailable;
  if (!entry.endOfLife || now.getTime() < day(entry.endOfLife)) return undefined;
  const gone = new Date(day(entry.endOfLife)).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  return `Reached end of life on ${gone}`;
}

/**
 * The menu the picker draws: the aliases the install named, each pinned to
 * whatever it released last, and beneath them every numbered version.
 *
 * The two bands answer different questions — "give me the current Opus" and
 * "give me Opus 4.6" — so they are marked apart and the picker rules a line
 * between them.
 *
 * `now` is an argument so a case can stand either side of a model's last day
 * without waiting for it; nothing but a test passes one.
 */
export function claudeModelMenu(announced: ClaudeModelRow[], now: Date = new Date()): ModelChoice[] {
  return [
    ...announced.map((row) => ({
      value: row.value,
      displayName: row.displayName,
      description: row.description,
      group: 'alias' as const,
    })),
    ...unannounced(announced).map((entry) => {
      const shut = shutBecause(entry, now);
      return {
        value: entry.id,
        displayName: entry.displayName,
        description: entry.description,
        group: 'version' as const,
        ...(shut ? { unavailable: shut } : {}),
      };
    }),
  ];
}
