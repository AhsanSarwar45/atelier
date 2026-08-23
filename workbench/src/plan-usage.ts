/**
 * Reading the account's plan allowance, once, for every browser.
 *
 * The five-hour and weekly windows belong to the ACCOUNT, not to a chat: two
 * chats open side by side spend the same allowance and must show the same
 * number. So it is read HERE, on a beat of this server's own, and pushed out to
 * every open page over the stream they already hold — no page asks for it, and
 * no chat's own traffic decides how fresh it is (bw-malh, bw-dmoe).
 *
 * It is asked of one helper and one only: a prober — a session of our own with
 * nothing to say, kept alive so the kit has a channel to answer down. Measured
 * 2026-08-20: 1.9s to start and answer cold, 0 tokens. Asking whichever chat
 * happened to be running instead put a different process behind the number
 * every time and the figure disagreed with itself minute to minute; it is shut
 * down again once nobody is watching for a few minutes, because an idle kit
 * process is a hundred megabytes held for a number that moves in percents.
 *
 * An answer is not believed just because it arrived: the kit falls back to a
 * snapshot it keeps on disk without saying so, so a reading whose window has
 * gone backwards under an unmoved reset time is dropped and the last good one
 * stands (`believable`, bw-dmoe).
 *
 * The shape it hands back is the browser's, not the kit's: `readUsage` in
 * `src/workbench/plan-usage.ts` does the translating, and both sides hold the
 * same type.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

import { claudeProgram } from './claude-program.ts';
import { believable, NOTHING_KNOWN, type PlanUsage, type RawPlanUsage, readUsage } from '../../src/workbench/plan-usage.ts';

/**
 * How often the figure is read while anybody is watching.
 *
 * Thirty seconds is what the manager asked for: half a minute is short enough
 * that a window filling up while he watches another chat spend is visible
 * before he decides anything, and long enough that a browser left open all day
 * is two reads a minute of a number nobody is paying for.
 */
const BEAT_MS = 30_000;

/** How long an answer stands before a page asking outright makes us read again. */
const FRESH_MS = BEAT_MS;

/**
 * How soon a refused answer is asked for again.
 *
 * A reading dropped for going backwards means the kit served its snapshot; the
 * next live read is usually the true one, and waiting a whole beat for it
 * leaves the chip a half-minute behind for no reason.
 */
const RETRY_MS = 5_000;

/** How long the prober is kept alive after the last question. */
const PROBE_IDLE_MS = 4 * 60_000;

/** The Query surface this file uses, named here so the SDK's shout stays in one place. */
interface Prober {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
  close?: () => void;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}

/** The last answer that could be believed, and when it was read. */
let cached: PlanUsage | null = null;
let cachedAt = 0;
/** The read in flight, so ten browsers asking at once ask the kit once. */
let inFlight: Promise<PlanUsage> | null = null;

/** Everybody being pushed the figure — one per open page, none when none. */
const watchers = new Set<(u: PlanUsage) => void>();
let beat: ReturnType<typeof setInterval> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;

let prober: Prober | null = null;
let proberStop: (() => void) | null = null;
let proberTimer: ReturnType<typeof setTimeout> | null = null;

function now(): number {
  return Date.now();
}

/**
 * A session with nothing to say, kept open so the kit has somewhere to answer.
 *
 * The lightest one that still answers: no settings files, no MCP servers, no
 * permission mode — it never takes a turn, so none of it would be used. Its
 * message stream is drained and thrown away; without a reader the channel
 * stalls.
 */
function startProber(): Prober {
  let wake: (() => void) | null = null;
  const silent = async function* () {
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
  };
  const q = query({
    prompt: silent(),
    options: {
      cwd: process.cwd(),
      settingSources: [],
      strictMcpConfig: true,
      // The program is named, exactly as every chat names it. Left unsaid, the
      // kit's own package goes looking for the copy of the program it ships
      // beside itself — and an installed reader's helper is deliberately laid
      // down without one (`npm ci --omit=optional`, helper.rs), because the
      // reader already has the program. So the prober died on
      // "Native CLI binary for linux-x64 not found", `askTheKit` swallowed it,
      // and the two chips vanished from every installed copy while a
      // development tree, whose packages still carry the optional one, went on
      // drawing them (bw-vsyx).
      pathToClaudeCodeExecutable: claudeProgram(),
    },
  }) as Prober;
  proberStop = () => {
    wake?.();
    try {
      q.close?.();
    } catch {
      // Already gone; nothing to close.
    }
  };
  void (async () => {
    try {
      for await (const _ of q as AsyncIterable<unknown>) void _;
    } catch {
      // The prober dying is not an error anyone is waiting on: the next read
      // starts a fresh one.
    }
  })();
  return q;
}

