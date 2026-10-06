import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sendCommand = vi.fn();
vi.mock('@/workbench/use-session', () => ({ sendCommand: (...args: unknown[]) => sendCommand(...args) }));

import { forgetStanding, SignedOutMark, signedOut, useStanding } from '@/workbench/account-standing';
import type { ProfileStanding } from '@/workbench/protocol';

const out: ProfileStanding = { signedIn: false, account: null, plan: null, how: null, unknown: null };
const inn: ProfileStanding = { ...out, signedIn: true };
const unsure: ProfileStanding = { ...out, unknown: 'claude did not answer in time.' };

function Row({ id }: { id: string }) {
  const standing = useStanding('claude');
  return (
    <div data-testid={`row-${id}`}>
      {id}
      <SignedOutMark standing={standing?.[id]} />
    </div>
  );
}

// Unmounted first, or the forgetting asks again and the answer is kept for the next case.
afterEach(() => {
  cleanup();
  forgetStanding();
  sendCommand.mockReset();
});

describe('an account picker warns about a signed-out account', () => {
  it('marks only an account the provider said is signed out', () => {
    expect(signedOut(out)).toBe(true);
    expect(signedOut(inn)).toBe(false);
    // Not knowing is not signed out.
    expect(signedOut(unsure)).toBe(false);
    expect(signedOut(undefined)).toBe(false);
  });

  it('draws the mark beside the signed-out account, and asks once for every row', async () => {
    sendCommand.mockResolvedValue({ standing: { system: inn, work: out, other: unsure } });
    render(
      <>
        <Row id="system" />
        <Row id="work" />
        <Row id="other" />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('row-work').querySelector('[data-testid=signed-out-mark]')).not.toBeNull());
    expect(screen.getByLabelText('Signed out')).toBeTruthy();
    expect(screen.getByTestId('row-system').querySelector('[data-testid=signed-out-mark]')).toBeNull();
    expect(screen.getByTestId('row-other').querySelector('[data-testid=signed-out-mark]')).toBeNull();
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith({ type: 'profiles.standing', brand: 'claude' });
  });

  it('takes the mark away once a sign-in has finished', async () => {
    sendCommand.mockResolvedValueOnce({ standing: { work: out } });
    render(<Row id="work" />);
    await waitFor(() => expect(screen.queryByTestId('signed-out-mark')).not.toBeNull());
    sendCommand.mockResolvedValueOnce({ standing: { work: inn } });
    act(() => forgetStanding());
    await waitFor(() => expect(screen.queryByTestId('signed-out-mark')).toBeNull());
  });
});
