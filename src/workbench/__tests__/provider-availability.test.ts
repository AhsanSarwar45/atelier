import { describe, expect, it } from 'vitest';

import {
  firstAvailableProvider,
  providerIsAvailable,
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
