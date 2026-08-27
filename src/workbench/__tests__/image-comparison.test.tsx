import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PictureViewer } from '@/workbench/picture-viewer';
import type { ImageComparison, ImagePayload } from '@/workbench/protocol';

const image = (alt: string): ImagePayload => ({ mime: 'image/png', dataUrl: `data:image/png;base64,${alt}`, alt });
const comparison = (mode: ImageComparison['mode']): ImageComparison => ({ mode, before: image('Before'), after: image('After') });

describe('zooming image comparisons', () => {
  it('keeps side-by-side images on one synchronized zoom and pan transform', () => {
    render(<PictureViewer image={comparison('side_by_side')} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));

    const leftViewport = screen.getByTestId('comparison-zoom-viewport-0');
    Object.assign(leftViewport, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
    fireEvent.pointerDown(leftViewport, { pointerId: 2, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(leftViewport, { pointerId: 2, clientX: 240, clientY: 120 });

    const left = screen.getByTestId('comparison-transform-0');
    const right = screen.getByTestId('comparison-transform-1');
    expect(left).toHaveAttribute('data-scale', '1.5');
    expect(right).toHaveAttribute('data-scale', '1.5');
    expect(left).toHaveAttribute('data-pan-x', '40');
    expect(right).toHaveAttribute('data-pan-x', '40');
    expect(left).toHaveAttribute('data-pan-y', '-30');
    expect(right).toHaveAttribute('data-pan-y', '-30');
  });

  it('keeps both layers of a wipe comparison aligned while its split remains adjustable', () => {
    render(<PictureViewer image={comparison('wipe')} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByTestId('comparison-transform-before')).toHaveAttribute('data-scale', '1.5');
    expect(screen.getByTestId('comparison-transform-after')).toHaveAttribute('data-scale', '1.5');

    fireEvent.change(screen.getByRole('slider', { name: 'Before and after split' }), { target: { value: '70' } });
    expect(screen.getByRole('slider', { name: 'Before and after split' })).toHaveValue('70');
  });
});
