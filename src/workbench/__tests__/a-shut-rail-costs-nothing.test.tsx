/**
 * A rail nobody has open asks git nothing and draws no file rows (bw-o5i3.2).
 *
 * The rail keeps its body mounted whether or not it is showing, so the fold
 * has something to fade. That is right for the fold and was wrong for
 * everything else: a shut rail went on asking git for the whole working tree's
 * status every five seconds and went on drawing a row for every path it named.
 * The Files tab pins the rail to its Git view, so it happened there on every
 * visit, open or shut; the Chat tab did it too for anyone who had ever picked
 * Git, because that choice is remembered in the browser.
 *
 * The fix is a flag and not an unmount, so the fade still has a panel to fade
 * and the panel's own state — a half-written commit message above all — is
 * still there when the rail comes back.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitStatus } from '@/lib/api';
import { ChatRightRail } from '@/workbench/chat-right-rail';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const calls = vi.hoisted(() => ({
  status: vi.fn(),
  log: vi.fn(),
  branches: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
  commit: vi.fn(),
  fetch: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
  checkout: vi.fn(),
  watch: vi.fn(() => () => {}),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const REPO = '/tmp/a-project';

/** See the note on the same helper in a-long-file-list-draws-a-screenful. */
beforeAll(() => {
  for (const [side, size] of [['offsetHeight', 600], ['clientHeight', 600], ['offsetWidth', 320], ['clientWidth', 320]] as const) {
    Object.defineProperty(HTMLElement.prototype, side, { configurable: true, get: () => size });
  }
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ width: 320, height: 600, top: 0, left: 0, right: 320, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  HTMLElement.prototype.scrollTo = () => {};
});

beforeEach(() => {
  calls.status.mockReset();
  calls.status.mockResolvedValue({
    branch: 'main',
    upstream: 'origin/main',
    pushTo: null,
    ahead: 0,
    behind: 0,
    detached: false,
    staged: [],
    unstaged: [],
    conflicted: [],
    untracked: Array.from({ length: 5_099 }, (_, at) => ({ path: `.venv/lib/thing-${at}.py` })),
  } as unknown as GitStatus);
  calls.log.mockResolvedValue({ commits: [] });
  calls.branches.mockResolvedValue({ branches: [] });
});

function rail(open: boolean) {
  return render(
    <ChatRightRail
      projectId="a-project"
      cards={[]}
      agents={[]}
      items={[]}
      sessionId="chat-1"
      agentControls={[]}
      onOpenAgent={() => {}}
      open={open}
      view="git"
      projectPath={REPO}
      desktopWidth={320}
      onToggle={() => {}}
    />,
  );
}

describe('the rail on its Git view', () => {
  it('asks git nothing and draws no file rows while it is shut', async () => {
    const drawn = rail(false);

    // The panel is there for the fold to fade — it is only not working.
    expect(await screen.findByTestId('chat-right-rail')).toBeTruthy();
    await new Promise((settled) => setTimeout(settled, 50));
    expect(calls.status).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId('git-file')).toHaveLength(0);
    expect(screen.queryByTestId('git-untracked')).toBeNull();

    drawn.unmount();
  });

  it('asks and draws as soon as it is open', async () => {
    rail(true);

    const section = await screen.findByTestId('git-untracked-rows');
    expect(calls.status).toHaveBeenCalled();
    await waitFor(() => expect(within(section).getAllByTestId('git-file').length).toBeGreaterThan(0));
    expect(within(section).getAllByTestId('git-file').length).toBeLessThan(60);
  }, 30_000);
});
