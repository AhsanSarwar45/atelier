/**
 * The switch that lets a chat stopped by a usage limit resume on its own.
 * It shows what the server holds and saves a flip straight back to it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LimitSettings } from '@/workbench/limit-settings';

const limitSettings = vi.fn();
const saveLimitSettings = vi.fn();
vi.mock('@/lib/api', async (real) => ({
  ...(await real<typeof import('@/lib/api')>()),
  limitSettings: () => limitSettings(),
  saveLimitSettings: (settings: unknown) => saveLimitSettings(settings),
}));

afterEach(() => {
  limitSettings.mockReset();
  saveLimitSettings.mockReset();
});

describe('resuming after a usage limit', () => {
  it('is off until turned on, and turning it on saves it', async () => {
    limitSettings.mockResolvedValue({ autoResume: false });
    saveLimitSettings.mockResolvedValue({ autoResume: true });
    render(<LimitSettings />);
    const toggle = await screen.findByTestId('limit-auto-resume');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(saveLimitSettings).toHaveBeenCalledWith({ autoResume: true });
  });

  it('keeps showing what the server holds when saving fails', async () => {
    limitSettings.mockResolvedValue({ autoResume: false });
    saveLimitSettings.mockRejectedValue(new Error('The usage limit settings could not be saved'));
    render(<LimitSettings />);
    const toggle = await screen.findByTestId('limit-auto-resume');
    fireEvent.click(toggle);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved');
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});
