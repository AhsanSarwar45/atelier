import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PictureViewer } from '@/workbench/picture-viewer';
import type { ImagePayload } from '@/workbench/protocol';

const image: ImagePayload = { mime: 'image/png', dataUrl: 'data:image/png;base64,picture', alt: 'A detailed picture' };

describe('zooming and panning a chat image', () => {
  it('zooms with controls, pans by dragging, and resets both', () => {
    render(<PictureViewer image={image} onClose={vi.fn()} />);
    const viewport = screen.getByTestId('picture-zoom-viewport');
    Object.assign(viewport, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-scale', '1.5');
    expect(screen.getByTestId('picture-zoom-level')).toHaveTextContent('150%');

    fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 145, clientY: 125 });
    fireEvent.pointerUp(viewport, { pointerId: 1 });
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-pan-x', '45');
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-pan-y', '25');

    fireEvent.click(screen.getByRole('button', { name: 'Reset zoom and position' }));
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-scale', '1');
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-pan-x', '0');
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-pan-y', '0');
  });

  it('zooms with the wheel and double click', () => {
    render(<PictureViewer image={image} onClose={vi.fn()} />);
    const viewport = screen.getByTestId('picture-zoom-viewport');
    fireEvent.wheel(viewport, { deltaY: -10 });
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-scale', '1.5');
    fireEvent.doubleClick(viewport);
    expect(screen.getByTestId('picture-transform')).toHaveAttribute('data-scale', '1');
  });
});
