/**
 * How much of the plan is spent.
 *
 * Distinct from `context-window.ts`, which asks how full ONE conversation is.
 * This asks the other question a reader has while an agent works: how much of
 * the account's own allowance — the five-hour session window and the weekly
 * one — has already gone. The kit answers it in a terminal under `/usage` and
 * nowhere else, so the app showed a chat's dollars while the thing that
 * actually stops work was invisible until it stopped it (bw-malh).
 *
 * The figure is the ACCOUNT'S, not this chat's: every chat on the machine
 * spends the same allowance, and so every chat shows the same number. It is
 * therefore read once by the sidecar and served whole, never carried on a
 * session's event stream.
 *
 * Shared: the sidecar normalises the kit's answer with this and the browser
 * draws it with this. It therefore imports nothing — the sidecar runs it
 * through Node's strip-only TypeScript.
 */

/* ------------------------------------------------------------------ *
 * What the kit hands back.
 * ------------------------------------------------------------------ */

/**
 * One allowance, as the kit's own `limits[]` spells it.
 *
 * Read in preference to the named `five_hour` / `seven_day` fields beside it,
 * because only this form carries the server's own `severity` and the model a
 * scoped window belongs to. The named fields stand in when a build sends them
 * and no array (measured 2026-08-20: this build sends both).
 */
interface RawLimit {
  kind?: string;
  group?: string;
  percent?: number | null;
  severity?: string | null;
  resets_at?: string | null;
  scope?: { model?: { id?: string | null; display_name?: string | null } | null } | null;
}

/** The named form of one window, kept for builds that send no `limits[]`. */
interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

/** One thing the local record says is driving the spend. */
interface RawTrait {
  key?: string;
  pct?: number;
  count?: number;
}

/** One named contributor — an agent, a skill, a plugin, an MCP server. */
interface RawNamed {
  name?: string;
  pct?: number;
}

interface RawBehaviours {
  request_count?: number;
  session_count?: number;
  behaviors?: RawTrait[];
  agents?: RawNamed[];
  skills?: RawNamed[];
  plugins?: RawNamed[];
  mcp_servers?: RawNamed[];
}

/**
 * As much of the kit's `/usage` answer as this reads.
 *
 * Deliberately loose. The answer carries more than its own published type
 * admits — windows under names no plan of ours has, dollar figures that are
 * null on a subscription — and a shape declared here that the kit does not
 * promise would be a lie the compiler enforced.
 */
export interface RawPlanUsage {
  subscription_type?: string | null;
  rate_limits_available?: boolean;
  rate_limits?:
    | ({
        limits?: RawLimit[];
        five_hour?: RawWindow | null;
        seven_day?: RawWindow | null;
        model_scoped?: { display_name?: string; utilization?: number | null; resets_at?: string | null }[];
        extra_usage?: {
          is_enabled?: boolean;
          utilization?: number | null;
          monthly_limit?: number | null;
          used_credits?: number | null;
          currency?: string | null;
        } | null;
      })
    | null;
  behaviors?: { day?: RawBehaviours | null; week?: RawBehaviours | null } | null;
}

/* ------------------------------------------------------------------ *
 * What the app draws.
 * ------------------------------------------------------------------ */

/** How much trouble a window is in. Drives one colour and nothing else. */
export type Severity = 'normal' | 'warning' | 'critical';

/** One allowance: how much of it is gone, and when it comes back. */
export interface PlanWindow {
  /** Stable across reads, so a list of them can be keyed. */
  key: string;
  /** What it is called on screen. */
  label: string;
  /** 0–100, or null when the server declines to say. */
  percent: number | null;
  /** ISO 8601, or null when this window does not reset on a clock. */
  resetsAt: string | null;
  severity: Severity;
}

/** Credit spending past the plan, when the account has it switched on. */
export interface PlanCredits {
  enabled: boolean;
  percent: number | null;
  /** Both in whole currency units, as the kit gives them. */
  used: number | null;
  limit: number | null;
  currency: string | null;
}

/** What the machine's own record says the spend went on. */
export interface Driving {
  /** `day` is the last 24 hours; `week` the last seven days. */
  span: 'day' | 'week';
  requests: number;
  sessions: number;
  /** Overlapping characteristics — these do not sum to 100. */
  traits: { key: string; label: string; pct: number }[];
  agents: { name: string; pct: number }[];
  skills: { name: string; pct: number }[];
  plugins: { name: string; pct: number }[];
  servers: { name: string; pct: number }[];
}

