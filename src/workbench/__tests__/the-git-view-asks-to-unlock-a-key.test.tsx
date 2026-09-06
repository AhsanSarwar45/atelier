/**
 * The way out of a push that failed for want of an unlocked key (bw-k778.5).
 *
 * Talking to the shared copy uses the keys the user's own setup carries, and
 * when the key that would let the call through is locked, ssh has nowhere to
 * ask: the server has no terminal, and until this the call simply failed where
 * nobody could answer it. The panel now offers to ask, and that offer is only
 * worth anything if it runs the very call the reader asked for — a push that
 * was setting an upstream is still setting one on the second go.
 *
 * What is asserted here is the panel's half: when the offer is made, when it
 * is not, what is sent when it is answered, and that nothing of the passphrase
 * is left behind afterwards. The offer is made *instead of* an error and not
 * beside one (bw-8nwh.1) — a locked key is a question the next keystroke
 * answers, so the red panel is kept for a passphrase that opened nothing, or
 * for a failure no key would clear. Whether the passphrase actually opens the key is
 * the server's half, and is proved against a real ssh there.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type GitStatus } from '@/lib/api';
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
  commit: vi.fn(),
  fetch: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
  branches: vi.fn(),
  checkout: vi.fn(),
}));

vi.mock('@/lib/api', async (whatItReallyIs) => ({
  ...(await whatItReallyIs<Record<string, unknown>>()),
  git: calls,
}));

const REPO = '/tmp/a-project';

/** ssh's own words, and the same in every case — which is why the flag exists. */
const DENIED = 'git@github.com: Permission denied (publickey).';

/** A branch with nowhere to push yet, so the push carries `setUpstream`. */
const NOTHING_TO_FOLLOW: GitStatus = {
  branch: 'a-line-of-work',
  upstream: null,
  ahead: 1,
  behind: 0,
  detached: false,
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
};

/** The refusal the server marks as one a passphrase could clear. */
function lockedKey() {
  return new ApiError(`API error: 401 ${DENIED}`, 401, { error: DENIED, needsPassphrase: true });
}

/** A refusal no passphrase would help with. */
function rejectedPush() {
  const said = ' ! [rejected]        main -> main (non-fast-forward)';
  return new ApiError(`API error: 422 ${said}`, 422, { error: said });
}

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

/** Press Push and wait for the call to have been made. */
async function push() {
  fireEvent.click(screen.getByTestId('git-push'));
  await waitFor(() => expect(calls.push).toHaveBeenCalled());
}

