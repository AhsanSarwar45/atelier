import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROVIDER_MESSAGE_KINDS, providerMessageStatus, type ProviderMessageSignal } from '@/workbench/provider-messages';

/**
 * The same chat, read live and read cold, wearing the same word.
 *
 * A condition is drawn twice over. The screen holds the signal and says what
 * it means for itself; the driver writes a state down beside it, and that is
 * what a chat opened fresh is read off. Two readings, one chat — and while the
 * driver wrote `Failed` over every failure alike, a chat stopped by its own
 * session limit read `Limit reached` until the page was reloaded and `Failed`
 * afterwards, with the notice still on the page saying when it lifts
 * (bw-d516).
 *
 * So the driver reads the condition too, and this holds the two vocabularies
 * to each other. They are in different languages and cannot import one
 * another; what can be checked is that neither grows a word the other has not
 * got.
 */
const RUST = readFileSync(
  resolve(__dirname, '..', '..', '..', 'server', 'src', 'workbench', 'provider_messages.rs'),
  'utf8',
);

/** `"usage_limit" => "Limit reached",` as `standing` spells it. */
function rustWords(): Map<string, string> {
  const body = RUST.split('pub fn standing(')[1]?.split('\npub fn ')[0] ?? '';
  const words = new Map<string, string>();
  for (const [, kind, word] of body.matchAll(/"([a-z_]+)" => "([^"]+)",/g)) words.set(kind, word);
  return words;
}

const signal = (kind: string, severity: ProviderMessageSignal['severity']): ProviderMessageSignal => ({
  id: `condition:${kind}`, kind: kind as ProviderMessageSignal['kind'],
  phase: 'active', severity, scope: 'turn',
});

describe('one word for a condition, whichever side reads it', () => {
  it('gives every condition the same word in both languages', () => {
    const rust = rustWords();
    for (const kind of PROVIDER_MESSAGE_KINDS) {
      // `unknown` is the far end of the Rust match rather than an arm of it.
      if (kind === 'unknown') continue;
      expect(rust.get(kind), `the driver has no word for ${kind}`).toBe(
        providerMessageStatus(signal(kind, 'error')).label,
      );
    }
    expect(rust.size).toBe(PROVIDER_MESSAGE_KINDS.length - 1);
  });

  it('turns severity into the same standing on both sides', () => {
    for (const [severity, state] of [
      ['blocking', 'stopped'], ['error', 'errored'], ['warning', 'running_tool'], ['info', 'running_tool'],
    ] as const) {
      expect(providerMessageStatus(signal('usage_limit', severity)).state).toBe(state);
      expect(RUST).toContain(`=> "${state}"`);
    }
  });

  it('names no provider in either of them', () => {
    for (const word of rustWords().values()) expect(word).not.toMatch(/claude|codex|anthropic|openai|gemini/i);
  });
});