/** The whole picture, as the app holds it. */
export interface PlanUsage {
  /**
   * False on an API key, on Bedrock, on Vertex — anywhere a claude.ai plan is
   * not what pays. Everything below is then empty, and the app draws no chip
   * rather than a zero, because a zero there reads as "nothing spent".
   */
  available: boolean;
  /** 'pro', 'max', 'team', 'enterprise' — the kit's own word. */
  plan: string | null;
  /** The five-hour window: what `/usage` calls the current session. */
  session: PlanWindow | null;
  /** The seven-day window across every model. */
  week: PlanWindow | null;
  /** The seven-day window of one model, when the plan scopes one. */
  perModel: PlanWindow[];
  credits: PlanCredits | null;
  driving: Driving[];
  /** When this was read, ISO 8601. */
  at: string;
}

/** Nothing known — what the app holds before the first answer, and after a failed one. */
export const NOTHING_KNOWN: PlanUsage = {
  available: false,
  plan: null,
  session: null,
  week: null,
  perModel: [],
  credits: null,
  driving: [],
  at: '',
};

/* ------------------------------------------------------------------ *
 * Reading the kit's answer.
 * ------------------------------------------------------------------ */

/** The kit's own words for what is driving the spend, in ours. */
const TRAIT_LABELS: Record<string, string> = {
  cache_miss: 'Cache misses',
  long_context: 'Long conversations',
  subagent_heavy: 'Agents sent off',
  high_parallel: 'Several at once',
  cron: 'Scheduled runs',
};

const RANK: Record<Severity, number> = { normal: 0, warning: 1, critical: 2 };

/** Past this much of a window, the reader is being warned; past the second, stopped soon. */
export const WARN_AT = 80;
export const CRITICAL_AT = 95;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * How much trouble a percentage is, taking the server's word and our own
 * thresholds — whichever is worse.
 *
 * The server ranks a window itself, and its ranking knows things this does not
 * (an account allowed to overspend is not in trouble at 100%). But a build that
 * sends no severity at all would otherwise draw a calm chip at 99%, so the
 * reading below is a floor, never a ceiling.
 */
export function severityOf(percent: number | null, said?: string | null): Severity {
  const fromServer: Severity =
    said === 'warning' ? 'warning' : said === 'critical' || said === 'exceeded' || said === 'rejected' ? 'critical' : 'normal';
  const fromPercent: Severity =
    percent === null ? 'normal' : percent >= CRITICAL_AT ? 'critical' : percent >= WARN_AT ? 'warning' : 'normal';
  return RANK[fromServer] >= RANK[fromPercent] ? fromServer : fromPercent;
}

function windowFrom(key: string, label: string, limit: RawLimit | null, named: RawWindow | null | undefined): PlanWindow | null {
  const percent = num(limit?.percent) ?? num(named?.utilization);
  const resetsAt = text(limit?.resets_at) ?? text(named?.resets_at);
  if (percent === null && resetsAt === null) return null;
  return { key, label, percent, resetsAt, severity: severityOf(percent, limit?.severity) };
}

function named(list: RawNamed[] | undefined): { name: string; pct: number }[] {
  return (list ?? [])
    .map((n) => ({ name: text(n.name) ?? '', pct: num(n.pct) ?? 0 }))
    .filter((n) => n.name !== '');
}

function drivingFrom(span: 'day' | 'week', raw: RawBehaviours | null | undefined): Driving | null {
  if (!raw) return null;
  return {
    span,
    requests: num(raw.request_count) ?? 0,
    sessions: num(raw.session_count) ?? 0,
    traits: (raw.behaviors ?? [])
      .map((t) => ({ key: text(t.key) ?? '', label: TRAIT_LABELS[t.key ?? ''] ?? (text(t.key) ?? ''), pct: num(t.pct) ?? 0 }))
      .filter((t) => t.key !== ''),
    agents: named(raw.agents),
    skills: named(raw.skills),
    plugins: named(raw.plugins),
    servers: named(raw.mcp_servers),
  };
}

/**
 * The kit's answer, as the app holds it.
 *
 * `at` is passed in rather than taken from the clock, so the sidecar stamps it
 * once where it read it and every copy of the answer agrees.
 */
export function readUsage(raw: RawPlanUsage | null | undefined, at: string): PlanUsage {
  if (!raw || raw.rate_limits_available !== true || !raw.rate_limits) {
    return { ...NOTHING_KNOWN, plan: text(raw?.subscription_type), at };
  }
  const limits = raw.rate_limits.limits ?? [];
  const of = (kind: string) => limits.find((l) => l.kind === kind) ?? null;

  const scoped = limits.filter((l) => l.kind === 'weekly_scoped');
  const perModel: PlanWindow[] = scoped.length
    ? scoped
        .map((l, i) => {
          const model = text(l.scope?.model?.display_name) ?? 'this model';
          return windowFrom(`model:${model}:${i}`, `This week · ${model}`, l, null);
        })
        .filter((w): w is PlanWindow => w !== null)
    : (raw.rate_limits.model_scoped ?? [])
        .map((m, i) => {
          const model = text(m.display_name) ?? 'this model';
          return windowFrom(`model:${model}:${i}`, `This week · ${model}`, null, {
            utilization: m.utilization,
            resets_at: m.resets_at,
          });
        })
        .filter((w): w is PlanWindow => w !== null);

  const extra = raw.rate_limits.extra_usage;

  return {
    available: true,
    plan: text(raw.subscription_type),
    session: windowFrom('session', 'This session', of('session'), raw.rate_limits.five_hour),
    week: windowFrom('week', 'This week', of('weekly_all'), raw.rate_limits.seven_day),
    perModel,
    credits: extra
      ? {
          enabled: extra.is_enabled === true,
          percent: num(extra.utilization),
          used: num(extra.used_credits),
          limit: num(extra.monthly_limit),
          currency: text(extra.currency),
        }
      : null,
    driving: [drivingFrom('day', raw.behaviors?.day), drivingFrom('week', raw.behaviors?.week)].filter(
      (d): d is Driving => d !== null,
    ),
    at,
  };
}