describe('a push that needs a key unlocked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.status.mockResolvedValue(NOTHING_TO_FOLLOW);
    calls.log.mockResolvedValue({ commits: [] });
  });

  it('asks for the passphrase and nothing else — no error is drawn', async () => {
    calls.push.mockRejectedValue(lockedKey());
    railOnGit();
    await waitFor(() => expect(calls.status).toHaveBeenCalled());

    await push();

    await waitFor(() => expect(screen.getByTestId('git-passphrase')).toBeInTheDocument());
    // A locked key is a question, not a failure: the way on is the box, and
    // ssh's three lines of stderr over it would only say the same thing in red
    // (bw-8nwh.1).
    expect(screen.queryByTestId('git-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('git-passphrase-refused')).not.toBeInTheDocument();
  });

  it('sends the passphrase with the very call that was refused', async () => {
    calls.push.mockRejectedValueOnce(lockedKey()).mockResolvedValueOnce({ ok: true, output: '' });
    railOnGit();
    await waitFor(() => expect(calls.status).toHaveBeenCalled());
    await push();
    await waitFor(() => expect(screen.getByTestId('git-passphrase')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('SSH key passphrase'), {
      target: { value: 'open sesame' },
    });
    fireEvent.click(screen.getByTestId('git-unlock'));

    await waitFor(() => expect(calls.push).toHaveBeenCalledTimes(2));
    // The branch still has nowhere to follow, so the second go is still the
    // push the reader asked for, upstream and all.
    expect(calls.push.mock.calls[0]).toEqual([REPO, true, undefined]);
    expect(calls.push.mock.calls[1]).toEqual([REPO, true, 'open sesame']);
  });

  it('puts the asking away once the key has opened', async () => {
    calls.push.mockRejectedValueOnce(lockedKey()).mockResolvedValueOnce({ ok: true, output: '' });
    railOnGit();
    await waitFor(() => expect(calls.status).toHaveBeenCalled());
    await push();
    await waitFor(() => expect(screen.getByTestId('git-passphrase')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('SSH key passphrase'), {
      target: { value: 'open sesame' },
    });
    fireEvent.click(screen.getByTestId('git-unlock'));

    await waitFor(() => expect(screen.queryByTestId('git-passphrase')).not.toBeInTheDocument());
    expect(screen.queryByTestId('git-error')).not.toBeInTheDocument();
  });

  it('keeps nothing of a passphrase that did not work, and asks again', async () => {
    calls.push.mockRejectedValue(lockedKey());
    railOnGit();
    await waitFor(() => expect(calls.status).toHaveBeenCalled());
    await push();
    await waitFor(() => expect(screen.getByTestId('git-passphrase')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('SSH key passphrase'), {
      target: { value: 'the wrong one' },
    });
    fireEvent.click(screen.getByTestId('git-unlock'));
    await waitFor(() => expect(calls.push).toHaveBeenCalledTimes(2));

    // Still asking, and the field is empty rather than holding what failed.
    expect(screen.getByTestId('git-passphrase')).toBeInTheDocument();
    expect(screen.getByLabelText('SSH key passphrase')).toHaveValue('');
    // The one word about it is said inside the prompt, quietly, because the
    // reader is still in the middle of the thing rather than done failing at
    // it (bw-8nwh.1).
    expect(screen.getByTestId('git-passphrase-refused')).toHaveTextContent(
      'That passphrase did not unlock the key. Try again.',
    );
    expect(screen.queryByTestId('git-error')).not.toBeInTheDocument();
  });

  it('drops the asking and shows git’s words when the retry fails for another reason', async () => {
    calls.push.mockRejectedValueOnce(lockedKey()).mockRejectedValueOnce(rejectedPush());
    railOnGit();
    await waitFor(() => expect(calls.status).toHaveBeenCalled());
    await push();
    await waitFor(() => expect(screen.getByTestId('git-passphrase')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('SSH key passphrase'), {
      target: { value: 'open sesame' },
    });
    fireEvent.click(screen.getByTestId('git-unlock'));

    await waitFor(() => expect(screen.getByTestId('git-error')).toHaveTextContent('non-fast-forward'));
    expect(screen.queryByTestId('git-passphrase')).not.toBeInTheDocument();
  });

  it('lets the asking be waved away, leaving no error behind', async () => {
    calls.push.mockRejectedValue(lockedKey());
    railOnGit();
    await waitFor(() => expect(calls.status).toHaveBeenCalled());
    await push();
    await waitFor(() => expect(screen.getByTestId('git-passphrase')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('git-unlock-cancel'));

    expect(screen.queryByTestId('git-passphrase')).not.toBeInTheDocument();
    // Saying no leaves the panel as it was: there is nothing to report.
    expect(screen.queryByTestId('git-error')).not.toBeInTheDocument();
  });

  it('does not offer a passphrase for a refusal no key would clear', async () => {
    calls.push.mockRejectedValue(rejectedPush());
    railOnGit();
    await waitFor(() => expect(calls.status).toHaveBeenCalled());

    await push();

    await waitFor(() => expect(screen.getByTestId('git-error')).toHaveTextContent('non-fast-forward'));
    expect(screen.queryByTestId('git-passphrase')).not.toBeInTheDocument();
  });
});
