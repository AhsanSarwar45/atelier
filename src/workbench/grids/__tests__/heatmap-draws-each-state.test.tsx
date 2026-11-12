/**
 * The heatmap (docs/grids.md, "Grid view"): one colour per state, a stale
 * proof hatched, combinations under their first row, references in italics
 * with their owner, missing rows dimmed; clicking selects.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GridHeatmap, LOOK_CLASS, orderRows } from '@/workbench/grids/grid-heatmap';
import type { Selection } from '@/workbench/grids/selection';
import { makeDetail } from '@/workbench/grids/__tests__/fixtures';

function draw(selection: Selection | null = null) {
  const detail = makeDetail();
  const onSelect = vi.fn();
  const onOpenCell = vi.fn();
  const view = render(
    <GridHeatmap
      rows={orderRows(detail.rows)}
      columns={detail.columns.filter((c) => !c.retired)}
      cells={detail.cells}
      selection={selection}
      onSelect={onSelect}
      onOpenCell={onOpenCell}
    />,
  );
  return { ...view, onSelect, onOpenCell };
}

const cell = (row: string, col: string) =>
  screen.getAllByTestId('grid-cell').find((el) => el.dataset.row === row && el.dataset.col === col)!;

describe('the heatmap', () => {
  it('draws each state in its own colour, and a stale proof hatched', () => {
    draw();
    const looks = { 'glare.cpu': 'proved', 'glare.gpu': 'stale', 'sunstar.cpu': 'gap', 'sunstar.gpu': 'in_progress', 'both.cpu': 'na_pending', 'both.gpu': 'na', 'fog.cpu': 'unchecked' } as const;
    for (const [at, look] of Object.entries(looks)) {
      const [row, col] = at.split('.') as [string, string];
      const drawn = cell(row, col);
      expect(drawn.dataset.look).toBe(look);
      for (const part of LOOK_CLASS[look].split(' ')) expect(drawn.className).toContain(part);
    }
    expect(new Set(Object.values(LOOK_CLASS)).size).toBe(Object.keys(LOOK_CLASS).length);
    expect(cell('glare', 'gpu').style.backgroundImage).toContain('repeating-linear-gradient');
    expect(cell('glare', 'cpu').style.backgroundImage).toBe('');
    expect(cell('both', 'gpu').textContent).toBe('–');
  });

  it('puts a combination under its first row, leaves removed rows out and dims missing ones', () => {
    draw();
    expect(screen.getAllByTestId('grid-row').map((row) => row.dataset.row)).toEqual(['glare', 'both', 'sunstar', 'tonemap', 'fog']);
    const names = screen.getAllByTestId('grid-row-name');
    expect(names[1]!.style.paddingLeft).not.toBe(names[0]!.style.paddingLeft);
    const fog = screen.getAllByTestId('grid-row').find((row) => row.dataset.row === 'fog')!;
    expect(fog.className).toContain('opacity-40');
  });

  it('draws a reference row in italics with the grid that owns it', () => {
    draw();
    const name = screen.getAllByTestId('grid-row-name')[3]!;
    expect(name.querySelector('.italic')?.textContent).toBe('Tone mapping');
    expect(name.textContent).toContain('colour');
    expect(cell('tonemap', 'cpu').dataset.ref).toBe('yes');
  });

  it('selects a column, a row, a cell, and a block with shift', () => {
    const { onSelect, onOpenCell } = draw();
    fireEvent.click(screen.getAllByTestId('grid-column')[1]!);
    expect(onSelect).toHaveBeenLastCalledWith({ rows: '*', cols: ['gpu'] });
    fireEvent.click(screen.getAllByTestId('grid-row-name')[0]!);
    expect(onSelect).toHaveBeenLastCalledWith({ rows: ['glare'], cols: '*' });
    fireEvent.click(cell('glare', 'cpu'));
    expect(onSelect).toHaveBeenLastCalledWith({ rows: ['glare'], cols: ['cpu'] });
    expect(onOpenCell).toHaveBeenCalledTimes(1);
    fireEvent.click(cell('sunstar', 'cpu'), { shiftKey: true });
    expect(onSelect).toHaveBeenLastCalledWith({ rows: ['glare', 'both', 'sunstar'], cols: ['cpu'] });
    expect(onOpenCell).toHaveBeenCalledTimes(1);
  });

  it('marks the selected cells', () => {
    draw({ rows: '*', cols: ['gpu'] });
    expect(cell('glare', 'gpu').getAttribute('aria-pressed')).toBe('true');
    expect(cell('glare', 'cpu').getAttribute('aria-pressed')).toBe('false');
  });

  it('scrolls sideways under row names that stay put', () => {
    draw();
    expect(screen.getByTestId('grid-heatmap').className).toContain('overflow-auto');
    expect(screen.getAllByTestId('grid-row-name')[0]!.closest('th')!.className).toContain('sticky');
  });
});
