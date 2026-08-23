/**
 * The way out of a panel that covers the whole screen.
 *
 * On a phone these panels ARE the screen — no dimmed page around the edge to
 * tap, and a small cross in one corner. Two of the four had no key out at all:
 * a reader who did not spot the cross was stuck looking at a token picture with
 * their conversation somewhere behind it (bw-81wt.18).
 *
 * So the shell every panel wears owns the way out, and this asks each panel for
 * it rather than asking the shell: what matters is that the panel a reader
 * actually opens closes, whoever wires it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Mentions } from '@/components/markdown-body';
import { AgentView } from '@/workbench/agent-view';
import type { SentAway } from '@/workbench/fold';
import { SearchPanel } from '@/workbench/search-panel';
import { TokenView } from '@/workbench/token-view';
import { UsageView } from '@/workbench/usage-view';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/api', () => ({ projects: { list: () => Promise.resolve([]) } }));
vi.mock('@/workbench/live', () => ({
  usePlanUsage: () => ({
    available: false,
    plan: null,
    session: null,
    week: null,
    perModel: [],
    credits: null,
    driving: [],
    at: '2026-08-22T09:00:00.000Z',
  }),
}));

/** Draw it and let whatever it asked for on the way up settle. */
const drawn = async (node: React.ReactElement) => {
  let out!: ReturnType<typeof render>;
  await act(async () => {
    out = render(node);
  });
  return out;
};

/** Nothing this file asks about needs an answer from the machine. */
vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })));

/** Words drawn as themselves: nothing here is about how a message is marked up. */
const PLAINLY: Mentions = { split: (text) => [{ kind: 'text', text }], card: () => null, report: () => null };

/**
 * One finished helper, written out here rather than folded from a log.
 *
 * Finished on purpose: a running one starts a clock of its own, and this file
 * asks one question — does the panel close — which a ticking second hand can
 * only make flaky.
 */
const HELPER: SentAway = {
  id: 'task-1',
  toolCallId: null,
  kind: 'helper',
  what: 'read the board',
  agentType: null,
  model: null,
  state: 'done',
  startedAt: 0,
  seconds: 2,
  tokens: 120,
  calls: 1,
  doing: null,
  result: 'it read the board',
  relayed: [],
};

const escape = () =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });

const panels = [
  ['the search panel', 'search-panel', (onClose: () => void) => <SearchPanel onClose={onClose} />],
  ['the tokens panel', 'token-view', (onClose: () => void) => <TokenView sessionId="chat-1" onClose={onClose} />],
  ['the plan usage panel', 'usage-view', (onClose: () => void) => <UsageView onClose={onClose} />],
  // Wears the same shell as the three above and was the one left out of this
  // list, so a break in the shell's way out would have taken it in silence
  // (bw-81wt.26).
  [
    "one agent's own conversation",
    'agent-view',
    (onClose: () => void) => (
      <AgentView row={HELPER} items={[]} sessionId="chat-1" controls={[]} mentions={PLAINLY} onClose={onClose} />
    ),
  ],
] as const;

afterEach(() => {
  vi.clearAllMocks();
});

describe('a panel that covers the screen', () => {
  for (const [what, testId, draw] of panels) {
    it(`${what} closes when Escape is pressed`, async () => {
      const onClose = vi.fn();
      await drawn(draw(onClose));
      expect(screen.getByTestId(testId), `${what} did not draw`).toBeTruthy();
      escape();
      expect(onClose, `${what} ignored Escape`).toHaveBeenCalled();
    });

    it(`${what} closes when the page behind it is clicked`, async () => {
      const onClose = vi.fn();
      await drawn(draw(onClose));
      fireEvent.click(screen.getByTestId(testId));
      expect(onClose, `${what} ignored a click on the page behind it`).toHaveBeenCalled();
    });

    it(`${what} stops listening once it is gone`, async () => {
      const onClose = vi.fn();
      const { unmount } = await drawn(draw(onClose));
      unmount();
      escape();
      expect(onClose, `${what} is still listening after it was taken away`).not.toHaveBeenCalled();
    });
  }
});
