import { describe, expect, it } from 'vitest';

import {
  firstAvailableProvider,
  providerIsAvailable,
  whyUnavailable,
  type ProviderAvailability,
} from '@/workbench/providers';

const providers = (
  ...states: Array<['claude' | 'codex' | 'local', boolean]>
): ProviderAvailability[] =>
  states.map(([brand, available]) => ({
    brand,
    available,
    name: brand,
    path: null,
    installUrl: '',
    models: [],
  }));

describe('provider availability', () => {
  it('selects the first provider the backend says can really launch', () => {
    const listed = providers(['claude', false], ['codex', true], ['local', true]);
    expect(firstAvailableProvider(listed)).toBe('codex');
    expect(providerIsAvailable(listed, 'claude')).toBe(false);
    expect(providerIsAvailable(listed, 'codex')).toBe(true);
  });

  it('offers no start target when every adapter is absent', () => {
    const listed = providers(['claude', false], ['codex', false], ['local', false]);
    expect(firstAvailableProvider(listed)).toBeNull();
  });
});

/**
 * A greyed provider says why it is greyed, in the words of the thing that is
 * missing (bw-u6cl.9).
 *
 * "Install Local models" is the wrong sentence for the commonest way local is
 * unavailable — the adapter is there and the runtime simply is not running —
 * and it sends the reader to a download page for software they already have.
 */
describe('why a provider cannot be started', () => {
  it('says what the server said is missing, when the server said', () => {
    expect(
      whyUnavailable({
        name: 'Local models',
        installUrl: 'https://block.github.io/goose',
        availabilityReason: 'no local model runtime answered at http://127.0.0.1:8080 or http://127.0.0.1:11434',
      }),
    ).toBe('no local model runtime answered at http://127.0.0.1:8080 or http://127.0.0.1:11434');
  });

  it('falls back to the install line for a provider that named no reason', () => {
    expect(whyUnavailable({ name: 'Codex', installUrl: 'https://developers.openai.com/codex/cli' })).toBe(
      'Install Codex: https://developers.openai.com/codex/cli',
    );
  });
});
