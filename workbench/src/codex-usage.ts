/** Account-wide Codex allowance, read independently of any chat. */
import { NOTHING_KNOWN, type PlanUsage, type PlanWindow } from '../../src/workbench/plan-usage.ts';
import { codexRequest } from './drivers/codex.ts';

const BEAT_MS = 30_000;
let cached: PlanUsage | null = null;
let cachedAt = 0;
let inFlight: Promise<PlanUsage> | null = null;
let beat: ReturnType<typeof setInterval> | null = null;
const watchers = new Set<(usage: PlanUsage) => void>();

const iso = (seconds: unknown): string | null =>
  typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;

function windowOf(key: string, label: string, raw: any): PlanWindow | null {
  if (!raw) return null;
  const percent = typeof raw.usedPercent === 'number' ? raw.usedPercent : null;
  return { key, label, percent, resetsAt: iso(raw.resetsAt), severity: percent !== null && percent >= 90 ? 'critical' : percent !== null && percent >= 75 ? 'warning' : 'normal' };
}

export function readCodexUsage(raw: any, at = new Date().toISOString()): PlanUsage {
  const limits = raw?.rateLimits;
  if (!limits) return { ...NOTHING_KNOWN, at };
  const buckets = Object.entries(raw.rateLimitsByLimitId ?? {}) as [string, any][];
  const all = [[null, limits] as [string | null, any], ...buckets].flatMap(([id, snapshot]) =>
    [snapshot.primary, snapshot.secondary].filter(Boolean).map((window) => ({ id, snapshot, window })),
  );
  const sessionRaw = all.find(({ window }) => Number(window.windowDurationMins) <= 24 * 60)?.window ?? null;
  const weekRaw = all.find(({ id, window }) => (id === null || id === 'codex') && Number(window.windowDurationMins) > 24 * 60)?.window
    ?? all.find(({ window }) => Number(window.windowDurationMins) > 24 * 60)?.window ?? null;
  const perModel = buckets.flatMap(([id, snapshot]) => {
    if (id === 'codex') return [];
    const weekly = [snapshot.primary, snapshot.secondary].find((window) => Number(window?.windowDurationMins) > 24 * 60);
    const label = snapshot.limitName || id;
    const translated = windowOf(`model:${id}`, `This week · ${label}`, weekly);
    return translated ? [translated] : [];
  });
  return {
    available: !!(sessionRaw || weekRaw), plan: limits.planType ?? null,
    session: windowOf('session', 'This session', sessionRaw),
    week: windowOf('week', 'This week', weekRaw), perModel,
    credits: limits.credits ? { enabled: limits.credits.hasCredits === true || limits.credits.unlimited === true, percent: null, used: null, limit: null, currency: null } : null,
    driving: [], at,
  };
}

async function refresh(): Promise<PlanUsage> {
  if (inFlight) return inFlight;
  inFlight = codexRequest('account/rateLimits/read', {}).then((raw) => readCodexUsage(raw)).catch(() => cached ?? { ...NOTHING_KNOWN, at: new Date().toISOString() });
  try {
    cached = await inFlight;
    cachedAt = Date.now();
    watchers.forEach((watcher) => watcher(cached as PlanUsage));
    return cached;
  } finally { inFlight = null; }
}

export async function codexUsage(): Promise<PlanUsage> {
  return cached && Date.now() - cachedAt < BEAT_MS ? cached : refresh();
}

export function watchCodexUsage(watcher: (usage: PlanUsage) => void): () => void {
  watchers.add(watcher);
  if (cached) watcher(cached);
  else void refresh();
  if (!beat) { beat = setInterval(() => void refresh(), BEAT_MS); beat.unref?.(); }
  return () => {
    watchers.delete(watcher);
    if (watchers.size === 0 && beat) { clearInterval(beat); beat = null; }
  };
}
