/**
 * Nothing destructive happens on one press (bw-8nwh.3).
 *
 * Discard, Discard all and Delete each throw away work git keeps no copy of:
 * an unstaged edit that is discarded is gone, and a file git has never been
 * told about that is deleted is gone from the disk. So each of them asks
 * first, and the asking is the app's own modal dialog (bw-ahf2.1) rather than
 * the browser's `window.confirm` — which is drawn outside the app, blocks the
 * page while it is up, and cannot be reached by the end-to-end run without
 * special handling.
 *
 * What is asserted here is the only thing that matters about a confirmation:
 * that pressing the action makes NO call, that agreeing makes exactly the one
 * call it named, and that Keep makes none at all and leaves the file alone.
 * That the call then does the right thing to a repository is proved against
 * real git on the server side.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GitStatus } from '@/lib/api';
import { ChatRightRail } from '@/workbench/chat-right-rail';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const calls = vi.hoisted(() => ({
  status: vi.fn(),
  log: vi.fn(),
  stage: vi.fn(),
  unstage: vi.fn(),
  stageAll: vi.fn(),
  unstageAll: vi.fn(),
  discard: vi.fn(),
  discardAll: vi.fn(),
  remove: vi.fn(),
  commit: vi.fn(),
  fetch: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
  branches: vi.fn(),
  checkout: vi.fn(),
  // The view subscribes to the repository while it is mounted (bw-8nwh.2);
  // hand back a no-op unsubscribe so mounting it is not a crash here.
  watch: vi.fn(() => () => {}),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const REPO = '/tmp/a-project';

/** The file whose unstaged edit is the thing that would be thrown away. */
const CHANGED = 'src/changed.ts';

/** And the one git has never been told about, which would be deleted. */
const NEW = 'brand-new.ts';

const CHANGED_AND_NEW: GitStatus = {
  branch: 'a-line-of-work',
  upstream: 'origin/a-line-of-work',
  ahead: 0,
  behind: 0,
  detached: false,
  staged: [{ path: 'already-picked.ts', status: 'added', origPath: null }],
  unstaged: [{ path: CHANGED, status: 'modified', origPath: null }],
  untracked: [{ path: NEW }],
  conflicted: [],
};

const HISTORY = {
  commits: [
    {
      sha: '1111111111111111111111111111111111111111',
      shortSha: '1111111',
      author: 'Somebody',
      email: 'somebody@example.com',
      date: '2026-08-27T10:00:00.000Z',
      subject: 'the words the last save was made under',
    },
  ],
};

function railOnGit() {
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
      view="git"
      projectPath={REPO}
      desktopWidth={320}
      onToggle={() => {}}
    />,
  );
}

/** Draw the panel and wait until it has read the repository once. */
async function panel() {
  railOnGit();
  await waitFor(() => expect(calls.status).toHaveBeenCalled());
  await screen.findByTestId('git-unstaged');
}

/** Every call that changes the repository, so "nothing happened" is provable. */
function everyWrite() {
  return [
    calls.stage,
    calls.unstage,
    calls.stageAll,
    calls.unstageAll,
    calls.discard,
    calls.discardAll,
    calls.remove,
    calls.commit,
  ];
}