/* ------------------------------------------------------------------ *
 * Saying it.
 * ------------------------------------------------------------------ */

/** `67%`, or a dash when the server declined to say. */
export function percentReads(percent: number | null): string {
  return percent === null ? '—' : `${Math.round(percent)}%`;
}

/**
 * The clock time a window comes back, in the reader's own zone: `14:50`.
 *
 * `timeZone` exists for the tests, which cannot assert a local time without
 * naming one. Left off everywhere else, so the reader sees his own clock.
 */
export function clockReads(iso: string | null, timeZone?: string): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(at);
}

/**
 * How long until it comes back: `2h 14m`, `9m`, `5d 3h`.
 *
 * Rounded down and never below a minute, because a countdown that says "0m"
 * for the last sixty seconds reads as a stuck clock.
 */
export function untilReads(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const minutes = Math.floor((at.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return 'any moment';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/**
 * The chip's own words: `67% · resets 14:50`.
 *
 * The percentage first because it is the question being asked, and the time
 * after it because "how long have I got" is the second question and never the
 * first. A window with no reset time says only its percentage.
 */
export function chipReads(w: PlanWindow, timeZone?: string): string {
  const clock = clockReads(w.resetsAt, timeZone);
  return clock ? `${percentReads(w.percent)} · resets ${clock}` : percentReads(w.percent);
}

/**
 * The five-hour figure as the top line says it: `5h 67% · resets 14:50`.
 *
 * Named, because the line carries the week's figure beside it and a bare `67%`
 * next to a bare `18%` says which is which to nobody (bw-malh.5).
 */
export function sessionChipReads(w: PlanWindow, timeZone?: string): string {
  return `5h ${chipReads(w, timeZone)}`;
}

/**
 * The week's figure as the top line says it: `wk 18%`.
 *
 * No reset time: a weekly window comes back in days, which is not a countdown
 * anybody reads off a status line — it is in the panel, next to the bar.
 */
export function weekChipReads(w: PlanWindow): string {
  return `wk ${percentReads(w.percent)}`;
}

/** The whole sentence, for the chip's tooltip and the panel's own lines. */
export function windowReads(w: PlanWindow, now: Date, timeZone?: string): string {
  const clock = clockReads(w.resetsAt, timeZone);
  const until = untilReads(w.resetsAt, now);
  const spent = w.percent === null ? 'Usage not reported' : `${percentReads(w.percent)} of this window used`;
  if (!clock) return spent;
  return `${spent} — resets ${clock}${until ? ` (in ${until})` : ''}`;
}

/* ------------------------------------------------------------------ *
 * Which answers may be drawn.
 * ------------------------------------------------------------------ */

/** Every window one reading holds, keyed the way the app keys them. */
function windowsOf(u: PlanUsage): PlanWindow[] {
  return [u.session, u.week, ...u.perModel].filter((w): w is PlanWindow => w !== null);
}

/**
 * Whether a fresh answer may replace the one in hand.
 *
 * The kit answers the account's figure from a live read when it can and from a
 * snapshot it keeps on disk when it cannot — and it does not say which. So an
 * answer arrives with a window's percentage BELOW the one already shown while
 * that window's reset time has not moved, which cannot happen: an allowance is
 * not un-spent inside its own window. Drawing it walks the chip backwards for
 * minutes at a time, which is exactly what a reader deciding whether to start
 * another agent must not be shown (bw-dmoe).
 *
 * Two falls are real and are believed: a window that has ROLLED comes back with
 * a new reset time and a small number, and an account with no plan behind it
 * answers by saying so. The second is refused only when something good is
 * already held, because a reading in hand beats a blank.
 */
export function believable(next: PlanUsage, held: PlanUsage | null): boolean {
  if (!held || !held.available) return true;
  if (!next.available) return false;
  const before = windowsOf(held);
  return windowsOf(next).every((now) => {
    const was = before.find((w) => w.key === now.key);
    if (!was || was.percent === null || now.percent === null) return true;
    return !(now.resetsAt === was.resetsAt && now.percent < was.percent);
  });
}
