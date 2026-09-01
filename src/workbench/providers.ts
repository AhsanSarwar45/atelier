"use client";

import { useEffect, useState } from 'react';
import type { Brand, ModelChoice } from './protocol';
import { sendCommand } from './use-session';

export interface ProviderAvailability {
  brand: Brand;
  name: string;
  available: boolean;
  path: string | null;
  installUrl: string;
  models: ModelChoice[];
}

const fallback: ProviderAvailability[] = [
  { brand: 'claude', name: 'Claude', available: false, path: null, installUrl: 'https://docs.anthropic.com/en/docs/claude-code', models: [] },
  { brand: 'codex', name: 'Codex', available: false, path: null, installUrl: 'https://developers.openai.com/codex/cli', models: [] },
  { brand: 'local', name: 'Local models', available: false, path: null, installUrl: 'https://block.github.io/goose/docs/getting-started/providers', models: [] },
];

export function useProviders() {
  const [providers, setProviders] = useState(fallback);
  useEffect(() => {
    void sendCommand<{ providers: ProviderAvailability[] }>({ type: 'providers.list' })
      .then((answer) => { if (Array.isArray(answer.providers)) setProviders(answer.providers); })
      .catch(() => setProviders(fallback));
  }, []);
  return providers;
}
