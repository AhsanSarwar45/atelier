/** The restore response must not let an old provider marker speak for our rows. */
import { describe, expect, it } from 'vitest';

import type { HeldChat } from '@/workbench/chat-state';
import type { RestoreRow } from '@/workbench/protocol';
import { withOutsideHolds } from '@/workbench/restore-status';

const staleCommand: HeldChat = {
  id: 'provider-1',
  holder: 'program',
  doing: 'running',
  detail: 'Bash',
  since: 1_000,
};

function row(over: Partial<RestoreRow> = {}): RestoreRow {
  return {
    sessionId: 'atelier-1',
    externalId: 'provider-1',
    brand: 'codex',
    title: 'A chat',
    lastActiveAt: '2026-08-26T10:00:00.000Z',
    state: 'idle',
    origin: 'app',
    projectId: 'project-1',
    cwdHint: '/project',
    folder: 'project',
    branch: 'main',
    beads: [],
    ...over,
  };
}

describe('provider status on the restore list', () => {
  it('leaves an active idle app session idle instead of restoring its last command', () => {
    const [restored] = withOutsideHolds([row()], [staleCommand]);

    expect(restored).toMatchObject({ state: 'idle', runningElsewhere: false, held: null });
  });

  it('does not remember status for a closed app session', () => {
    const [restored] = withOutsideHolds([row({ state: 'dormant' })], [staleCommand]);

    expect(restored).toMatchObject({ state: 'dormant', runningElsewhere: false, held: null });
  });

  it('still reports a live conversation Atelier has never opened', () => {
    const [restored] = withOutsideHolds(
      [row({ sessionId: null, origin: 'terminal', state: 'dormant' })],
      [staleCommand],
    );

    expect(restored).toMatchObject({ runningElsewhere: true, held: staleCommand });
  });
});