describe('the panel asks before it throws work away', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.status.mockResolvedValue(CHANGED_AND_NEW);
    calls.log.mockResolvedValue(HISTORY);
    calls.discard.mockResolvedValue({ ok: true });
    calls.discardAll.mockResolvedValue({ ok: true });
    calls.remove.mockResolvedValue({ ok: true });
    calls.stageAll.mockResolvedValue({ ok: true });
    calls.unstageAll.mockResolvedValue({ ok: true });
    calls.commit.mockResolvedValue({ sha: 'deadbeef' });
  });

  it('makes no call at all when Discard is pressed — it asks, and names the file', async () => {
    await panel();

    fireEvent.click(screen.getByTestId('git-discard'));

    const asking = await screen.findByTestId('git-confirm-dialog');
    // The strip names the very file, so agreeing is agreeing to something.
    expect(asking).toHaveTextContent(CHANGED);
    for (const write of everyWrite()) expect(write).not.toHaveBeenCalled();
  });

  it('discards the file, and only that file, once it is agreed to', async () => {
    await panel();
    fireEvent.click(screen.getByTestId('git-discard'));
    await screen.findByTestId('git-confirm-dialog');

    fireEvent.click(screen.getByTestId('git-confirm'));

    await waitFor(() => expect(calls.discard).toHaveBeenCalledTimes(1));
    expect(calls.discard).toHaveBeenCalledWith(REPO, [CHANGED]);
    // And the asking is put away, so a second press cannot happen by accident.
    await waitFor(() => expect(screen.queryByTestId('git-confirm-dialog')).toBeNull());
    // The panel reads the repository again rather than guessing what changed.
    await waitFor(() => expect(calls.status).toHaveBeenCalledTimes(2));
  });

  it('makes no call and leaves the file alone when Keep is pressed', async () => {
    await panel();
    fireEvent.click(screen.getByTestId('git-discard'));
    await screen.findByTestId('git-confirm-dialog');

    fireEvent.click(screen.getByTestId('git-confirm-cancel'));

    await waitFor(() => expect(screen.queryByTestId('git-confirm-dialog')).toBeNull());
    for (const write of everyWrite()) expect(write).not.toHaveBeenCalled();
    // The row is still there, still not staged.
    expect(screen.getByTestId('git-unstaged')).toHaveTextContent('changed.ts');
  });

  it('makes no call and leaves the file alone when Escape is pressed', async () => {
    await panel();
    fireEvent.click(screen.getByTestId('git-discard'));
    const asking = await screen.findByTestId('git-confirm-dialog');

    fireEvent.keyDown(asking, { key: 'Escape', code: 'Escape' });

    // Escape is the same word as Keep, down to making no call at all.
    await waitFor(() => expect(screen.queryByTestId('git-confirm-dialog')).toBeNull());
    for (const write of everyWrite()) expect(write).not.toHaveBeenCalled();
    expect(screen.getByTestId('git-unstaged')).toHaveTextContent('changed.ts');
  });

  it('asks in a dialog over the app, not as a strip inside the panel', async () => {
    await panel();
    fireEvent.click(screen.getByTestId('git-discard'));
    const asking = await screen.findByTestId('git-confirm-dialog');

    // bw-ahf2.1: the question is the app's own modal, so it is not drawn
    // inside the scrolling panel where it could be scrolled past.
    expect(screen.getByTestId('git-view')).not.toContainElement(asking);
    expect(screen.queryByTestId('git-confirm-strip')).toBeNull();
    // Announced as a decision that has to be answered, not as a form.
    expect(asking).toHaveAttribute('role', 'alertdialog');
  });

  it('asks the same way before deleting a file git has never been told about', async () => {
    await panel();

    fireEvent.click(screen.getByTestId('git-remove'));
    const asking = await screen.findByTestId('git-confirm-dialog');
    expect(asking).toHaveTextContent(NEW);
    expect(calls.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('git-confirm'));
    await waitFor(() => expect(calls.remove).toHaveBeenCalledWith(REPO, [NEW]));
  });

  it('asks before discarding everything, and says that ignored files are kept', async () => {
    await panel();

    fireEvent.click(screen.getByTestId('git-discard-all'));
    const asking = await screen.findByTestId('git-confirm-dialog');
    // The reader has to know this is not the button that eats their .env.
    expect(asking).toHaveTextContent(/ignored files are kept/i);
    expect(calls.discardAll).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('git-confirm'));
    await waitFor(() => expect(calls.discardAll).toHaveBeenCalledWith(REPO));
  });
});

describe('the bulk actions, which take nothing back and so ask nothing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.status.mockResolvedValue(CHANGED_AND_NEW);
    calls.log.mockResolvedValue(HISTORY);
    calls.stageAll.mockResolvedValue({ ok: true });
    calls.unstageAll.mockResolvedValue({ ok: true });
    calls.commit.mockResolvedValue({ sha: 'deadbeef' });
  });

  it('picks everything up on the spot', async () => {
    await panel();

    // Two groups carry a Stage all; either is the same `git add -A`.
    fireEvent.click(
      screen.getByTestId('git-unstaged').querySelector('[data-testid="git-stage-all"]') as Element,
    );

    await waitFor(() => expect(calls.stageAll).toHaveBeenCalledWith(REPO));
    expect(screen.queryByTestId('git-confirm-dialog')).toBeNull();
  });

  it('puts everything back on the spot', async () => {
    await panel();

    fireEvent.click(screen.getByTestId('git-unstage-all'));

    await waitFor(() => expect(calls.unstageAll).toHaveBeenCalledWith(REPO));
    expect(screen.queryByTestId('git-confirm-dialog')).toBeNull();
  });
});

describe('rewriting the last saved change', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.status.mockResolvedValue(CHANGED_AND_NEW);
    calls.log.mockResolvedValue(HISTORY);
    calls.commit.mockResolvedValue({ sha: 'deadbeef' });
  });

  it('borrows the last commit’s wording when there is nothing typed', async () => {
    await panel();

    fireEvent.click(screen.getByTestId('git-amend'));

    await waitFor(() =>
      expect(screen.getByTestId('git-commit-message')).toHaveValue(
        'the words the last save was made under',
      ),
    );
  });

  it('amends rather than adding a commit, and goes back off once it has', async () => {
    await panel();
    fireEvent.click(screen.getByTestId('git-amend'));
    await waitFor(() => expect(screen.getByTestId('git-commit-message')).not.toHaveValue(''));

    fireEvent.change(screen.getByTestId('git-commit-message'), {
      target: { value: 'the wording, said better' },
    });
    fireEvent.click(screen.getByTestId('git-commit'));

    await waitFor(() =>
      expect(calls.commit).toHaveBeenCalledWith(REPO, 'the wording, said better', true),
    );
    // An amend is never the thing that quietly happens to the next one too.
    await waitFor(() => expect(screen.getByTestId('git-commit')).toHaveTextContent(/^Commit/));
  });
});
