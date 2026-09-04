/**
 * Operational facts every provider can report without lending the UI its
 * vocabulary. Drivers translate wire events into this shape; the transcript
 * decides how the fact reads and when its current notice is replaced.
 */
export const PROVIDER_MESSAGE_KINDS = [
  'usage_limit',
  'rate_limit',
  'authentication',
  'authorization',
  'service_unavailable',
  'network',
  'provider_error',
  'retrying',
  'interrupted',
  'model_unavailable',
  'context_limit',
  // A turn that ended without finishing. ACP names five stop reasons and only
  // `end_turn` means the work is done: a refusal the spec asks to be shown,
  // because the prompt it refused is left out of the next one, and the two
  // ceilings (tokens, requests in a turn) cut a turn off mid-work.
  'refusal',
  'turn_limit',
  // The runtime under a local model went away while it was answering. Not
  // `network` — nothing is between the two, they are the same machine — and
  // not `service_unavailable`, which is a provider that answered and said no.
  // This is a process that stopped, and the words for it are different: the
  // reader starts it again (bw-u6cl.9).
  'runtime_stopped',
  'unknown',
] as const;

export type ProviderMessageKind = (typeof PROVIDER_MESSAGE_KINDS)[number];
export type ProviderMessageSeverity = 'info' | 'warning' | 'error' | 'blocking';
export type ProviderMessageScope = 'turn' | 'session' | 'provider' | 'account';

export interface ProviderMessageAction {
  label: string;
  href: string;
}

/**
 * `id` is stable for one condition (for example `usage:session`), not one
 * packet. A later active signal replaces it and a resolved signal clears it.
 */
export interface ProviderMessageSignal {
  id: string;
  kind: ProviderMessageKind;
  phase: 'active' | 'resolved';
  severity: ProviderMessageSeverity;
  scope: ProviderMessageScope;
  /** Provider-supplied explanation retained as detail, never as the headline. */
  detail?: string | null;
  /** ISO instant after which a time-bounded condition is no longer current. */
  retryAt?: string | null;
  /**
   * The provider's own words for when it lifts — `resets 9pm (Asia/Karachi)` —
   * quoted where it named a wall clock rather than an instant.
   *
   * Almost every provider names one this way and none of them names both, so
   * without this the notice carried no time at all: of every usage limit in the
   * owner's own record, not one arrived with a `retryAt` (bw-gao7). It is read,
   * never re-rendered — an hour cannot be recomputed out of a clock face and a
   * zone name without inventing the date it belongs to.
   */
  resets?: string | null;
  action?: ProviderMessageAction | null;
  /**
   * Kept only because records already hold it, and read by nothing.
   *
   * It named an answer-shaped message the notice REPLACED, and both projections
   * acted on it by deleting that message — so a signal filed against the wrong
   * one deleted a real answer, permanently, because a reload is served from the
   * projection. A notice is drawn beside what it is about now, and nothing may
   * mean "delete this message" (bw-by3w).
   */
  sourceMessageId?: string | null;
}

const TITLES: Record<ProviderMessageKind, string> = {
  usage_limit: "You've hit your session limit",
  rate_limit: 'The provider is limiting requests',
  authentication: 'Sign in to continue',
  authorization: 'This action is not allowed',
  service_unavailable: 'The provider is temporarily unavailable',
  network: 'The provider cannot be reached',
  provider_error: 'The provider could not complete this turn',
  retrying: 'Retrying',
  interrupted: 'This turn was interrupted',
  model_unavailable: 'This model is unavailable',
  context_limit: 'This conversation is out of context space',
  refusal: 'The agent declined to continue',
  turn_limit: 'This turn stopped before it finished',
  runtime_stopped: 'The local model runtime stopped',
  unknown: 'The provider reported a problem',
};

function clockReads(iso: string, timeZone?: string): string | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
}

/**
 * Provider-independent copy used by every live and replayed notice.
 *
 * An instant is preferred and drawn in the reader's own zone. Failing one, the
 * provider's own clause stands as it wrote it: it is the only place the time is
 * written down, and a notice that says a limit was hit without saying when it
 * lifts leaves the reader with nothing to do but guess (bw-gao7).
 */
export function providerMessageReads(signal: ProviderMessageSignal, timeZone?: string): string {
  const reset = signal.retryAt ? clockReads(signal.retryAt, timeZone) : null;
  const zone = reset && timeZone ? ` (${timeZone})` : '';
  const when = reset ? `resets ${reset}${zone}` : signal.resets?.trim() || null;
  return `${TITLES[signal.kind]}${when ? ` · ${when}` : ''}`;
}

export function isProviderMessageKind(value: string): value is ProviderMessageKind {
  return (PROVIDER_MESSAGE_KINDS as readonly string[]).includes(value);
}

export function providerMessageIsCurrent(signal: ProviderMessageSignal, now = Date.now()): boolean {
  if (signal.phase !== 'active') return false;
  if (!signal.retryAt) return true;
  const retryAt = new Date(signal.retryAt).getTime();
  return !Number.isFinite(retryAt) || retryAt > now;
}

const STATUS_LABEL: Record<ProviderMessageKind, string> = {
  usage_limit: 'Limit reached', rate_limit: 'Rate limited', authentication: 'Sign-in required',
  authorization: 'Not allowed', service_unavailable: 'Provider unavailable', network: 'Connection lost',
  provider_error: 'Provider failed', retrying: 'Retrying', interrupted: 'Interrupted',
  model_unavailable: 'Model unavailable', context_limit: 'Context full',
  refusal: 'Declined', turn_limit: 'Stopped short', runtime_stopped: 'Runtime stopped',
  unknown: 'Provider problem',
};

/** The same condition reduced to the compact, colored session-status vocabulary. */
export function providerMessageStatus(signal: ProviderMessageSignal): {
  state: 'stopped' | 'errored' | 'running_tool';
  label: string;
  priority: number;
} {
  const priority = signal.severity === 'blocking' ? 4 : signal.severity === 'error' ? 3 : signal.severity === 'warning' ? 2 : 1;
  return {
    state: signal.severity === 'blocking' ? 'stopped' : signal.severity === 'error' ? 'errored' : 'running_tool',
    label: STATUS_LABEL[signal.kind],
    priority,
  };
}
