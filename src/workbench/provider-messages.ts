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
  action?: ProviderMessageAction | null;
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
  unknown: 'The provider reported a problem',
};

function clockReads(iso: string, timeZone?: string): string | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
}

/** Provider-independent copy used by every live and replayed notice. */
export function providerMessageReads(signal: ProviderMessageSignal, timeZone?: string): string {
  const reset = signal.retryAt ? clockReads(signal.retryAt, timeZone) : null;
  const zone = reset && timeZone ? ` (${timeZone})` : '';
  return `${TITLES[signal.kind]}${reset ? ` · resets ${reset}${zone}` : ''}`;
}

export function isProviderMessageKind(value: string): value is ProviderMessageKind {
  return (PROVIDER_MESSAGE_KINDS as readonly string[]).includes(value);
}
