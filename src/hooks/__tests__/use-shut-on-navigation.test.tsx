import { act, render, screen } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let query = new URLSearchParams('id=p&tab=chat');
vi.mock('next/navigation', () => ({ useSearchParams: () => query }));

import { useShutOnNavigation } from '@/hooks/use-shut-on-navigation';

function Drawer({ startOpen }: { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  useShutOnNavigation(useCallback(() => setOpen(false), []));
  return <button type="button" data-testid="drawer" data-open={open} onClick={() => setOpen(true)} />;
}

describe('a phone drawer and the address', () => {
  beforeEach(() => {
    query = new URLSearchParams('id=p&tab=chat');
  });

  it('shuts when the address moves on', () => {
    const { rerender } = render(<Drawer startOpen={false} />);
    act(() => screen.getByTestId('drawer').click());
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'true');
    query = new URLSearchParams('id=p&tab=chat&settings=list');
    rerender(<Drawer startOpen={false} />);
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'false');
  });

  it('stays open when the screen redraws at the same address', () => {
    const { rerender } = render(<Drawer startOpen={false} />);
    act(() => screen.getByTestId('drawer').click());
    query = new URLSearchParams('id=p&tab=chat');
    rerender(<Drawer startOpen={false} />);
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'true');
  });

  it('leaves a drawer the screen opened on arrival alone', () => {
    render(<Drawer startOpen />);
    expect(screen.getByTestId('drawer')).toHaveAttribute('data-open', 'true');
  });
});
