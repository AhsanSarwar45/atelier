/**
 * The order of the chat's right-hand column, pinned (bw-pl2v.1).
 *
 * The agents it sent off, and nothing in their place when there are none
 * (docs/agent-workbench.md §8.2.6).
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ChatRightRail } from '@/workbench/chat-right-rail';
import { foldAll, type SentAway } from '@/workbench/fold';
import type { WbpEvent } from '@/workbench/protocol';

// The chips inside two of the sections navigate; nothing here clicks one, and a
// page without the router mounted is the only thing standing between this and
// the order it is here to read.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

/** One helper still running, so the rail has an agents section to draw. */
function oneAgent(): SentAway[] {
  return foldAll([
    {
      type: 'agent.started',
      agentId: 'task-1',
      toolCallId: 'call-1',
      kind: 'helper',
      what: 'count the rows',
      agentType: 'general-purpose',
      model: 'claude-fable-5',
      seq: 1,
      sessionId: 'chat-1',
      at: '2026-08-20T09:00:00.000Z',
    } as WbpEvent,
  ]).agents;
}

/** The titles of the rail's sections, top to bottom. */
function sections(): string[] {
  const body = screen.getByTestId('chat-right-rail-body');
  return within(body)
    .queryAllByRole('heading', { level: 3 })
    .map((h) => h.textContent ?? '');
}

const rail = (agents: SentAway[]) =>
  render(
    <ChatRightRail
      items={[]}
      projectId="beads-web"
      agents={agents}
      sessionId="chat-1"
      agentControls={['stop']}
      onOpenAgent={() => {}}
      open
      desktopWidth={288}
      onToggle={() => {}}
    />,
  );

describe('what the rail holds, in order', () => {
  it('draws the agents it sent off', () => {
    rail(oneAgent());
    expect(sections()).toEqual(['Subagents']);
  });

  it('says so plainly when the chat has touched nothing at all', () => {
    rail([]);
    expect(sections()).toEqual([]);
    expect(screen.queryByTestId('rail-empty')).not.toBeInTheDocument();
  });
});
