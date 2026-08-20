/**
 * Reading the account's plan allowance, once, for every chat.
 *
 * The five-hour and weekly windows belong to the ACCOUNT, not to a chat: two
 * chats open side by side spend the same allowance and must show the same
 * number. So it is read here — once, cached — and served whole from `/usage`,
 * rather than carried on any session's event stream (bw-malh).
 *
 * Where the answer comes from, in order:
 *
 *  1. Any live chat. The kit answers this down a channel that is already open,
 *     without taking a turn and without spending a token.
 *  2. A prober — a session of our own with nothing to say, kept only so the
 *     kit has a channel to answer down when no chat is running. Measured
 *     2026-08-20: 1.9s to start and answer cold, 0 tokens. It is shut down
 *     again once nobody has asked for a few minutes, because an idle kit
 *     process is a hundred megabytes held for a number that moves in percents.
 *
 * The shape it hands back is the browser's, not the kit's: `readUsage` in
 * `src/workbench/plan-usage.ts` does the translating, and both sides hold the
 * same type.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

import { NOTHING_KNOWN, type PlanUsage, type RawPlanUsage, readUsage } from '../../src/workbench/plan-usage.ts';

/**
 * How long an answer stands before it is asked for again.
 *
 * Just under the minute the browser polls on, so a poll that arrives a hair
 * early still finds the cache warm and a poll on the beat always reads fresh.
 */
const FRESH_MS = 55_000;

/** How long the prober is kept alive after the last question. */
const PROBE_IDLE_MS = 4 * 60_000;

/** What a live session can be asked. Only the drivers that have a plan implement it. */
export interface UsageSource {
  planUsage(): Promise<unknown | null>;
}

/** The Query surface this file uses, named here so the SDK's shout stays in one place. */
interface Prober {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
  close?: () => void;
  [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
}

let cached: PlanUsage | null = null;
let cachedAt = 0;
/** The read in flight, so ten browsers asking at once ask the kit once. */
let inFlight: Promise<PlanUsage> | null = null;

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
    options: { cwd: process.cwd(), settingSources: [], strictMcpConfig: true },
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

async function read(sessions: UsageSource | null): Promise<PlanUsage> {
  const at = new Date().toISOString();
  let raw: unknown | null = null;
  try {
    raw = (await sessions?.planUsage()) ?? null;
  } catch {
    raw = null;
  }
  if (!raw) raw = await askTheKit();
  const usage = readUsage(raw as RawPlanUsage | null, at);
  cached = usage;
  cachedAt = now();
  return usage;
}

/**
 * The account's plan allowance, fresh enough.
 *
 * Never throws: a reader that cannot be told the number is told there is no
 * number, and the chat draws no chip rather than a stale one.
 */
export async function planUsage(sessions: UsageSource | null): Promise<PlanUsage> {
  if (cached && now() - cachedAt < FRESH_MS) return cached;
  if (inFlight) return await inFlight;
  inFlight = read(sessions).catch(() => ({ ...NOTHING_KNOWN, at: new Date().toISOString() }));
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** Shuts the prober down. For the sidecar's own exit, and for the tests. */
export function stopProbing(): void {
  if (proberTimer) clearTimeout(proberTimer);
  proberStop?.();
  prober = null;
  proberStop = null;
  proberTimer = null;
  cached = null;
  cachedAt = 0;
}
