import { describe, expect, it } from 'vitest';
import { foldAll } from '@/workbench/fold';
import { drawnRows } from '@/workbench/machine-lines';
import { providerMessageFromText, providerMessageReads, type ProviderMessageSignal } from '@/workbench/provider-messages';
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


  /**
   * The manager, 2026-09-03, over two screenshots of one session limit:
   * "this you've hit your limit is werid all around. some places its hows the
   * yello message box with reset time, somplaces it doesnt".
   *
   * Both screenshots are the same condition. The notice never carried the time,
   * because every one of these arrives as prose naming a wall clock and not one
   * of them carries an instant — over the owner's own event log, 11 usage limits
   * and 11 nulls. So the only place the time was ever written was the provider's
   * own sentence beside it, which is there sometimes and not others (bw-gao7).
   */
  it('says when the limit lifts, whether or not the provider named an instant', () => {
    const prose: ProviderMessageSignal = {
      id: 'usage:session', kind: 'usage_limit', phase: 'active', severity: 'blocking', scope: 'session',
      retryAt: null, resets: 'resets 9pm (Asia/Karachi)',
      detail: "You've hit your session limit · resets 9pm (Asia/Karachi)",
    };
    expect(providerMessageReads(prose)).toBe("You've hit your session limit · resets 9pm (Asia/Karachi)");

    // An instant is still preferred, and still drawn in the reader's own zone.
    expect(providerMessageReads({ ...prose, retryAt: '2036-09-03T16:25:00+05:00' }, 'Asia/Karachi'))
      .toBe("You've hit your session limit · resets 4:25 PM (Asia/Karachi)");

    // A condition that named no time says only what it is.
    expect(providerMessageReads({ ...prose, resets: null })).toBe("You've hit your session limit");
  });

  /**
   * The second screenshot, exactly: the notice AND the sentence it stands for,
   * one above the other, saying the same thing in two wordings.
   *
   * From the owner's log (chat e6d3753d, seq 5894-5915): the driver files the
   * condition when the message COMPLETES, and that completion trailed the words
   * by eighteen events and a whole turn of his own. The projection removes the
   * sentence the signal names — but only then, and only when a name was given.
   */
  it('draws one condition once, however the provider said it', () => {
    const signal: ProviderMessageSignal = {
      id: 'usage:session', kind: 'usage_limit', phase: 'active', severity: 'blocking', scope: 'session',
      retryAt: null, resets: 'resets 9pm (Asia/Karachi)',
    };
    const spoken: WbpEvent[] = [
      { type: 'message.started', messageId: 'said', role: 'assistant', seq: 1, sessionId: 'chat', at: '2026-09-03T16:00:00Z' },
      { type: 'text.delta', messageId: 'said', text: "You've hit your session limit · resets 9pm (Asia/Karachi)", seq: 2, sessionId: 'chat', at: '2026-09-03T16:00:01Z' },
    ] as WbpEvent[];

    // On its own the sentence is the only account there is, so it is drawn.
    const alone = drawnRows(foldAll(spoken).items);
    expect(alone.map((row) => row.row === 'machine' && row.kind)).toEqual(['kit/limit_reached']);

    // Beside the condition it means, it is not.
    const both = drawnRows(foldAll([...spoken, event(signal, 3)]).items);
    expect(both.map((row) => row.row === 'machine' && row.kind)).toEqual(['provider/usage_limit']);
    expect(both[0]!.row === 'machine' && both[0]!.lines[0]!.text)
      .toBe("You've hit your session limit · resets 9pm (Asia/Karachi)");
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
