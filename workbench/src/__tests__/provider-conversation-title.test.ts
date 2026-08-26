import { describe, expect, it } from 'vitest';

import { withLive } from '../../../src/workbench/chat-sidebar.tsx';

describe('provider conversation names', () => {
  it('keeps the provider name over the live session fallback', () => {
    const [merged] = withLive([{
      sessionId: 'session-1', externalId: 'provider-1', brand: 'claude',
      title: 'Repair Ghost Status Badges', lastActiveAt: '2026-08-26T10:00:00.000Z',
      state: 'idle', origin: 'app', projectId: 'project-1', cwdHint: '/project',
      folder: 'project', branch: null, beads: [],
    }], [{
      id: 'session-1', externalId: 'provider-1', brand: 'claude', projectId: 'project-1',
      projectPath: '/project', title: 'This chat is idle it was working but got forced close',
      state: 'idle', activity: null, waitingFor: null, busySince: null,
      lastActiveAt: '2026-08-26T10:01:00.000Z', lastSpokeAt: null,
      startedAt: '2026-08-26T10:00:00.000Z', beads: [],
    }], 'project-1');

    expect(merged!.title).toBe('Repair Ghost Status Badges');
  });
});
