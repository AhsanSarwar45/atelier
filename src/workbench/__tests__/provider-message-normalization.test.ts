import { describe, expect, it } from 'vitest';
import { foldAll } from '@/workbench/fold';
import { drawnRows } from '@/workbench/machine-lines';
import { providerMessageFromText, type ProviderMessageSignal } from '@/workbench/provider-messages';
import type { WbpEvent } from '@/workbench/protocol';

const event = (signal: ProviderMessageSignal, seq = 1): WbpEvent => ({
  type: 'provider.message', signal, seq, sessionId: 'chat', at: '2026-08-30T08:00:00Z',
});

function rowFor(signal: ProviderMessageSignal) {
  return drawnRows(foldAll([event(signal)]).items)[0];
}

describe('provider message normalization', () => {
  it('renders equivalent Claude, Codex, and future-provider signals identically', () => {
    const semantic: ProviderMessageSignal = {
      id: 'usage:session', kind: 'usage_limit', phase: 'active', severity: 'blocking', scope: 'session',
      retryAt: '2036-09-03T16:25:00+05:00',
    };
    const rows = [semantic, { ...semantic }, { ...semantic }].map(rowFor);
    expect(rows.map((row) => row.row === 'machine' && ({
      family: row.family, kind: row.kind, audience: row.audience, text: row.lines[0]?.text,
    }))).toEqual([rows[0], rows[0], rows[0]].map((row) => row.row === 'machine' && ({
      family: row.family, kind: row.kind, audience: row.audience, text: row.lines[0]?.text,
    })));
    expect(rows[0]).toMatchObject({ row: 'machine', family: 'stopped', kind: 'provider/usage_limit', audience: 'you' });
  });

  it('adapts legacy provider prose only at the provider boundary', () => {
    expect(providerMessageFromText(
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 3rd, 2036 9:25 PM.",
    )).toMatchObject({ kind: 'usage_limit', severity: 'blocking', scope: 'session', action: { label: 'Manage usage' } });
    expect(providerMessageFromText("You've hit your session limit · resets 3:10pm (Asia/Karachi)"))
      .toMatchObject({ kind: 'usage_limit', severity: 'blocking', scope: 'session' });
  });

  it.each([
    ['Too many requests (HTTP 429)', 'rate_limit'],
    ['Authentication failed: invalid API key', 'authentication'],
    ['Service temporarily unavailable', 'service_unavailable'],
    ['Network connection timed out', 'network'],
    ['The selected model is unavailable', 'model_unavailable'],
    ['Context window limit exceeded', 'context_limit'],
  ])('maps %s to %s', (text, kind) => {
    expect(providerMessageFromText(text)?.kind).toBe(kind);
  });
});
