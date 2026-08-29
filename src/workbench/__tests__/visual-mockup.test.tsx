import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VisualArtifactView } from '../visual-artifact-view';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));
vi.mock('elkjs/lib/elk.bundled.js', () => ({ default: class {} }));
vi.mock('@xyflow/react', () => ({ ReactFlow: () => null, Background: () => null, Controls: () => null }));

const artifact = { version: 1, kind: 'mockup', title: 'Checkout prototype', initialScreen: 'cart', viewport: { width: 1200, height: 760 }, screens: [
  { id: 'cart', title: 'Your cart', components: [{ id: 'layout', type: 'stack', children: [{ id: 'title', type: 'heading', text: 'Ready to order?' }, { id: 'email', type: 'input', label: 'Email', placeholder: 'you@example.com' }, { id: 'pay', type: 'button', text: 'Pay now', action: { type: 'navigate', screen: 'done' } }] }] },
  { id: 'done', title: 'Receipt', components: [{ id: 'success', type: 'heading', text: 'Payment complete' }, { id: 'again', type: 'button', text: 'Back', tone: 'neutral', action: { type: 'navigate', screen: 'cart' } }] },
] };

describe('interactive visual mockups', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => artifact }))));
  it('accepts input and navigates between screens', async () => {
    render(<VisualArtifactView asset={`${'d'.repeat(64)}.artifact.json`} />);
    const input = await screen.findByRole('textbox', { name: 'Email' });
    fireEvent.change(input, { target: { value: 'person@example.com' } });
    expect(input).toHaveValue('person@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Pay now' }));
    expect(screen.getByRole('heading', { name: 'Payment complete' })).toBeInTheDocument();
  });
  it('opens the same working mockup full-screen and closes with the keyboard-safe dialog control', async () => {
    render(<VisualArtifactView asset={`${'e'.repeat(64)}.artifact.json`} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open artifact full screen' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getAllByTestId('mockup-artifact')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Close full-screen artifact' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
