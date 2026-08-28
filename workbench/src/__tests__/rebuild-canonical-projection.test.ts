/** @vitest-environment node */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { foldAll } from '../../../src/workbench/fold.ts';
import type { WbpEvent } from '../../../src/workbench/protocol.ts';
import { planCanonicalProjection } from '../canonical-projection.ts';
import { Store } from '../store.ts';

const SESSION = 'affected-chat';

function row(seq: number, body: object): WbpEvent {
  return {
    ...body, seq, sessionId: SESSION, at: new Date(seq * 1_000).toISOString(),
  } as WbpEvent;
}

function fixture(): WbpEvent[] {
  const once = (from: number) => [
    row(from, { type: 'message.started', messageId: 'answer', role: 'assistant' }),
    row(from + 1, { type: 'text.delta', messageId: 'answer', text: 'Only once.' }),
    row(from + 2, { type: 'message.completed', messageId: 'answer' }),
    row(from + 3, {
      type: 'tool.started', toolCallId: 'spawn', name: 'spawn_agent', input: {},
      title: 'Sent off reviewer', parentToolCallId: null,
    }),
    row(from + 4, {
      type: 'agent.started', agentId: 'reviewer', toolCallId: 'spawn', kind: 'helper',
      what: 'Review it', agentType: 'reviewer', model: null,
    }),
    row(from + 5, {
      type: 'agent.finished', agentId: 'reviewer', state: 'done', seconds: 1,
      tokens: 2, calls: 0, model: null, result: 'Done',
    }),
    row(from + 6, { type: 'tool.completed', toolCallId: 'spawn', ok: true, output: 'Done' }),
  ];
  // This is the pre-identity failure shape: a complete native delivery was
  // appended again after restart with the same stable operation identities.
  return [...once(1), ...once(8)];
}

function store(): Store {
  const database = join(mkdtempSync(join(tmpdir(), 'canonical-projection-')), 'workbench.db');
  const opened = new Store(database);
  opened.createSession({
    id: SESSION, brand: 'codex', externalId: 'native-thread', projectId: 'project',
    projectPath: '/work', cwd: '/work', model: null, permissionMode: 'never', title: null,
    state: 'dormant', createdAt: new Date(0).toISOString(), lastActiveAt: new Date(0).toISOString(),
    origin: 'app',
  });
  for (const event of fixture()) expect(opened.appendEvent(event)).toBe(true);
  return opened;
}

describe('canonical projection repair', () => {
  it('keeps an unknown future-provider event losslessly and reconciles its overlapping deliveries', () => {
    const native = {
      provider: 'codex' as const, threadId: 'future-thread', eventId: 'future-1', delivery: 'live' as const,
    };
    const first = row(1, {
      type: 'provider.unmapped', nativePayload: { newShape: ['kept', 7] }, providerEvent: native,
    });
    const replay = {
      ...first, seq: 2,
      providerEvent: { ...native, delivery: 'replay' as const },
    } as WbpEvent;

    const plan = planCanonicalProjection([first, replay]);

    expect(plan.duplicateEvents).toBe(1);
    expect(plan.projectedEvents).toEqual([first]);
    expect(plan.projectedEvents[0]).toMatchObject({ nativePayload: { newShape: ['kept', 7] } });
  });

  it('dry-runs an affected session without modifying its append-only source', () => {
    const opened = store();
    const before = opened.eventsSince(SESSION, 0);

    const audit = opened.auditCanonicalProjection(SESSION);

    expect(audit.sourceEvents).toBe(14);
    expect(audit.duplicateEvents).toBe(7);
    expect(audit.duplicates.map((row) => row.key)).toEqual([
      'legacy:message:answer', 'legacy:tool:spawn', 'legacy:agent:reviewer',
    ]);
    expect(opened.eventsSince(SESSION, 0)).toEqual(before);
    opened.close();
  });

  it('atomically switches to one deduplicated view while retaining every source row', () => {
    const opened = store();
    const before = opened.eventsSince(SESSION, 0);

    const rebuilt = opened.rebuildCanonicalProjection(SESSION);
    const after = opened.eventsSince(SESSION, 0);
    const view = foldAll(after);

    expect(rebuilt.duplicateEvents).toBe(7);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after[before.length]).toMatchObject({ type: 'transcript.reset', seq: rebuilt.resetSeq });
    expect(view.items.filter((item) => item.kind === 'message')).toHaveLength(1);
    expect(view.items.filter((item) => item.kind === 'message')[0]).toMatchObject({ text: 'Only once.' });
    expect(view.items.filter((item) => item.kind === 'tool')).toHaveLength(1);
    expect(view.agents).toHaveLength(1);
    expect(view.agents[0]).toMatchObject({ id: 'reviewer', state: 'done' });
    expect(opened.search('Only once.')).toHaveLength(1);

    // A second audit examines the active projection after the reset, not its
    // preserved source, and therefore reports a clean session.
    expect(opened.auditCanonicalProjection(SESSION).duplicateEvents).toBe(0);
    opened.close();
  });
});
