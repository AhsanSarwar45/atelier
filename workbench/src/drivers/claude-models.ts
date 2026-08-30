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
 * Everything here is read out of that install's own register, in the copy under
 * `~/.local/share/claude/versions`. The register holds no description text, so
 * this type holds none either: what a row says about itself is composed from
 * the three facts the register does keep, the same way for every model. The
 * earlier free-text line was prose nobody had sourced — "The Opus before 4.8",
 * "Older Opus, still served" — and there is now nowhere to put another
 * (bw-xtic.5).
 */
export type ClaudeCatalogEntry = {
  /** The name the install is given on the command line. */
  id: string;
  displayName: string;
  /** The window it takes, in tokens, from the register's `context.window`. */
  contextWindow: number;
  /**
   * Dollars per million tokens, input then output, from the price tier the
   * register names for this model — `tier_5_25` is `[5, 25]`.
   *
   * This is a rate, not a rate-limit weighting. The register publishes no
   * cross-model usage multiplier, so none is shown.
   */
  price: [number, number];
  /** How far its training runs, in the register's own words. */
  knowledgeCutoff: string;
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
 * The register's price tiers, by the names it gives them.
 *
 * Written as tiers rather than as a pair per model because that is how the
 * register writes them: eleven models share five tiers between them, and a
 * repriced tier is one edit here rather than five.
 */
const TIER_5_25: [number, number] = [5, 25];
const TIER_10_50: [number, number] = [10, 50];
const TIER_15_75: [number, number] = [15, 75];
const TIER_3_15: [number, number] = [3, 15];
const TIER_2_10: [number, number] = [2, 10];
const HAIKU_45: [number, number] = [1, 5];

/** The windows, as the register spells them. */
const M1 = 1e6;
const K200 = 200_000;

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
    contextWindow: M1, price: TIER_10_50, knowledgeCutoff: 'January 2026' },
  { id: 'claude-opus-5', displayName: 'Opus 5', effortLevels: ALL,
    contextWindow: M1, price: TIER_5_25, knowledgeCutoff: 'May 2026' },
  { id: 'claude-opus-4-8', displayName: 'Opus 4.8', effortLevels: ALL,
    contextWindow: M1, price: TIER_5_25, knowledgeCutoff: 'January 2026' },
  { id: 'claude-opus-4-7', displayName: 'Opus 4.7', effortLevels: ALL,
    contextWindow: M1, price: TIER_5_25, knowledgeCutoff: 'January 2026' },
  { id: 'claude-opus-4-6', displayName: 'Opus 4.6', effortLevels: NO_XHIGH,
    contextWindow: K200, price: TIER_5_25, knowledgeCutoff: 'May 2025' },
  { id: 'claude-opus-4-5', displayName: 'Opus 4.5', effortLevels: PLAIN,
    contextWindow: K200, price: TIER_5_25, knowledgeCutoff: 'May 2025' },
  { id: 'claude-opus-4-1', displayName: 'Opus 4.1', effortLevels: NONE,
    contextWindow: K200, price: TIER_15_75, knowledgeCutoff: 'January 2025',
    endOfLife: '2026-08-05' },
  { id: 'claude-opus-4-0', displayName: 'Opus 4', effortLevels: NONE,
    contextWindow: K200, price: TIER_15_75, knowledgeCutoff: 'January 2025',
    endOfLife: '2026-06-15' },
  { id: 'claude-sonnet-5', displayName: 'Sonnet 5', effortLevels: ALL,
    contextWindow: M1, price: TIER_2_10, knowledgeCutoff: 'January 2026' },
  { id: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', effortLevels: NO_XHIGH,
    contextWindow: K200, price: TIER_3_15, knowledgeCutoff: 'August 2025' },
  { id: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5', effortLevels: NONE,
    contextWindow: K200, price: TIER_3_15, knowledgeCutoff: 'January 2025' },
  { id: 'claude-sonnet-4-0', displayName: 'Sonnet 4', effortLevels: NONE,
    contextWindow: K200, price: TIER_3_15, knowledgeCutoff: 'January 2025',
    endOfLife: '2026-06-15' },
  { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5', effortLevels: NONE,
    contextWindow: K200, price: HAIKU_45, knowledgeCutoff: 'February 2025' },
  { id: 'claude-mythos-5', displayName: 'Mythos 5', effortLevels: ALL,
    contextWindow: M1, price: TIER_10_50, knowledgeCutoff: 'January 2026',
    unavailable: 'Project Glasswing only' },
];

