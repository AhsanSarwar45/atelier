import { describe, expect, it } from 'vitest';
import {
  isProviderMessageKind,
  PROVIDER_MESSAGE_KINDS,
  providerMessageReads,
  type ProviderMessageSignal,
} from '@/workbench/provider-messages';

describe('provider-neutral operational message contract', () => {
  it('names the common conditions without naming a provider', () => {
    expect(PROVIDER_MESSAGE_KINDS).toEqual([
      'usage_limit', 'rate_limit', 'authentication', 'authorization',
      'service_unavailable', 'network', 'provider_error', 'retrying',
      'interrupted', 'model_unavailable', 'context_limit', 'unknown',
    ]);
    for (const kind of PROVIDER_MESSAGE_KINDS) expect(isProviderMessageKind(kind)).toBe(true);
  });

  it('requires identity and lifecycle independently of provider wording', () => {
    const active = {
      id: 'usage:session', kind: 'usage_limit', phase: 'active', severity: 'blocking', scope: 'session',
      retryAt: '2026-09-03T16:25:00+05:00', detail: 'vendor-specific prose',
    } satisfies ProviderMessageSignal;
    const resolved = { ...active, phase: 'resolved' } satisfies ProviderMessageSignal;

    expect(resolved.id).toBe(active.id);
    expect(providerMessageReads(active, 'Asia/Karachi')).toBe(
      "You've hit your session limit · resets 4:25 PM (Asia/Karachi)",
    );
  });

  it('gives a future provider a bounded unknown path', () => {
    const signal = {
      id: 'future:quantum-fog', kind: 'unknown', phase: 'active', severity: 'error', scope: 'turn',
    } satisfies ProviderMessageSignal;
    expect(providerMessageReads(signal)).toBe('The provider reported a problem');
  });
});
