/**
 * The donut's breakdown is a hover label like every other hover label in the
 * app. It used to be a panel this component positioned under itself, in a box
 * of its own making — one of the three different answers the app gave to the
 * same gesture (bw-6wq6.1). What is checked here is that it is the app's one
 * label now: it opens on hover, through the shared component, with the counts
 * it always carried.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusDonut } from '@/components/status-donut';
import { NO_COUNTS } from '@/types';

const COUNTS = { ...NO_COUNTS(), open: 3, in_progress: 1, closed: 2 };

describe('the status donut', () => {
  it('says nothing until it is hovered, then gives the breakdown', async () => {
    render(<StatusDonut beadCounts={COUNTS} size={36} />);

    expect(screen.queryByRole('tooltip')).toBeNull();

    // What Radix listens for. The wait that follows covers the hover delay,
    // which is the app's own and is deliberately not shortened here.
    fireEvent.pointerMove(screen.getByTestId('status-donut'), { pointerType: 'mouse' });

    await waitFor(
      () => {
        const label = screen.getByRole('tooltip');
        expect(label.textContent).toContain('6 tasks');
        expect(label.textContent).toContain('3');
      },
      { timeout: 2000 },
    );
  });

  it('draws no donut and no label while there is nothing to count', () => {
    render(<StatusDonut beadCounts={NO_COUNTS()} size={36} />);

    expect(screen.queryByTestId('status-donut')).toBeNull();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
