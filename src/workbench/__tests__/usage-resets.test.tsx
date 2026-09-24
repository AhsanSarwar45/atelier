import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlanResets, PlanWindow } from '@/workbench/plan-usage';
import { clearsReads, expiryReads } from '@/workbench/plan-usage';

const request = vi.fn();
vi.mock('@/lib/api', () => ({ request: (...args: unknown[]) => request(...args) }));

import { Resets } from '@/workbench/usage-view';

const windows: PlanWindow[] = [
  { key: 'session', label: 'This session', percent: 2, resetsAt: null, severity: 'normal' },
  { key: 'week', label: 'This week', percent: 18, resetsAt: null, severity: 'normal' },
];

const resets: PlanResets = {
  available: 1,
  blocked: null,
  items: [
    {
      id: 'launch',
      title: 'Launch reset',
      detail: null,
      grantedAt: '2026-09-22T16:00:00.000Z',
      expiresAt: '2026-10-22T16:00:00.000Z',
      usable: true,
      left: 1,
      clears: ['session', 'week'],
    },
  ],
};

const now = new Date('2026-09-24T12:00:00Z');

afterEach(() => request.mockReset());

describe('usage resets', () => {
  it('says what a reset refills and when it expires', () => {
    expect(clearsReads(['session', 'week'])).toBe('session and weekly limits');
    expect(clearsReads([])).toBe('usage limits');
    expect(expiryReads('2026-10-22T16:00:00.000Z', 'UTC')).toBe('22 Oct, 16:00');
    expect(expiryReads(null)).toBeNull();

    render(<Resets resets={resets} windows={windows} brand="claude" now={now} />);
    expect(screen.getByText('Launch reset')).toBeInTheDocument();
    expect(screen.getByText('1 available')).toBeInTheDocument();
    expect(screen.getByTestId('usage-reset-expiry').textContent).toMatch(/Expires .* · in 28d/);
    expect(screen.getByText('Refills your session and weekly limits')).toBeInTheDocument();
  });

  it('uses a reset only after the reader confirms', async () => {
    request.mockResolvedValue({ ok: true, json: async () => ({ outcome: 'reset', message: 'Usage limits reset.' }) });
    render(<Resets resets={resets} windows={windows} brand="codex" profile="work" now={now} />);

    fireEvent.click(screen.getByTestId('usage-reset-use'));
    expect(screen.getByTestId('usage-reset-confirmation').textContent).toContain(
      'You have used 2% of your session limit and 18% of your weekly limit.',
    );
    expect(request).not.toHaveBeenCalled();

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('usage-reset-cancel'));
    await waitFor(() => expect(screen.queryByTestId('usage-reset-confirmation')).toBeNull());
    expect(request).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('usage-reset-use'));
    fireEvent.keyDown(screen.getByTestId('usage-reset-confirmation'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('usage-reset-confirmation')).toBeNull());
    expect(request).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('usage-reset-use'));
    fireEvent.click(screen.getByTestId('usage-reset-confirm'));
    await waitFor(() => expect(screen.getByTestId('usage-reset-outcome').textContent).toBe('Usage limits reset.'));
    expect(request).toHaveBeenCalledTimes(1);
    const [path, options] = request.mock.calls[0] as [string, { body: string }];
    expect(path).toBe('/api/workbench/usage/reset');
    const body = JSON.parse(options.body) as Record<string, unknown>;
    expect(body).toMatchObject({ brand: 'codex', profile: 'work', id: 'launch' });
    expect(typeof body.attempt).toBe('string');
  });

  it('retries an unconfirmed attempt under the same attempt id', async () => {
    request.mockResolvedValue({ ok: true, json: async () => ({ outcome: 'unconfirmed', message: 'Could not confirm.' }) });
    render(<Resets resets={resets} windows={windows} brand="claude" now={now} />);
    for (let i = 0; i < 2; i += 1) {
      fireEvent.click(screen.getByTestId('usage-reset-use'));
      fireEvent.click(screen.getByTestId('usage-reset-confirm'));
      await waitFor(() => expect(request).toHaveBeenCalledTimes(i + 1));
      await waitFor(() => expect(screen.getByTestId('usage-reset-use')).not.toBeDisabled());
    }
    const attempts = request.mock.calls.map(([, o]) => (JSON.parse((o as { body: string }).body) as { attempt: string }).attempt);
    expect(attempts[0]).toBe(attempts[1]);
  });

  it('offers no button for a reset that cannot be used now', () => {
    render(
      <Resets
        resets={{ ...resets, blocked: 'A reset was used recently.', items: [{ ...resets.items[0], usable: false }] }}
        windows={windows}
        brand="claude"
        now={now}
      />,
    );
    expect(screen.getByTestId('usage-reset-use')).toBeDisabled();
    expect(screen.getByText('A reset was used recently.')).toBeInTheDocument();
  });
});
