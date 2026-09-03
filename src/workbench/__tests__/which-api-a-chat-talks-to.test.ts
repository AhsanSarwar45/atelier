/**
 * Which API a chat is actually talking to (bw-t26l.20).
 *
 * The agent reports its own endpoint over ACP (`providers/list`), and until it
 * was read the screen said nothing about it: a chat on Bedrock, on Vertex, or
 * pointed at a proxy looked exactly like one on the plain Anthropic API,
 * though it spends different money and answers to a different account.
 *
 * The chip is for the unusual answer only. Drawn on every chat it would be a
 * word nobody reads, and the one time it mattered it would read as furniture.
 */
import { describe, expect, it } from 'vitest';

import type { ApiProvider } from '@/workbench/protocol';
import { endpointWords } from '@/workbench/what-it-runs';

const provider = (current: ApiProvider['current']): ApiProvider[] => [
  { providerId: 'main', supported: ['anthropic', 'bedrock', 'vertex'], required: false, current },
];

describe('the endpoint a chat says it is on', () => {
  it('says nothing about an agent that never mentioned one', () => {
    expect(endpointWords([])).toBeNull();
    expect(endpointWords(provider(null))).toBeNull();
  });

  it('says nothing about the ordinary API, which is nearly every chat', () => {
    expect(endpointWords(provider({ apiType: 'anthropic', baseUrl: 'https://api.anthropic.com' }))).toBeNull();
  });

  it('names the service when the chat is on another one', () => {
    const said = endpointWords(provider({ apiType: 'bedrock', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com' }));
    expect(said?.label).toBe('Bedrock');
    expect(said?.title).toContain('https://bedrock-runtime.us-east-1.amazonaws.com');
  });

  it('names the host when the chat is on the Anthropic API somewhere else', () => {
    expect(endpointWords(provider({ apiType: 'anthropic', baseUrl: 'https://proxy.internal:8443/v1' }))?.label).toBe(
      'proxy.internal:8443',
    );
  });

  it('says the address it was given when that address is not a URL', () => {
    expect(endpointWords(provider({ apiType: 'anthropic', baseUrl: 'localhost-proxy' }))?.label).toBe('localhost-proxy');
  });
});
