/**
 * The one control opens and shuts every row, whatever the reader has touched.
 *
 * A row opened or shut by hand used to pin itself for good, so Ctrl+O stopped
 * reaching it in either direction and the button reading "show less" did not
 * show less (bw-1u1.24).
 */
import { useState } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useOpen } from '@/workbench/transcript-rows';

/** One row and the control above it, which is the whole of the disagreement. */
function Rows() {
  const [openAll, setOpenAll] = useState(false);
  const [open, setOpen] = useOpen(openAll);
  return (
    <div>
      <button type="button" data-testid="control" onClick={() => setOpenAll(!openAll)}>
        {openAll ? 'show less' : 'show everything'}
      </button>
      <button type="button" data-testid="row" data-open={open} onClick={() => setOpen(!open)}>
        one row
      </button>
    </div>
  );
}

const row = () => screen.getByTestId('row');
const control = () => screen.getByTestId('control');

describe('opening one row and opening everything', () => {
  it('starts shut, and opens on the reader’s own click', () => {
    render(<Rows />);
    expect(row()).toHaveAttribute('data-open', 'false');

    fireEvent.click(row());
    expect(row()).toHaveAttribute('data-open', 'true');
  });

  it('shuts a hand-opened row when the control is put back', () => {
    render(<Rows />);
    fireEvent.click(row());
    fireEvent.click(control());
    expect(row()).toHaveAttribute('data-open', 'true');

    fireEvent.click(control());
    expect(row()).toHaveAttribute('data-open', 'false');
  });

  it('opens a hand-shut row when the control asks for everything', () => {
    render(<Rows />);
    fireEvent.click(control());
    fireEvent.click(row());
    expect(row()).toHaveAttribute('data-open', 'false');

    fireEvent.click(control());
    fireEvent.click(control());
    expect(row()).toHaveAttribute('data-open', 'true');
  });

  it('leaves the hand choice alone while the control stands still', () => {
    render(<Rows />);
    fireEvent.click(row());
    fireEvent.click(row());
    expect(row()).toHaveAttribute('data-open', 'false');
  });
});
