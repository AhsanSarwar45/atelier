import { describe, expect, it } from 'vitest';

import { canCompose, sessionOwnership } from '@/workbench/running';

describe.each(['claude', 'codex'])('%s chat ownership', () => {
  it('does not confuse terminal origin with current external ownership', () => {
    const ownership = sessionOwnership('dormant', 'provider-session', false);
    expect(ownership).toEqual({ kind: 'unheld', externalId: 'provider-session' });
    expect(canCompose(ownership)).toBe(true);
  });

  it('is read-only only while another live process holds the session', () => {
    const ownership = sessionOwnership('dormant', 'provider-session', true);
    expect(ownership).toEqual({ kind: 'elsewhere', externalId: 'provider-session' });
    expect(canCompose(ownership)).toBe(true);
  });

  it('trusts the server’s provider-neutral outside-owner set over stale transcript state', () => {
    for (const state of ['starting', 'idle', 'thinking', 'streaming', 'running_tool', 'waiting_permission'] as const) {
      const ownership = sessionOwnership(state, 'provider-session', true);
      expect(ownership, state).toEqual({ kind: 'elsewhere', externalId: 'provider-session' });
      expect(canCompose(ownership), state).toBe(true);
    }
  });
});