/** A window the way the install writes one: `1M`, `200K`. */
function windowOf(tokens: number): string {
  return tokens >= 1e6 ? `${tokens / 1e6}M` : `${tokens / 1000}K`;
}

/**
 * What a million tokens cost, in and out.
 *
 * The ask was for a relative figure — "3x usage" — but neither install
 * publishes one, and the only cross-model multiplier in the Claude binary
 * measures context rather than cost ("5x more context"). Inventing a baseline
 * to divide by would put an opinion back where this card took one out, so what
 * is shown is the register's own rate.
 */
export function perMtok(entry: ClaudeCatalogEntry): string {
  const [input, output] = entry.price;
  return `$${input}/$${output} per Mtok`;
}

/**
 * What a version says about itself: the three facts the register keeps, in the
 * same order for every model, and nothing else.
 *
 * The rate goes on a line of its own. Written as one run of text it wrapped
 * anyway in a 288px menu, and wrapped at a separator, so every row opened its
 * second line on a stray dot (bw-xtic.10). Breaking it deliberately costs no
 * height — the line was already two — and puts the rates in a column the eye
 * can run down, which is what asking to see the cost was asking for.
 */
export function describeModel(entry: ClaudeCatalogEntry): string {
  return `${windowOf(entry.contextWindow)} context · Knowledge to ${entry.knowledgeCutoff}\n${perMtok(entry)}`;
}

/** The catalogued versions this install did not already name for itself. */
function unannounced(announced: ClaudeModelRow[]): ClaudeCatalogEntry[] {
  const named = new Set(announced.map((row) => row.value));
  return CLAUDE_MODEL_CATALOG.filter((entry) => !named.has(entry.id));
}

/**
 * The catalogued model an alias resolves to, whatever spelling it resolved to.
 *
 * The install pins an alias to a dated build and may add a window suffix —
 * `claude-haiku-4-5-20251001`, `claude-opus-5[1m]` — neither of which is a
 * catalogue id, so both are taken off before the lookup.
 */
function catalogued(resolved: string | undefined): ClaudeCatalogEntry | undefined {
  if (!resolved) return undefined;
  const bare = resolved.replace(/\[1m\]$/, '').replace(/-\d{8}$/, '');
  return CLAUDE_MODEL_CATALOG.find((entry) => entry.id === bare);
}

/** A rate the install already ran into the end of its own sentence. */
const TRAILING_RATE = /\s*·\s*(\$[\d.]+\/\$[\d.]+ per Mtok)$/;

/**
 * An alias keeps the words the install gave it, with its rate on a line of its
 * own.
 *
 * The install prices its aliases itself — 2.1.250 builds each description as
 * `<model> · <blurb> · $in/$out per Mtok` — so in the ordinary case there is
 * nothing to add and nothing to look up. All this does is break that last
 * clause onto its own line, so an alias reads the way a version does and the
 * rates stand in one column (bw-xtic.10).
 *
 * An alias the install left unpriced is priced from the catalogue when the
 * model it points at is one we know, and left exactly as it came when it is
 * not — a line nothing backs is worse than a line that says less.
 */
function pricedAlias(row: ClaudeModelRow): string | undefined {
  const said = row.description?.replace(TRAILING_RATE, '\n$1');
  if (said?.includes('per Mtok')) return said;
  const entry = catalogued(row.resolvedModel);
  if (!entry) return said;
  return said ? `${said}\n${perMtok(entry)}` : perMtok(entry);
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
      description: describeModel(entry),
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
      description: pricedAlias(row),
      group: 'alias' as const,
    })),
    ...unannounced(announced).map((entry) => {
      const shut = shutBecause(entry, now);
      return {
        value: entry.id,
        displayName: entry.displayName,
        description: describeModel(entry),
        group: 'version' as const,
        ...(shut ? { unavailable: shut } : {}),
      };
    }),
  ];
}
