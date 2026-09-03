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
  /** Answer-shaped provider text this semantic signal replaces, when present. */
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
  refusal: 'Declined', turn_limit: 'Stopped short', unknown: 'Provider problem',
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

/**
 * Compatibility reader for providers that still expose only prose. New
 * adapters should prefer their structured signal and use this only at their
 * boundary; vendor phrases never escape into the renderer.
 */
export function providerMessageFromText(text: string): ProviderMessageSignal | null {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const usage = /(?:hit|reached).*(?:usage|session|weekly).*limit|out of (?:usage )?credits|usage limit/.test(lower);
  const auth = /(?:sign|log)[ -]?in|authentication|unauthenticated|invalid api key/.test(lower);
  const unavailable = /service unavailable|temporarily unavailable|overloaded/.test(lower);
  const network = /network|connection (?:failed|lost|refused)|timed? out|dns/.test(lower);
  const model = /model .*unavailable|model .*not (?:found|supported)/.test(lower);
  const context = /context (?:window|length|limit)|too many tokens/.test(lower);
  const rate = /rate limit|too many requests|http 429/.test(lower);
  const kind: ProviderMessageKind | null = usage ? 'usage_limit' : auth ? 'authentication' : unavailable
    ? 'service_unavailable' : network ? 'network' : model ? 'model_unavailable' : context
      ? 'context_limit' : rate ? 'rate_limit' : null;
  if (kind === null) return null;

  const when = flat.match(/(?:try again at|resets?)\s+(.+?)(?:\.|$)/i)?.[1]?.replace(/(\d)(?:st|nd|rd|th)\b/g, '$1');
  const parsed = when ? new Date(when) : null;
  const href = flat.match(/https?:\/\/[^\s]+/)?.[0]?.replace(/[.,]$/, '') ?? null;
  return {
    id: kind === 'usage_limit' ? 'usage:session' : `condition:${kind}`,
    kind,
    phase: 'active',
    severity: kind === 'usage_limit' || kind === 'authentication' ? 'blocking' : 'error',
    scope: kind === 'usage_limit' || kind === 'authentication' ? 'session' : 'turn',
    detail: flat,
    retryAt: parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null,
    action: href ? { label: 'Manage usage', href } : null,
  };
}
