/**
 * A selection of a grid's cells is written as an `@grid:` id and read back
 * (docs/grids.md, "Selection reference"), and New task writes it after `@task`.
 */
import { describe, expect, it } from 'vitest';

import { findAtelierReferences } from '@/workbench/references';
import { blocker, gridId, newTaskLine, parseGridId, rectangle, selectedCells, type Selection } from '@/workbench/grids/selection';
import { makeDetail } from '@/workbench/grids/__tests__/fixtures';

describe('a selection as an @grid: id', () => {
  const cases: Array<[Selection | null, string]> = [
    [null, 'camera'],
    [{ rows: '*', cols: ['gpu'] }, 'camera.*.gpu'],
    [{ rows: ['glare'], cols: '*' }, 'camera.glare.*'],
    [{ rows: ['glare', 'sunstar'], cols: ['gpu', 'perf'] }, 'camera.glare+sunstar.gpu+perf'],
    [{ rows: '*', cols: '*' }, 'camera.*.*'],
  ];

  it.each(cases)('writes %j as %s and reads it back', (selection, id) => {
    expect(gridId('camera', selection)).toBe(id);
    expect(parseGridId(id)).toEqual({ slug: 'camera', selection });
  });

  it('reads nothing that is not one', () => {
    for (const id of ['', 'Camera', 'camera.glare', 'camera.glare.gpu.x', 'camera..gpu', 'camera.glare+.gpu', 'camera.*+glare.gpu']) {
      expect(parseGridId(id)).toBeNull();
    }
  });

  it('is what New task writes, and the composer reads it as one reference', () => {
    const line = newTaskLine('camera', { rows: ['glare', 'sunstar'], cols: '*' });
    expect(line).toBe('@task @grid:camera.glare+sunstar.* ');
    expect(findAtelierReferences(line).map((ref) => [ref.kind, ref.id])).toEqual([['task', ''], ['grid', 'camera.glare+sunstar.*']]);
  });

  it('turns a dragged block into rows by columns, and a side that spans everything into *', () => {
    const rows = ['glare', 'both', 'sunstar'];
    const cols = ['cpu', 'gpu'];
    expect(rectangle({ row: 'sunstar', col: 'gpu' }, { row: 'both', col: 'gpu' }, rows, cols)).toEqual({ rows: ['both', 'sunstar'], cols: ['gpu'] });
    expect(rectangle({ row: 'glare', col: 'cpu' }, { row: 'both', col: 'gpu' }, rows, cols)).toEqual({ rows: ['glare', 'both'], cols: '*' });
  });
});

describe('which selected cells can be claimed', () => {
  it('says why each other cell cannot', () => {
    const detail = makeDetail();
    const live = detail.rows.filter((row) => !row.removed);
    const columns = detail.columns.filter((column) => !column.retired);
    const cells = selectedCells({ rows: '*', cols: '*' }, live, columns, detail.cells);
    const why = Object.fromEntries(cells.map((c) => [`${c.row.id}.${c.column.id}`, c.blocker]));
    expect(why).toEqual({
      'glare.cpu': 'Proved',
      // A stale proof can be proved again.
      'glare.gpu': null,
      'both.cpu': 'N/A pending',
      'both.gpu': 'N/A',
      'sunstar.cpu': null,
      'sunstar.gpu': 'Claimed by #7',
      'tonemap.cpu': 'Read-only: owned by the colour grid',
      'tonemap.gpu': 'Read-only: owned by the colour grid',
      'fog.cpu': 'Row missing',
      'fog.gpu': 'Row missing',
    });
  });

  it('leaves a retired column out of reach', () => {
    const detail = makeDetail();
    const glare = detail.rows[0]!;
    expect(blocker(detail.cells.find((c) => c.col === 'old'), glare, detail.columns[2])).toBe('Column retired');
  });
});