function keepProberAlive(): void {
  if (proberTimer) clearTimeout(proberTimer);
  proberTimer = setTimeout(() => {
    proberStop?.();
    prober = null;
    proberStop = null;
    proberTimer = null;
  }, PROBE_IDLE_MS);
  // A timer holding the sidecar open past its work is a process that will not
  // exit; this one is only a caretaker.
  proberTimer.unref?.();
}

async function askTheKit(): Promise<unknown | null> {
  if (!prober) prober = startProber();
  keepProberAlive();
  try {
    return (await prober.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.()) ?? null;
  } catch {
    // A prober that has died answers nothing and must not be asked again.
    proberStop?.();
    prober = null;
    proberStop = null;
    return null;
  }
}

/**
 * One read, believed or dropped.
 *
 * Returns what the app should hold afterwards, which on a dropped answer is
 * what it already held: a figure that has gone backwards is the kit's snapshot
 * talking, not the account (`believable`).
 */
async function read(): Promise<PlanUsage> {
  const at = new Date().toISOString();
  const raw = await askTheKit();
  const usage = readUsage(raw as RawPlanUsage | null, at);
  if (!believable(usage, cached)) {
    askAgainSoon();
    return cached as PlanUsage;
  }
  cached = usage;
  cachedAt = now();
  watchers.forEach((tell) => tell(usage));
  return usage;
}

/** A refused answer is asked for again shortly, once — the beat carries the rest. */
function askAgainSoon(): void {
  if (retry !== null || watchers.size === 0) return;
  retry = setTimeout(() => {
    retry = null;
    void refresh();
  }, RETRY_MS);
  retry.unref?.();
}

/** A read that never throws: nothing known beats a crashed stream. */
async function refresh(): Promise<PlanUsage> {
  if (inFlight) return await inFlight;
  inFlight = read().catch(() => cached ?? { ...NOTHING_KNOWN, at: new Date().toISOString() });
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * The account's plan allowance, fresh enough, for a page asking outright.
 *
 * The pages are pushed the figure and do not poll, so this answers the first
 * paint and the tools that ask from a terminal. Never throws: a reader that
 * cannot be told the number is told there is no number, and the chat draws no
 * chip rather than a stale one.
 */
export async function planUsage(): Promise<PlanUsage> {
  if (cached && now() - cachedAt < FRESH_MS) return cached;
  return await refresh();
}

/** What is held right now, without asking for it. Null before the first answer. */
export function usageNow(): PlanUsage | null {
  return cached;
}

/**
 * Be told the figure, now and whenever it moves.
 *
 * The beat runs for as long as somebody is listening and stops with the last of
 * them, so a server nobody is watching holds no timer and no kit process. A
 * watcher that arrives while an answer is already held is told it at once
 * rather than waiting up to half a minute to be shown anything.
 */
export function watchUsage(tell: (u: PlanUsage) => void): () => void {
  watchers.add(tell);
  if (cached) tell(cached);
  if (!cached || now() - cachedAt >= FRESH_MS) void refresh();
  if (!beat) {
    beat = setInterval(() => void refresh(), BEAT_MS);
    // A timer holding the sidecar open past its work is a process that will not
    // exit; this one only keeps a number fresh.
    beat.unref?.();
  }
  return () => {
    watchers.delete(tell);
    if (watchers.size > 0) return;
    if (beat) clearInterval(beat);
    beat = null;
    if (retry !== null) clearTimeout(retry);
    retry = null;
  };
}

/** Shuts the prober down. For the sidecar's own exit, and for the tests. */
export function stopProbing(): void {
  if (proberTimer) clearTimeout(proberTimer);
  if (beat) clearInterval(beat);
  beat = null;
  if (retry !== null) clearTimeout(retry);
  retry = null;
  watchers.clear();
  proberStop?.();
  prober = null;
  proberStop = null;
  proberTimer = null;
  cached = null;
  cachedAt = 0;
}
