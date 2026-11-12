import type { CellDetail, GridCell, GridColumn, GridDetail, GridRow, GridSummary } from '@/workbench/grids/types';

/** A grid summary with every field filled, overridden as a test needs. */
export function makeGrid(over: Partial<GridSummary> = {}): GridSummary {
  return {
    projectId: 'p1',
    slug: 'camera',
    title: 'Renderer camera',
    area: 'The renderer camera features',
    status: 'approved',
    template: null,
    rowSearch: { command: 'ls src/camera', watch: ['src/camera'] },
    createdBy: 's1',
    approvedAt: 1,
    updatedAt: 1,
    pending: null,
    discovery: null,
    percent: 25,
    counts: { counted: 8, proved: 2, stale: 1, gap: 1, unchecked: 2, inProgress: 1, naPending: 1, na: 0 },
    ...over,
  };
}

export function makeColumn(id: string, over: Partial<GridColumn> = {}): GridColumn {
  return { id, name: id.toUpperCase(), proofRule: `Proof for ${id}`, position: 0, fromTemplate: false, retired: false, ...over };
}

export function makeRow(id: string, over: Partial<GridRow> = {}): GridRow {
  return { id, name: id[0]!.toUpperCase() + id.slice(1), kind: 'feature', paths: [], of: null, ref: null, source: 'search', missing: false, removed: false, ...over };
}

export function makeCell(row: string, col: string, over: Partial<GridCell> = {}): GridCell {
  return {
    row, col, state: 'unchecked', stale: false, claimedTask: null, reason: null,
    provedBy: null, provedAt: null, auditedAt: null, lastCheck: null, proofSummary: null,
    ...over,
  };
}

/**
 * The camera grid: glare, sunstar, a combination of the two, a reference to
 * the colour grid's tonemap row, and a missing row; columns cpu and gpu, and a
 * retired one.
 */
export function makeDetail(over: Partial<GridDetail> = {}): GridDetail {
  const columns = [makeColumn('cpu', { position: 0 }), makeColumn('gpu', { position: 1 }), makeColumn('old', { position: 2, retired: true })];
  const rows = [
    makeRow('glare'),
    makeRow('both', { kind: 'combination', name: 'Glare with sunstar', of: ['glare', 'sunstar'] }),
    makeRow('sunstar'),
    makeRow('tonemap', { kind: 'reference', name: 'Tone mapping', ref: { grid: 'colour', row: 'tonemap' } }),
    makeRow('fog', { missing: true }),
    makeRow('gone', { removed: true }),
  ];
  const cells = [
    makeCell('glare', 'cpu', { state: 'proved', proofSummary: 'Matches the reference' }),
    makeCell('glare', 'gpu', { state: 'proved', stale: true }),
    makeCell('glare', 'old', { state: 'gap' }),
    makeCell('sunstar', 'cpu', { state: 'gap', reason: 'No test' }),
    makeCell('sunstar', 'gpu', { state: 'in_progress', claimedTask: 7 }),
    makeCell('both', 'cpu', { state: 'na_pending', reason: 'No combined path on CPU' }),
    makeCell('both', 'gpu', { state: 'na', reason: 'Never combined' }),
    makeCell('tonemap', 'cpu', { state: 'proved', ref: true }),
    makeCell('tonemap', 'gpu', { state: 'unchecked', ref: true }),
    makeCell('fog', 'cpu'),
    makeCell('fog', 'gpu'),
  ];
  return { grid: makeGrid(), head: 'abc1234', columns, rows, cells, ...over };
}

/** A proved cell's detail: proof with a check, a benchmark, tests and commits, and its history. */
export function makeCellDetail(over: Partial<CellDetail['cell']> = {}): CellDetail {
  return {
    cell: {
      ...makeCell('glare', 'gpu', { state: 'proved', provedBy: 's1', provedAt: Date.now() - 60_000 }),
      proof: {
        summary: 'Glare kernel matches the reference renderer',
        checks: [{ name: 'glare ground truth', command: 'cargo test glare_matches_reference' }],
        tests: ['renderer::camera::glare::tests::glare_matches_reference'],
        commits: ['abc1234'],
        benchmarks: [{ name: 'glare pass', value: 0.8, budget: 1, unit: 'ms' }],
        evidence: ['shots/glare.png'],
      },
      lastCheck: { at: Date.now() - 30_000, head: 'abc1234', passed: true, results: [{ name: 'glare ground truth', exit: 0, ms: 1200 }] },
      merged: true,
      ...over,
    },
    row: makeRow('glare'),
    column: makeColumn('gpu'),
    events: [
      { seq: 1, at: Date.now() - 120_000, kind: 'claimed', row: 'glare', col: 'gpu', sessionId: 's1', actor: 'agent', payload: { task: 7 } },
      { seq: 2, at: Date.now() - 60_000, kind: 'proved', row: 'glare', col: 'gpu', sessionId: 's1', actor: 'agent', payload: {} },
    ],
  };
}
