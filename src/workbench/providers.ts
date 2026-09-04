"use client";

import { useSyncExternalStore } from 'react';
import type { Brand, ModelChoice } from './protocol';
import { sendCommand } from './use-session';

export interface ProviderAvailability {
  brand: Brand;
  name: string;
  available: boolean;
  path: string | null;
  installUrl: string;
  models: ModelChoice[];
  availabilityReason?: string | null;
}

const fallback: ProviderAvailability[] = [
  { brand: 'claude', name: 'Claude', available: false, path: null, installUrl: 'https://docs.anthropic.com/en/docs/claude-code', models: [] },
  { brand: 'codex', name: 'Codex', available: false, path: null, installUrl: 'https://developers.openai.com/codex/cli', models: [] },
  { brand: 'local', name: 'Local models', available: false, path: null, installUrl: 'https://block.github.io/goose/docs/getting-started/providers', models: [] },
];

let snapshot = fallback;
let request: Promise<void> | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 100;
const listeners = new Set<() => void>();

function loadProviders(): void {
  if (request) return;
  request = sendCommand<{ providers: ProviderAvailability[] }>({ type: 'providers.list' })
    .then((answer) => {
      if (!Array.isArray(answer.providers)) throw new Error('providers.list returned no providers');
      snapshot = answer.providers;
      retryDelay = 100;
      listeners.forEach((listener) => listener());
    })
    .catch(() => {
      if (listeners.size === 0) return;
      retry = setTimeout(loadProviders, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 2_000);
    })
    .finally(() => { request = null; });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  loadProviders();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && retry) {
      clearTimeout(retry);
      retry = undefined;
    }
  };
}

export function useProviders() {
  return useSyncExternalStore(subscribe, () => snapshot, () => fallback);
}

/** Availability is a server fact; no caller may infer it from a CLI or model name. */
export function providerIsAvailable(providers: ProviderAvailability[], brand: Brand): boolean {
  return providers.some((provider) => provider.brand === brand && provider.available);
}

export function firstAvailableProvider(providers: ProviderAvailability[]): Brand | null {
  return providers.find((provider) => provider.available)?.brand ?? null;
}

/**
 * Why a provider cannot be started, in one line the reader can act on.
 *
 * "Install Local models: <url>" is the wrong sentence for the commonest way
 * local is unavailable — the adapter is installed and the runtime simply is
 * not running — and it sends the reader to a download page for software they
 * already have. When the server said what is actually missing, that is what is
 * shown; the install line is the fallback for a provider that has none
 * (bw-u6cl.9).
 */
export function whyUnavailable(provider: Pick<ProviderAvailability, 'name' | 'installUrl' | 'availabilityReason'>): string {
  return provider.availabilityReason ?? `Install ${provider.name}: ${provider.installUrl}`;
}
