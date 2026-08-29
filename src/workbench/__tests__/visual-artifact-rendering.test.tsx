import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VisualArtifactView } from '../visual-artifact-view';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn(async () => ({ svg: '<svg aria-label="Rendered Mermaid"><text>Diagram</text></svg>' })) } }));
vi.mock('elkjs/lib/elk.bundled.js', () => ({ default: class { async layout(graph: unknown) { return graph; } } }));
vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, edges }: { nodes: Array<{ id: string; data: { label: unknown } }>; edges: Array<{ id: string }> }) => <div data-testid="react-flow">{nodes.map((node) => <span key={node.id}>{String(node.id)}</span>)}{edges.map((edge) => <i key={edge.id}>{edge.id}</i>)}</div>,
  Background: () => null, Controls: () => null,
}));

const response = (value: unknown) => vi.fn(async () => ({ ok: true, json: async () => value }));

describe('visual artifact rendering', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('renders Mermaid through the library in strict mode', async () => {
    vi.stubGlobal('fetch', response({ version: 1, kind: 'mermaid', title: 'Diagram', source: 'flowchart LR\nA-->B' }));
    render(<VisualArtifactView asset={`${'a'.repeat(64)}.artifact.json`} />);
    expect(await screen.findByTestId('mermaid-artifact')).toHaveTextContent('Diagram');
  });
  it('renders an automatically laid out interactive flow canvas', async () => {
    vi.stubGlobal('fetch', response({ version: 1, kind: 'flow', title: 'Flow', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ id: 'ab', from: 'a', to: 'b' }] }));
    render(<VisualArtifactView asset={`${'b'.repeat(64)}.artifact.json`} />);
    expect(await screen.findByTestId('react-flow')).toHaveTextContent('ab');
  });
  it('animates arbitrary vector primitives between named states', async () => {
    vi.stubGlobal('fetch', response({ version: 1, kind: 'scene', title: 'Orbit', viewBox: [0, 0, 400, 240], elements: [{ id: 'dot', type: 'circle', cx: 40, cy: 120, r: 12, fill: '#38bdf8' }], states: [{ id: 'start', label: 'Start', changes: [{ element: 'dot', x: 0 }] }, { id: 'finish', label: 'Finish', changes: [{ element: 'dot', x: 300 }] }] }));
    render(<VisualArtifactView asset={`${'c'.repeat(64)}.artifact.json`} />);
    expect(await screen.findByRole('img', { name: 'Orbit: Start' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Orbit: Finish' })).toBeInTheDocument());
  });
});
