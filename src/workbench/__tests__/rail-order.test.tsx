/**
 * The order of the chat's right-hand column, pinned (bw-7ks.22.33).
 *
 * Sent away first, then the cards, then the reports — because the agents are
 * the only part of the column that moves. Cards and reports are a record and
 * will still be there in an hour; a helper four minutes into its work is what
 * the reader opened the rail for, and it does not belong under two lists that
 * are finished with (docs/agent-workbench.md §8.2.6).
 *
 * Pinned here because the doc and the built column had drifted into naming two
 * different orders for the same rail, and nothing on either side noticed.
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

const rail = (agents: SentAway[], cards: string[], reports: { project: string; slug: string; title: string }[]) =>
  render(
    <ChatRightRail
      items={[]}
      projectId="beads-web"
      cards={cards}
      reports={reports}
      agents={agents}
      sessionId="chat-1"
      agentControls={['stop']}
      onOpenAgent={() => {}}
      open
      onToggle={() => {}}
    />,
  );

describe('what the rail holds, in order', () => {
  it('puts the only moving part at the top', () => {
    rail(oneAgent(), ['bw-uiyz.1'], [{ project: 'beads-web', slug: 'a-report', title: 'A report' }]);

    expect(sections()).toEqual(['Sent away', 'Cards it has touched', 'Reports it produced']);
  });

  it('keeps that order when a section has nothing in it', () => {
    // A missing section is missing, not blank: the ones that are there keep
    // their places rather than shuffling up into a fixed slot.
    rail(oneAgent(), [], [{ project: 'beads-web', slug: 'a-report', title: 'A report' }]);
    expect(sections()).toEqual(['Sent away', 'Reports it produced']);
  });

  it('says so plainly when the chat has touched nothing at all', () => {
    rail([], [], []);
    expect(sections()).toEqual([]);
    expect(screen.getByTestId('rail-empty')).toBeInTheDocument();
  });
});
