/**
 * The strip at the top of the right column (bw-rpgh.4).
 *
 * Git used to be a button on the tab bar that opened the column and chose what
 * was in it at once. It is a view of the column now, so the column says which
 * of its views it is on and offers the other. A rail given one view — the Files
 * tab's, which has no chat to have sent anything away — draws the strip anyway,
 * with the one tab on it.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import type { GitStatus } from '@/lib/api';
import { ChatRightRail, type RailView } from '@/workbench/chat-right-rail';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const calls = vi.hoisted(() => ({
  status: vi.fn(),
  log: vi.fn(),
  branches: vi.fn(),
  watch: vi.fn(),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

function standing(): GitStatus {
  return {
    branch: 'main',
    upstream: 'origin/main',
    pushTo: null,
    ahead: 0,
    behind: 0,
    detached: false,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };
}

function rail(over: { view?: RailView; views?: readonly RailView[]; onPickView?: (v: RailView) => void } = {}) {
  return render(
    <ChatRightRail
      projectId="a-project"
      cards={[]}
      agents={[]}
      items={[]}
      sessionId="chat-1"
      agentControls={[]}
      onOpenAgent={() => {}}
      open
      view="chat"
      projectPath="/tmp/a-worktree"
      desktopWidth={320}
      onToggle={() => {}}
      {...over}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  calls.status.mockResolvedValue(standing());
  calls.log.mockResolvedValue({ commits: [] });
  calls.branches.mockResolvedValue({ branches: [] });
  calls.watch.mockReturnValue(() => {});
});

it('offers both views and says which one is drawn', () => {
  rail({ view: 'chat' });

  expect(screen.getByTestId('rail-tab-chat')).toHaveTextContent('Agents');
  expect(screen.getByTestId('rail-tab-git')).toHaveTextContent('Git');
  expect(screen.getByTestId('rail-tab-chat')).toHaveAttribute('data-state', 'active');
  expect(screen.getByTestId('rail-tab-git')).toHaveAttribute('data-state', 'inactive');
});

it('asks for the view whose tab was pressed', () => {
  const picked: RailView[] = [];
  rail({ view: 'chat', onPickView: (v) => picked.push(v) });

  // Radix acts on the press, not on the click that follows it — which is what
  // a tap on a phone reports first as well.
  fireEvent.mouseDown(screen.getByTestId('rail-tab-git'), { button: 0 });
  expect(picked).toEqual(['git']);
});

it('draws only the tabs it was given', () => {
  rail({ view: 'git', views: ['git'] });

  expect(screen.getByTestId('rail-tab-git')).toBeVisible();
  expect(screen.queryByTestId('rail-tab-chat')).toBeNull();
});
